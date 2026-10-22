import { ADMIN_API_ENABLED, LIMITS, TOPPINGS } from "./config.js";
import { api } from "./api.js";
import * as auth from "./auth.js";
import { compressProof, fileSize, ImageError } from "./images.js";
import { STATUS, badge, chatURL, dateTime, escapeHTML as html, initials, money, normalizeWA, number, paymentLabel } from "./utils.js";

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const canDelete = (order) => ["PENDING", "NEEDS_REVIEW", "CANCELLED"].includes(order?.status);
// A backend that implements the extended contract always sends note and payment_proofs in detail.
const extended = (order) => !!order && "note" in order && Array.isArray(order.payment_proofs);
const canEditItems = (order) => extended(order) && order.status !== "COMPLETED";
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
let user = null;
let epoch = 0;
let listVersion = 0;
let detailVersion = 0;
let page = 1;
let total = 0;
let detail = null;
let loading = false;
let confirming = false;
let pendingMutation = null;
let detailID = null;
let draft = null;
let searchTimer;
let catalog = null;
let catalogTask = null;
let proofURLs = new Map();
let itemsEditorOpen = false;
let creating = false;
let createKey = null;
let replaceTarget = null;

function toast(message, error = false) {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Tutup notifikasi");
  close.textContent = "×";
  close.addEventListener("click", () => item.remove());
  item.append(close, document.createTextNode(message));
  $("toasts").append(item);
  // Keep repeated feedback from covering most of a small screen.
  while ($("toasts").children.length > 2) $("toasts").firstElementChild.remove();
  setTimeout(() => item.remove(), 10000);
}
function showError(id, message) { $(id).textContent = message; $(id).hidden = !message; }
function filters() { return { search: $("search").value.trim(), status: $("status-filter").value }; }
function setLoading(value) {
  loading = value;
  $("table-region").setAttribute("aria-busy", value);
  $("refresh").disabled = value;
  $("refresh").innerHTML = `${icon("refresh")}${value ? "Memuat…" : "Muat ulang"}`;
  updatePagination();
}
function clearStats() {
  ["stat-orders", "stat-value", "stat-confirmed", "stat-pending", "nav-count", "result-count"].forEach((id) => { $(id).textContent = "—"; });
}
function clearSummary(value = "—") {
  ["stat-orders", "stat-value", "stat-confirmed", "stat-pending", "nav-count"].forEach((id) => { $(id).textContent = value; });
}
function updatePagination() {
  const size = Number($("page-size").value);
  const pages = Math.max(1, Math.ceil(total / size));
  $("page-number").textContent = `${page} / ${pages}`;
  $("page-prev").disabled = loading || page <= 1;
  $("page-next").disabled = loading || page >= pages;
}
function renderRows(orders) {
  $("order-rows").innerHTML = orders.map((order) => `<tr>
    <td><span class="order-id">${html(order.order_id)}</span></td>
    <td><span class="customer-name">${html(order.customer_name)}</span></td>
    <td class="align-right money-cell">${html(money(order.total))}</td>
    <td><span class="method">${html(paymentLabel(order.payment_method))}</span></td>
    <td>${badge(order.status)}${order.proof_count ? `<span class="proof-pill" title="Bukti pembayaran">${icon("image")}${number(order.proof_count)}<span class="sr-only"> foto bukti</span></span>` : ""}</td><td class="date-cell">${html(dateTime(order.created_at))}</td>
    <td class="align-right"><button type="button" class="detail-button" data-order="${html(order.order_id)}" aria-label="Lihat detail ${html(order.order_id)}">Detail ${icon("arrow")}</button></td>
  </tr>`).join("");
}
function tableState(title, message, retry = false) {
  $("order-rows").replaceChildren();
  $("table-state").hidden = false;
  $("table-state").innerHTML = `<span class="state-mark">${icon(retry ? "info" : "bag")}</span><strong>${html(title)}</strong><p>${html(message)}</p>${retry ? '<button type="button" class="button secondary" id="retry-load">Coba kembali</button>' : ""}`;
  if (retry) $("retry-load").addEventListener("click", load);
}
function handleAuthError(error) {
  if ([401, 403].includes(error.status)) {
    leaveWorkspace();
    showError("login-error", error.message);
    return true;
  }
  return false;
}
async function load() {
  if (!user) return;
  const version = ++listVersion;
  const session = epoch;
  const requestedPage = page;
  const size = Number($("page-size").value);
  const query = filters();
  setLoading(true);
  clearStats();
  showError("summary-error", "");
  $("stats").setAttribute("aria-busy", true);
  // Render each resource as soon as it settles. Summary errors cannot erase rows.
  const summaryTask = (async () => {
    try {
      const summary = await api.summary();
      if (version !== listVersion || session !== epoch) return;
      $("stat-orders").textContent = number(summary.total_orders);
      $("stat-value").textContent = money(summary.total_transaction_value);
      $("stat-confirmed").textContent = number(summary.confirmed_payments);
      $("stat-pending").textContent = number(summary.pending_payments);
      $("nav-count").textContent = number(summary.total_orders);
    } catch (error) {
      if (version !== listVersion || session !== epoch || handleAuthError(error)) return;
      clearSummary("Tidak tersedia");
      showError("summary-error", "Statistik tidak tersedia. " + error.message);
    } finally {
      if (version === listVersion && session === epoch) $("stats").setAttribute("aria-busy", false);
    }
  })();
  $("table-state").hidden = true;
  $("page-info").textContent = "Memuat transaksi…";
  $("last-updated").textContent = "Memperbarui…";
  $("reset-filters").hidden = !query.search && !query.status;
  $("order-rows").innerHTML = Array.from({ length: 5 }, () => `<tr aria-hidden="true">${Array.from({ length: 7 }, () => '<td><span class="skeleton"></span></td>').join("")}</tr>`).join("");
  try {
    const result = await api.list({ ...query, page: requestedPage, page_size: size });
    if (version !== listVersion || session !== epoch) return;
    total = result.total;
    if (page > 1 && (page - 1) * size >= total) { page = Math.max(1, Math.ceil(total / size)); return load(); }
    $("result-count").textContent = number(total);
    renderRows(result.items);
    if (!result.items.length) tableState(query.search || query.status ? "Tidak ada pesanan yang cocok" : "Belum ada transaksi", query.search || query.status ? "Coba ID pesanan lain atau hapus filter untuk melihat seluruh pesanan." : "Pesanan akan tampil di sini setelah tersedia dari sumber data.");
    $("page-info").textContent = total ? `Menampilkan ${number((page - 1) * size + 1)}–${number(Math.min(page * size, total))} dari ${number(total)} transaksi` : "0 transaksi";
    $("last-updated").textContent = `Diperbarui ${new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).format(new Date())} WIB`;
  } catch (error) {
    if (version !== listVersion || session !== epoch) return;
    if (handleAuthError(error)) return;
    total = 0;
    $("result-count").textContent = "—";
    tableState("Data belum dapat dimuat", error.message, true);
    $("page-info").textContent = "Gagal memuat transaksi";
    $("last-updated").textContent = "Pembaruan gagal";
  } finally { if (version === listVersion && session === epoch) setLoading(false); }
  await summaryTask;
}

function showDialog(id) { if (!$(id).open) $(id).showModal(); }
function contactDraft() {
  if (!detail) return draft;
  const input = $("wa-number");
  if (input && detailID && input.value !== (detail?.wa_number ?? "")) return { id: detailID, value: input.value };
  return draft;
}
function listText(parts) { return parts.length < 3 ? parts.join(" dan ") : parts.slice(0, -1).join(", ") + ", dan " + parts.at(-1); }
function notifyEditorReset(appliedKind = null) {
  if (!detail) return;
  const discarded = [];
  if (appliedKind !== "status" && $("target-status")?.value !== (detail.status === "NEEDS_REVIEW" ? "" : detail.status)) discarded.push("status");
  if (appliedKind !== "payment" && $("payment-method")?.value !== (detail.payment_method ?? "")) discarded.push("metode pembayaran");
  if (appliedKind !== "customer" && $("customer-name") && $("customer-name").value !== detail.customer_name) discarded.push("nama pelanggan");
  if (!["note", "note-clear"].includes(appliedKind) && $("note-input") && $("note-input").value !== (detail.note ?? "")) discarded.push("catatan");
  if (appliedKind !== "items" && itemsEditorOpen) discarded.push("item pesanan");
  itemsEditorOpen = false;
  if (discarded.length) toast("Draft " + listText(discarded) + " yang belum disimpan dibuang saat detail dimuat ulang atau ditutup.", true);
}
function clearProofURLs() {
  if ($("proof-dialog").open) $("proof-dialog").close();
  $("proof-view").removeAttribute("src");
  $("proof-download").removeAttribute("href");
  proofURLs.forEach((url) => URL.revokeObjectURL(url));
  proofURLs = new Map();
}
function lockDetail(value) {
  $("detail-content").querySelectorAll("input, select, button, textarea").forEach((el) => { el.disabled = value; });
  document.querySelectorAll("#detail-dialog [data-close]").forEach((el) => { el.disabled = confirming; });
}
function proofSection(order) {
  if (!extended(order)) {
    return '<section class="detail-editor"><h3>Edit data dan bukti pembayaran</h3><p class="detail-hint">Backend belum mengirim catatan dan bukti pembayaran untuk pesanan ini, sehingga edit nama, item, catatan, dan unggah foto belum aktif. Lihat docs/API-CONTRACT.md bagian Kontrak tambahan.</p></section>';
  }
  const proofs = order.payment_proofs;
  return '<section class="detail-editor" id="proof-section"><h3>Bukti pembayaran <span class="count-pill">' + number(proofs.length) + ' / ' + number(LIMITS.proofsPerOrder) + '</span></h3>' +
    '<p class="detail-hint">Foto dikompres di perangkat ini sebelum diunggah (JPEG, metadata lokasi dibuang). Mengunggah bukti tidak mengubah status; tetap tetapkan Sudah dibayar secara manual.</p>' +
    (proofs.length ? '<ul class="proof-grid">' + proofs.map((proof, index) => '<li class="proof-card">' +
      '<button type="button" class="proof-thumb" data-view="' + html(proof.proof_id) + '" aria-label="Lihat bukti ' + (index + 1) + '"><span class="spinner" aria-hidden="true"></span></button>' +
      '<span class="proof-meta">Bukti ' + (index + 1) + ' · ' + html(fileSize(proof.size)) + '<br>' + html(dateTime(proof.created_at)) + '</span>' +
      '<span class="proof-actions"><button type="button" class="button secondary small" data-replace="' + html(proof.proof_id) + '">Ganti</button>' +
      '<button type="button" class="button secondary small" data-remove-proof="' + html(proof.proof_id) + '">Hapus</button></span></li>').join("") + '</ul>'
      : '<p class="fine-print">Belum ada foto bukti pembayaran.</p>') +
    '<input type="file" id="proof-input" accept="image/jpeg,image/png,image/webp" multiple hidden>' +
    '<input type="file" id="proof-replace-input" accept="image/jpeg,image/png,image/webp" hidden>' +
    '<p id="proof-error" class="form-error" role="alert" hidden></p><p id="proof-progress" class="fine-print" role="status"></p>' +
    '<div class="editor-actions"><button type="button" class="button primary" id="proof-add"' + (proofs.length >= LIMITS.proofsPerOrder ? " disabled" : "") + '>Tambah foto</button></div></section>';
}
function dataSections(order) {
  if (!extended(order)) return "";
  return '<section class="detail-editor"><h3>Nama pelanggan</h3><label for="customer-name">Nama pelanggan</label>' +
    '<input id="customer-name" type="text" maxlength="' + LIMITS.customerName + '" autocomplete="off">' +
    '<p id="customer-error" class="form-error" role="alert" hidden></p><button type="button" class="button primary" id="customer-save">Simpan nama</button></section>' +
    '<section class="detail-editor"><h3>Item pesanan</h3>' +
    (canEditItems(order)
      ? '<p class="detail-hint">Harga, diskon Paket Bestie, dan total dihitung ulang oleh server dari katalog saat disimpan.</p><div id="items-editor"></div><div class="editor-actions" id="items-actions"><button type="button" class="button secondary" id="items-edit">Ubah item</button></div>'
      : '<p class="detail-hint">Item pesanan yang sudah dibayar dikunci. Ubah status ke Menunggu terlebih dahulu bila perlu koreksi.</p>') +
    '</section>' +
    '<section class="detail-editor"><h3>Catatan admin</h3><label for="note-input">Catatan internal (tidak terlihat pembeli)</label>' +
    '<textarea id="note-input" rows="3" maxlength="' + LIMITS.note + '" aria-describedby="note-count"></textarea><p id="note-count" class="fine-print"></p>' +
    '<p id="note-error" class="form-error" role="alert" hidden></p><div class="editor-actions"><button type="button" class="button primary" id="note-save">Simpan catatan</button>' +
    '<button type="button" class="button secondary" id="note-clear"' + (order.note === null ? " disabled" : "") + '>Kosongkan catatan</button></div></section>';
}
function noteCount() { if ($("note-count")) $("note-count").textContent = number($("note-input").value.length) + " / " + number(LIMITS.note) + " karakter"; }
function renderDetail(order, savedDraft = null) {
  clearProofURLs();
  itemsEditorOpen = false;
  $("detail-title").textContent = order.order_id;
  const chat = chatURL(order.wa_number);
  $("detail-content").innerHTML = '<div class="detail-total"><div><span>Total pembayaran</span><strong>' + html(money(order.total)) + '</strong></div>' + badge(order.status) + '</div>' +
    '<dl class="detail-meta"><div><dt>Pelanggan</dt><dd>' + html(order.customer_name) + '</dd></div><div><dt>Metode pembayaran</dt><dd id="saved-payment-method">' + html(paymentLabel(order.payment_method)) + '</dd></div><div><dt>Tanggal pesanan · WIB</dt><dd>' + html(dateTime(order.created_at)) + '</dd></div><div><dt>Status backend</dt><dd>' + html(order.status) + '</dd></div></dl>' +
    '<h3>Rincian pesanan</h3><ul class="detail-items">' + order.items.map((item) => '<li><div><strong>' + html(item.product_name) + '</strong><span>' + html(item.topping) + ' · ' + number(item.qty) + ' × ' + html(money(item.unit_price)) + '</span></div><strong>' + html(money(item.subtotal)) + '</strong></li>').join("") + '</ul>' +
    '<div class="detail-totals"><div><span>Subtotal</span><span>' + html(money(order.subtotal)) + '</span></div><div><span>Diskon</span><span>− ' + html(money(order.discount)) + '</span></div><div><span>Total pembayaran</span><span>' + html(money(order.total)) + '</span></div></div>' +
    proofSection(order) +
    '<section class="detail-editor"><h3>Metode pembayaran</h3><p id="payment-note" class="detail-hint">Memilih QRIS atau Tunai tidak menandakan dana sudah diterima. Status Sudah dibayar tetap keputusan manual admin. Setiap editor disimpan terpisah.</p><label for="payment-method">Metode pembayaran</label><select id="payment-method" aria-describedby="payment-note">' +
    [null, "QRIS", "CASH"].map((method) => '<option value="' + (method ?? "") + '"' + (method === order.payment_method ? " selected" : "") + '>' + paymentLabel(method) + '</option>').join("") +
    '</select><button type="button" class="button primary" id="payment-save">Simpan metode pembayaran</button></section>' +
    '<section class="detail-editor"><h3>Status pesanan</h3><p class="detail-hint">Sudah dibayar berarti dana telah diperiksa admin. Status dapat dikoreksi tanpa syarat metode pembayaran.</p><label for="target-status">Status tujuan</label><select id="target-status">' +
    (order.status === "NEEDS_REVIEW" ? '<option value="" selected disabled>Pilih status untuk koreksi</option>' : "") +
    ["PENDING", "COMPLETED", "CANCELLED"].map((status) => '<option value="' + status + '"' + (status === order.status ? " selected" : "") + '>' + STATUS[status].label + '</option>').join("") +
    '</select><button type="button" class="button primary" id="status-save">Simpan status</button></section>' +
    dataSections(order) +
    '<section class="detail-editor"><h3>Kontak WhatsApp</h3><p class="detail-hint">Nomor tersimpan: <span id="saved-wa"></span>. Format Indonesia 08…, +62…, atau 628…; maksimal 32 karakter. Format valid tidak menjamin akun aktif atau kepemilikan nomor.</p>' +
    '<label for="wa-number">Nomor WA pembeli</label><input id="wa-number" type="text" inputmode="tel" autocomplete="off" maxlength="32" aria-describedby="contact-note" placeholder="081234567890">' +
    '<p id="contact-note" class="fine-print"></p><p id="contact-error" class="form-error" role="alert" hidden></p><div class="editor-actions"><button type="button" class="button primary" id="contact-save">Simpan nomor</button><button type="button" class="button secondary" id="contact-clear">Kosongkan nomor</button>' +
    (chat ? '<a id="wa-chat" class="button secondary" href="' + chat + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Buka chat WA</a>' : "") +
    '</div></section>' +
    (canDelete(order) ? '<section class="detail-editor"><h3>Hapus pesanan</h3><p class="detail-hint">Hapus pesanan uji atau spam beserta rincian item secara permanen.</p><button type="button" class="button danger" id="order-delete">Hapus pesanan</button></section>' : '') +
    '<p id="detail-error" class="form-error" role="alert" hidden></p><button type="button" id="retry-detail" class="button secondary">Muat ulang detail</button>';
  $("saved-wa").textContent = order.wa_number ?? "Belum ada";
  $("wa-number").value = savedDraft?.id === order.order_id ? savedDraft.value : order.wa_number ?? "";
  draft = null;
  if (savedDraft?.id === order.order_id) {
    $("contact-note").textContent = "Input nomor yang belum disimpan dipertahankan. Periksa nomor tersimpan terbaru sebelum menyimpan kembali.";
  } else {
    $("contact-note").textContent = "Simpan nomor dan status adalah tindakan terpisah. Kosongkan nomor melalui tombol konfirmasi.";
  }
  $("contact-clear").disabled = order.wa_number === null;
  $("status-save").addEventListener("click", () => openConfirmation("status"));
  $("payment-save").addEventListener("click", () => openConfirmation("payment"));
  $("contact-save").addEventListener("click", () => openConfirmation("contact"));
  $("contact-clear").addEventListener("click", () => openConfirmation("clear"));
  $("order-delete")?.addEventListener("click", openDeleteConfirmation);
  $("retry-detail").addEventListener("click", () => openDetail(order.order_id));
  if (!extended(order)) return;
  $("customer-name").value = order.customer_name;
  $("note-input").value = order.note ?? "";
  noteCount();
  $("note-input").addEventListener("input", noteCount);
  $("customer-save").addEventListener("click", () => openConfirmation("customer"));
  $("note-save").addEventListener("click", () => openConfirmation("note"));
  $("note-clear").addEventListener("click", () => openConfirmation("note-clear"));
  $("items-edit")?.addEventListener("click", () => openItemsEditor(order));
  $("proof-add").addEventListener("click", () => { showError("proof-error", ""); $("proof-input").click(); });
  $("proof-input").addEventListener("change", () => { const files = [...$("proof-input").files]; $("proof-input").value = ""; uploadProofs(files); });
  $("proof-replace-input").addEventListener("change", () => { const file = $("proof-replace-input").files[0]; $("proof-replace-input").value = ""; prepareReplace(file); });
  const version = detailVersion;
  order.payment_proofs.forEach((proof) => loadProof(order.order_id, proof.proof_id, version));
}
async function openDetail(id, { preserveDraft = true, appliedKind = null, deletedOnMissing = false } = {}) {
  if (confirming || !user) return;
  const savedDraft = preserveDraft && detailID === id ? contactDraft() : null;
  notifyEditorReset(appliedKind);
  clearProofURLs();
  const version = ++detailVersion;
  const session = epoch;
  detail = null;
  detailID = id;
  draft = savedDraft;
  $("detail-title").textContent = id;
  $("detail-content").innerHTML = '<div class="details-loading" role="status"><span class="spinner" aria-hidden="true"></span><p>Memuat detail pesanan…</p></div>';
  showDialog("detail-dialog");
  try {
    const result = await api.detail(id);
    if (version !== detailVersion || session !== epoch || !$("detail-dialog").open) return;
    detail = result;
    renderDetail(result, savedDraft);
  } catch (error) {
    if (version !== detailVersion || session !== epoch || !$("detail-dialog").open) return;
    if (handleAuthError(error)) return;
    if (deletedOnMissing && error.status === 404) {
      await finishDeletion("Pesanan sudah tidak ada. Daftar diperbarui.");
      return;
    }
    $("detail-content").innerHTML = '<p class="detail-error" role="alert">' + html(error.message) + '</p>' +
      (savedDraft ? '<p class="fine-print">Input nomor belum disimpan tetap dipertahankan untuk pemuatan berikutnya.</p>' : "") +
      '<button type="button" id="retry-detail" class="button secondary">Muat ulang detail</button>';
    $("retry-detail").addEventListener("click", () => openDetail(id, { deletedOnMissing }));
  }
}

/* ===== Payment proofs ===== */
async function loadProof(orderID, proofID, version) {
  const session = epoch;
  const thumb = () => $("detail-content").querySelector(`[data-view="${CSS.escape(proofID)}"]`);
  try {
    const blob = await api.proofImage(orderID, proofID);
    if (version !== detailVersion || session !== epoch || !thumb()) return;
    const url = URL.createObjectURL(blob);
    proofURLs.set(proofID, url);
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    thumb().replaceChildren(image);
  } catch (error) {
    if (version !== detailVersion || session !== epoch || handleAuthError(error) || !thumb()) return;
    const label = document.createElement("span");
    label.className = "proof-failed";
    label.textContent = "Gagal dimuat";
    thumb().replaceChildren(label);
  }
}
function viewProof(proofID) {
  const url = proofURLs.get(proofID);
  if (!url || !detail) return;
  const index = detail.payment_proofs.findIndex((proof) => proof.proof_id === proofID);
  $("proof-title").textContent = `Bukti ${index + 1} · ${detail.order_id}`;
  $("proof-view").src = url;
  $("proof-view").alt = `Bukti pembayaran ${index + 1} pesanan ${detail.order_id}`;
  $("proof-download").href = url;
  $("proof-download").download = `${detail.order_id}-bukti-${index + 1}.jpg`;
  showDialog("proof-dialog");
}
async function compressAll(files) {
  const result = [];
  for (const [index, file] of files.entries()) {
    $("proof-progress").textContent = `Mengompres foto ${index + 1} dari ${files.length}…`;
    result.push(await compressProof(file));
  }
  return result;
}
// Each POST is a separate mutation. Stop on the first failure; never retry an upload automatically.
async function uploadProofs(files) {
  if (!files.length || !detail || confirming || !extended(detail)) return;
  const order = detail;
  const remaining = LIMITS.proofsPerOrder - order.payment_proofs.length;
  if (files.length > remaining) {
    showError("proof-error", `Maksimal ${LIMITS.proofsPerOrder} foto per pesanan. Sisa slot: ${remaining}. Pilih lebih sedikit foto.`);
    return;
  }
  const session = epoch;
  lockConfirmation(true);
  showError("proof-error", "");
  let uploaded = 0;
  let failed = false;
  try {
    const blobs = await compressAll(files);
    for (const [index, blob] of blobs.entries()) {
      if (session !== epoch) return;
      $("proof-progress").textContent = `Mengunggah foto ${index + 1} dari ${blobs.length} (${fileSize(blob.size)})…`;
      await api.uploadProof(order.order_id, blob);
      uploaded++;
    }
  } catch (error) {
    if (session !== epoch || handleAuthError(error)) return;
    if (error instanceof ImageError) {
      // Nothing was sent when compression fails before the first upload.
      if (!uploaded) { showError("proof-error", error.message); $("proof-progress").textContent = ""; return; }
    }
    failed = true;
    draft = contactDraft();
    notifyEditorReset();
    detail = null;
    showError("proof-error", error.message + (uploaded ? ` ${uploaded} foto sudah terunggah.` : "") + " Muat ulang detail sebelum mengunggah lagi.");
    showError("detail-error", "Hasil unggah belum pasti. Muat ulang detail untuk melihat foto yang benar-benar tersimpan.");
    toast(error.message, true);
  } finally {
    if (session === epoch) {
      lockConfirmation(false);
      if (!detail) { lockDetail(true); $("retry-detail").disabled = false; }
    }
  }
  if (!failed && session === epoch && uploaded) {
    toast(`${uploaded} foto bukti pembayaran tersimpan. Memuat data terbaru.`);
    await Promise.all([openDetail(order.order_id), load()]);
  }
}
async function prepareReplace(file) {
  const proofID = replaceTarget;
  replaceTarget = null;
  if (!file || !proofID || !detail || confirming) return;
  showError("proof-error", "");
  try {
    const blob = await compressAll([file]);
    $("proof-progress").textContent = "";
    openConfirmation("proof-replace", { proofID, blob: blob[0] });
  } catch (error) {
    $("proof-progress").textContent = "";
    showError("proof-error", error.message);
  }
}

/* ===== Catalog and item rows (shared by create and edit) ===== */
async function loadCatalog() {
  if (catalog) return catalog;
  const session = epoch;
  catalogTask ||= api.products().finally(() => { catalogTask = null; });
  const result = await catalogTask;
  if (session === epoch) catalog = result;
  return result;
}
function matchProduct(item) {
  if (item.product_id && catalog.some((product) => product.id === item.product_id)) return item.product_id;
  const name = String(item.product_name ?? "").trim().toLowerCase();
  return catalog.find((product) => product.name.trim().toLowerCase() === name)?.id ?? "";
}
function itemRow(item = {}) {
  const productID = item.product_name !== undefined || item.product_id ? matchProduct(item) : "";
  const toppings = item.topping && !TOPPINGS.includes(item.topping) ? [...TOPPINGS, item.topping] : TOPPINGS;
  return '<li class="item-row"><label>Produk<select data-field="product"><option value="">Pilih produk</option>' +
    catalog.map((product) => '<option value="' + html(product.id) + '"' + (product.id === productID ? " selected" : "") + '>' + html(product.name) + ' · ' + html(money(product.price)) + '</option>').join("") +
    '</select></label><label>Topping<select data-field="topping"><option value="">Pilih topping</option>' +
    toppings.map((topping) => '<option value="' + html(topping) + '"' + (topping === item.topping ? " selected" : "") + '>' + html(topping) + '</option>').join("") +
    '</select></label><label>Jumlah<input data-field="qty" type="number" inputmode="numeric" min="1" max="' + LIMITS.qty + '" step="1" value="' + (item.qty ?? 1) + '"></label>' +
    '<button type="button" class="icon-button" data-remove-row aria-label="Hapus baris item">' + icon("close") + '</button></li>';
}
function itemsList(rows, estimateID, addID) {
  return '<ul class="item-rows">' + rows.map(itemRow).join("") + '</ul>' +
    '<button type="button" class="text-button" id="' + addID + '">+ Tambah item</button><p id="' + estimateID + '" class="fine-print" aria-live="polite"></p>';
}
function readItems(container) {
  const rows = [...container.querySelectorAll(".item-row")];
  if (!rows.length) return { error: "Minimal satu item pesanan." };
  if (rows.length > LIMITS.items) return { error: `Maksimal ${LIMITS.items} baris item.` };
  const items = [];
  for (const [index, row] of rows.entries()) {
    const product_id = row.querySelector('[data-field="product"]').value;
    const topping = row.querySelector('[data-field="topping"]').value;
    const raw = row.querySelector('[data-field="qty"]').value.trim();
    const qty = Number(raw);
    if (!product_id) return { error: `Pilih produk pada baris ${index + 1}.` };
    if (!topping) return { error: `Pilih topping pada baris ${index + 1}.` };
    if (!/^\d+$/.test(raw) || qty < 1 || qty > LIMITS.qty) return { error: `Jumlah baris ${index + 1} harus 1–${LIMITS.qty}.` };
    items.push({ product_id, topping, qty });
  }
  return { items };
}
function updateEstimate(container, estimateID) {
  if (!catalog || !$(estimateID)) return;
  const subtotal = [...container.querySelectorAll(".item-row")].reduce((sum, row) => {
    const product = catalog.find((entry) => entry.id === row.querySelector('[data-field="product"]').value);
    const qty = Number(row.querySelector('[data-field="qty"]').value);
    return sum + (product && Number.isInteger(qty) && qty > 0 ? product.price * qty : 0);
  }, 0);
  $(estimateID).textContent = `Perkiraan subtotal ${money(subtotal)} sebelum diskon Paket Bestie. Total final dihitung server.`;
}
function itemsSummary(items) {
  return items.map((item) => `${item.qty}× ${catalog.find((product) => product.id === item.product_id)?.name ?? item.product_id} (${item.topping})`).join(", ");
}
async function openItemsEditor(order) {
  if (!detail || confirming || itemsEditorOpen) return;
  const version = detailVersion;
  const session = epoch;
  $("items-edit").disabled = true;
  $("items-editor").innerHTML = '<p class="fine-print" role="status">Memuat katalog produk…</p>';
  try {
    await loadCatalog();
  } catch (error) {
    if (version !== detailVersion || session !== epoch) return;
    $("items-editor").innerHTML = '<p class="form-error" role="alert">' + html("Katalog produk gagal dimuat. " + error.message) + '</p>';
    $("items-edit").disabled = false;
    return;
  }
  if (version !== detailVersion || session !== epoch || !detail) return;
  itemsEditorOpen = true;
  if (!$("items-editor").dataset.bound) {
    bindItemRows($("items-editor"), "items-estimate", "items-add-row");
    $("items-editor").dataset.bound = "true";
  }
  const unmatched = order.items.filter((item) => !matchProduct(item)).length;
  $("items-editor").innerHTML = itemsList(order.items, "items-estimate", "items-add-row") +
    (unmatched ? '<p class="form-error" role="alert">' + number(unmatched) + ' item lama tidak cocok dengan katalog sekarang. Pilih ulang produknya sebelum menyimpan.</p>' : "") +
    '<p id="items-error" class="form-error" role="alert" hidden></p>';
  $("items-actions").innerHTML = '<button type="button" class="button primary" id="items-save">Simpan item</button><button type="button" class="button secondary" id="items-cancel">Batal ubah</button>';
  $("items-save").addEventListener("click", () => openConfirmation("items"));
  $("items-cancel").addEventListener("click", () => closeItemsEditor());
  updateEstimate($("items-editor"), "items-estimate");
}
function closeItemsEditor() {
  itemsEditorOpen = false;
  $("items-editor").replaceChildren();
  $("items-actions").innerHTML = '<button type="button" class="button secondary" id="items-edit">Ubah item</button>';
  $("items-edit").addEventListener("click", () => openItemsEditor(detail));
}
function bindItemRows(container, estimateID, addID, onChange = () => {}) {
  container.addEventListener("click", (event) => {
    if (event.target.closest(`#${addID}`)) {
      const list = container.querySelector(".item-rows");
      if (list.children.length >= LIMITS.items) return toast(`Maksimal ${LIMITS.items} baris item.`, true);
      list.insertAdjacentHTML("beforeend", itemRow());
      list.lastElementChild.querySelector("select").focus();
    } else if (event.target.closest("[data-remove-row]")) {
      event.target.closest(".item-row").remove();
    } else return;
    updateEstimate(container, estimateID);
    onChange();
  });
  container.addEventListener("input", () => { updateEstimate(container, estimateID); onChange(); });
  container.addEventListener("change", () => { updateEstimate(container, estimateID); onChange(); });
}

/* ===== Manual order creation ===== */
function resetCreate() {
  createKey = null;
  $("create-form").reset();
  $("create-items").replaceChildren();
  showError("create-error", "");
  $("create-submit").disabled = true;
}
async function openCreate() {
  if (!user || confirming || creating) return;
  const session = epoch;
  resetCreate();
  $("create-items").innerHTML = '<p class="fine-print" role="status">Memuat katalog produk…</p>';
  showDialog("create-dialog");
  try {
    await loadCatalog();
  } catch (error) {
    if (session !== epoch || !$("create-dialog").open) return;
    if (handleAuthError(error)) return;
    $("create-items").innerHTML = '<p class="form-error" role="alert">' + html("Katalog produk gagal dimuat. " + error.message) + '</p><button type="button" class="button secondary" id="create-retry">Coba kembali</button>';
    $("create-retry").addEventListener("click", openCreate);
    return;
  }
  if (session !== epoch || !$("create-dialog").open) return;
  $("create-items").innerHTML = itemsList([{}], "create-estimate", "create-add-row");
  updateEstimate($("create-items"), "create-estimate");
  $("create-submit").disabled = false;
  $("create-name").focus();
}
function lockCreate(value) {
  creating = value;
  $("create-dialog").querySelectorAll("input, select, textarea, button").forEach((el) => { el.disabled = value; });
}
async function submitCreate() {
  if (creating || !user || !catalog) return;
  const name = $("create-name").value.trim();
  const waInput = $("create-wa").value.trim();
  const note = $("create-note").value.trim();
  const { items, error } = readItems($("create-items"));
  const wa = waInput ? normalizeWA(waInput) : null;
  const problem = !name ? "Nama pelanggan wajib diisi." : name.length > LIMITS.customerName || CONTROL.test(name) ? `Nama maksimal ${LIMITS.customerName} karakter tanpa karakter kontrol.`
    : error ? error : waInput && !wa ? "Nomor WA tidak valid. Gunakan 08…, +62…, atau 628…, atau kosongkan."
    : note.length > LIMITS.note || CONTROL.test(note) ? `Catatan maksimal ${LIMITS.note} karakter.` : "";
  if (problem) return showError("create-error", problem);
  showError("create-error", "");
  // Same key for a resubmit of an unchanged form, so a backend with idempotency cannot create duplicates.
  createKey ||= crypto.randomUUID();
  const session = epoch;
  lockCreate(true);
  $("create-submit").textContent = "Menyimpan…";
  let created = null;
  try {
    created = await api.create({ customer_name: name, items, wa_number: wa, payment_method: $("create-payment").value || null, note: note || null }, createKey);
  } catch (error) {
    if (session !== epoch || handleAuthError(error)) return;
    const uncertain = error.status === 0 || error.status >= 500;
    showError("create-error", error.message + (uncertain ? " Hasil belum pasti: cek Daftar pesanan dulu sebelum menyimpan ulang agar tidak dobel." : ""));
  } finally {
    if (session === epoch) { lockCreate(false); $("create-submit").textContent = "Simpan pesanan"; }
  }
  if (!created || session !== epoch) return;
  createKey = null;
  $("create-dialog").close();
  toast(`Pesanan ${created.order_id} dibuat dengan total ${money(created.total)}.`);
  page = 1;
  await load();
  openDetail(created.order_id);
}

function openConfirmation(kind, extra = {}) {
  if (!detail || confirming || $("confirm-dialog").open) return;
  const order = detail;
  let target;
  let description;
  if (kind === "status") {
    target = $("target-status").value;
    if (!["PENDING", "COMPLETED", "CANCELLED"].includes(target)) return;
    description = STATUS[order.status].label + " → " + STATUS[target].label + ". Periksa keputusan perubahan atau koreksi status ini.";
  } else if (kind === "payment") {
    target = $("payment-method").value || null;
    if (![null, "QRIS", "CASH"].includes(target)) return;
    description = paymentLabel(order.payment_method) + " → " + paymentLabel(target) + ". Hanya metode pembayaran yang disimpan. Status dan nomor WA tidak ikut disimpan. Dana tetap harus diperiksa manual oleh admin.";
  } else if (kind === "customer") {
    target = $("customer-name").value.trim();
    if (!target || target.length > LIMITS.customerName || CONTROL.test(target)) {
      showError("customer-error", `Nama wajib diisi, maksimal ${LIMITS.customerName} karakter, tanpa karakter kontrol.`);
      return;
    }
    showError("customer-error", "");
    description = "Ubah nama pelanggan menjadi \u201c" + target + "\u201d? Hanya nama yang disimpan.";
  } else if (kind === "note" || kind === "note-clear") {
    target = kind === "note-clear" ? null : $("note-input").value.trim();
    if (kind === "note" && (!target || target.length > LIMITS.note || CONTROL.test(target))) {
      showError("note-error", target ? `Catatan maksimal ${LIMITS.note} karakter tanpa karakter kontrol.` : "Catatan kosong. Untuk menghapus catatan, gunakan Kosongkan catatan.");
      return;
    }
    if (kind === "note-clear" && order.note === null) return;
    showError("note-error", "");
    description = kind === "note-clear" ? "Kosongkan catatan admin pesanan ini?" : "Simpan catatan admin? Catatan hanya terlihat di dashboard.";
  } else if (kind === "items") {
    if (!canEditItems(order) || !catalog) return;
    const { items, error } = readItems($("items-editor"));
    if (error) { showError("items-error", error); return; }
    showError("items-error", "");
    target = items;
    description = "Ganti seluruh item menjadi: " + itemsSummary(items) + ". Subtotal, diskon, dan total dihitung ulang server.";
  } else if (kind === "proof-replace" || kind === "proof-delete") {
    const index = order.payment_proofs?.findIndex((proof) => proof.proof_id === extra.proofID) ?? -1;
    if (index < 0) return;
    target = extra;
    description = kind === "proof-delete"
      ? `Hapus foto bukti ${index + 1} secara permanen? Status pesanan tidak berubah.`
      : `Ganti foto bukti ${index + 1} dengan foto baru (${fileSize(extra.blob.size)})? Foto lama dihapus permanen.`;
  } else {
    target = kind === "clear" ? null : normalizeWA($("wa-number").value);
    if (kind !== "clear" && target === null) {
      showError("contact-error", "Nomor WA tidak valid. Gunakan nomor mobile Indonesia 08…, +62…, atau 628… (10–15 digit canonical), maksimal 32 karakter. Untuk mengosongkan, gunakan Kosongkan nomor.");
      return;
    }
    if (kind === "clear" && order.wa_number === null) return;
    showError("contact-error", "");
    description = kind === "clear"
      ? "Kosongkan nomor WA tersimpan? Kontak akan menjadi kosong; pesanan tetap tersimpan."
      : "Simpan nomor WA " + target + "? Periksa nomor dan pemiliknya sebelum menyimpan.";
  }
  pendingMutation = { kind, target, order: { ...order } };
  $("merchant-checked").checked = false;
  $("delete-order-id").value = "";
  $("delete-confirmation").hidden = true;
  $("merchant-confirmation").hidden = false;
  $("confirm-submit").classList.remove("danger");
  $("confirm-submit").classList.add("primary");
  $("merchant-checked").disabled = false;
  $("confirm-submit").disabled = true;
  $("confirm-submit").textContent = "Ya, simpan perubahan";
  $("confirm-title").textContent = {
    payment: "Simpan metode pembayaran?", status: "Ubah status pesanan?", clear: "Kosongkan nomor WA?", contact: "Simpan nomor WA?",
    customer: "Ubah nama pelanggan?", note: "Simpan catatan?", "note-clear": "Kosongkan catatan?", items: "Simpan item pesanan?",
    "proof-replace": "Ganti foto bukti?", "proof-delete": "Hapus foto bukti?",
  }[kind];
  $("confirm-description").textContent = description;
  $("confirm-summary").textContent = order.order_id + " · " + money(order.total);
  showError("confirm-error", "");
  showDialog("confirm-dialog");
}
function lockConfirmation(value) {
  confirming = value;
  $("confirm-submit").disabled = value || !confirmationReady();
  $("merchant-checked").disabled = value || !pendingMutation;
  $("delete-order-id").disabled = value || !pendingMutation;
  $("confirm-dialog").querySelectorAll("[data-close]").forEach((button) => { button.disabled = value; });
  lockDetail(value || !detail);
}
function openDeleteConfirmation() {
  if (!canDelete(detail) || confirming || $("confirm-dialog").open) return;
  pendingMutation = { kind: "delete", order: { ...detail } };
  $("delete-order-id").value = "";
  $("delete-order-id").disabled = false;
  $("delete-confirmation").hidden = false;
  $("merchant-confirmation").hidden = true;
  $("merchant-checked").checked = false;
  $("confirm-submit").disabled = true;
  $("confirm-submit").textContent = "Hapus permanen";
  $("confirm-submit").classList.remove("primary");
  $("confirm-submit").classList.add("danger");
  $("confirm-title").textContent = "Hapus pesanan?";
  $("confirm-description").textContent = "Pesanan dan seluruh rincian item akan dihapus permanen. Tindakan ini tidak dapat dibatalkan. Ketik Order ID persis untuk melanjutkan.";
  $("confirm-summary").textContent = detail.order_id + " · " + STATUS[detail.status].label + " · " + money(detail.total);
  showError("confirm-error", "");
  showDialog("confirm-dialog");
}
function confirmationReady() {
  return !!detail && !!pendingMutation && (pendingMutation.kind === "delete"
    ? canDelete(detail) && canDelete(pendingMutation.order) && $("delete-order-id").value === pendingMutation.order.order_id
    : $("merchant-checked").checked);
}
async function finishDeletion(message) {
  detailVersion++;
  detail = null; detailID = null; draft = null; pendingMutation = null;
  $("confirm-dialog").close();
  $("detail-dialog").close();
  $("detail-content").replaceChildren();
  $("detail-title").textContent = "Detail pesanan";
  toast(message);
  await load();
}
async function deleteOrder() {
  if (confirming || pendingMutation?.kind !== "delete" || !confirmationReady()) return;
  const selected = pendingMutation;
  const session = epoch;
  let recover = false;
  lockConfirmation(true);
  $("confirm-submit").textContent = "Menghapus…";
  try {
    await api.remove(selected.order.order_id, selected.order.status);
    if (session !== epoch) return;
    await finishDeletion("Pesanan dan rincian item telah dihapus permanen.");
  } catch (error) {
    if (session !== epoch || handleAuthError(error)) return;
    draft = contactDraft();
    notifyEditorReset();
    detail = null; pendingMutation = null;
    recover = error.status === 0 || error.status >= 500 || error.status === 404;
    showError("confirm-error", error.message + " Muat ulang detail sebelum tindakan berikutnya.");
    showError("detail-error", "Penghapusan belum terkonfirmasi. Wajib memeriksa detail terbaru sebelum bertindak lagi.");
  } finally {
    if (session === epoch) {
      lockConfirmation(false);
      $("confirm-submit").textContent = "Hapus permanen";
      if (!detail && $("retry-detail")) $("retry-detail").disabled = false;
    }
  }
  if (recover && session === epoch) {
    $("confirm-dialog").close();
    toast("Hasil penghapusan belum pasti. Memeriksa detail terbaru tanpa mengulang DELETE.", true);
    await openDetail(selected.order.order_id, { deletedOnMissing: true });
  }
}
async function saveMutation() {
  if (pendingMutation?.kind === "delete") return deleteOrder();
  if (confirming || !detail || !pendingMutation || !$("merchant-checked").checked) return;
  const selected = pendingMutation;
  const session = epoch;
  lockConfirmation(true);
  $("confirm-submit").textContent = "Menyimpan…";
  showError("confirm-error", "");
  let succeeded = false;
  try {
    const id = selected.order.order_id;
    const result = selected.kind === "status" ? await api.status(id, selected.target, selected.order.status)
      : selected.kind === "payment" ? await api.paymentMethod(id, selected.target, selected.order.payment_method)
      : selected.kind === "customer" ? await api.customer(id, selected.target, selected.order.customer_name)
      : ["note", "note-clear"].includes(selected.kind) ? await api.note(id, selected.target, selected.order.note)
      : selected.kind === "items" ? await api.items(id, selected.target, selected.order.items.map(({ product_name, topping, qty, unit_price }) => ({ product_name, topping, qty, unit_price })))
      : selected.kind === "proof-replace" ? await api.replaceProof(id, selected.target.proofID, selected.target.blob)
      : selected.kind === "proof-delete" ? (await api.removeProof(id, selected.target.proofID), { changed: true })
      : await api.contact(id, selected.target, selected.order.wa_number);
    if (session !== epoch) return;
    succeeded = true;
    pendingMutation = null;
    $("confirm-dialog").close();
    toast(result.changed ? "Perubahan diterima backend. Memuat data terbaru." : "Data sudah sesuai tujuan, tanpa perubahan. Memuat data terbaru.");
  } catch (error) {
    if (session !== epoch) return;
    if (handleAuthError(error)) return;
    // A failed/expired PATCH may already have committed. No automatic retry.
    draft = contactDraft();
    notifyEditorReset();
    detail = null;
    pendingMutation = null;
    showError("confirm-error", error.message + " Tutup konfirmasi, lalu muat ulang detail sebelum menyimpan lagi.");
    showError("detail-error", "Data perlu diperiksa ulang. Input nomor belum disimpan tetap dipertahankan; muat ulang detail sebelum menyimpan.");
    toast(error.message, true);
  } finally {
    if (session === epoch) {
      lockConfirmation(false);
      $("confirm-submit").textContent = "Ya, simpan perubahan";
      if (!detail) {
        lockDetail(true);
        $("retry-detail").disabled = false;
      }
    }
  }
  if (succeeded && session === epoch) {
    const preserveDraft = !["contact", "clear"].includes(selected.kind);
    if (!preserveDraft && contactDraft()) toast("Draft nomor WA diganti dengan hasil penyimpanan kontak.");
    await Promise.all([openDetail(selected.order.order_id, { preserveDraft, appliedKind: selected.kind }), load()]);
  }
}
function enterWorkspace() {
  epoch++;
  $("access-screen").hidden = true;
  $("workspace").hidden = false;
  $("data-source").textContent = "Data backend";
  $("mapping-note").textContent = "COMPLETED berarti Sudah dibayar berdasarkan pemeriksaan manual admin.";
  $("search").value = ""; $("status-filter").value = ""; $("page-size").value = "8";
  page = 1; total = 0;
  $("user-name").textContent = user.name;
  $("user-role").textContent = user.role;
  $("user-initials").textContent = initials(user.name);
  $("main-content").focus({ preventScroll: true });
  load();
}
function leaveWorkspace({ focus = true } = {}) {
  epoch++; listVersion++; detailVersion++;
  clearTimeout(searchTimer);
  auth.clearSession();
  user = null; detail = null; detailID = null; draft = null; pendingMutation = null;
  confirming = false; loading = false; total = 0; page = 1;
  catalog = null; catalogTask = null; itemsEditorOpen = false; replaceTarget = null;
  clearProofURLs();
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  lockCreate(false); resetCreate(); $("create-submit").textContent = "Simpan pesanan";
  $("workspace").hidden = true; $("access-screen").hidden = false;
  $("order-rows").replaceChildren(); $("detail-content").replaceChildren();
  $("detail-title").textContent = "Detail pesanan";
  $("confirm-summary").replaceChildren();
  $("confirm-description").textContent = ""; $("confirm-title").textContent = "Simpan perubahan?";
  $("merchant-checked").checked = false; $("confirm-submit").disabled = true;
  $("delete-order-id").value = "";
  document.querySelectorAll("[data-close]").forEach((el) => { el.disabled = false; });
  showError("confirm-error", ""); showError("login-error", "");
  showError("summary-error", ""); $("stats").setAttribute("aria-busy", false);
  $("toasts").replaceChildren();
  $("user-name").textContent = "Tim Le Cheese"; $("user-role").textContent = "—"; $("user-initials").textContent = "LC";
  $("login-form").reset(); $("search").value = ""; $("status-filter").value = "";
  $("table-state").replaceChildren(); $("table-state").hidden = true;
  $("page-info").textContent = "Belum ada data"; $("last-updated").textContent = "Belum diperbarui";
  setLoading(false); clearStats();
  if (focus) $("password").focus();
}
$("today").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" }).format(new Date());
$("year").textContent = new Date().getFullYear();
$("setup-notice").hidden = ADMIN_API_ENABLED;
$("login-form").hidden = !ADMIN_API_ENABLED;
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("login-button").disabled) return;
  const session = epoch;
  $("login-button").disabled = true; $("login-button").textContent = "Memeriksa akses…";
  showError("login-error", "");
  let password = $("password").value;
  $("password").value = "";
  const verification = auth.login(password);
  password = null;
  try {
    const identity = await verification;
    if (session !== epoch) return;
    user = identity;
    enterWorkspace();
  } catch (error) {
    if (session === epoch) showError("login-error", error.message);
  } finally {
    $("password").value = "";
    $("login-button").disabled = false; $("login-button").textContent = "Masuk";
  }
});
$("logout").addEventListener("click", () => { auth.logout(); leaveWorkspace(); });
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer); listVersion++;
  $("page-prev").disabled = true; $("page-next").disabled = true;
  searchTimer = setTimeout(() => { page = 1; load(); }, 250);
});
$("status-filter").addEventListener("change", () => { clearTimeout(searchTimer); page = 1; load(); });
$("page-size").addEventListener("change", () => { page = 1; load(); });
$("reset-filters").addEventListener("click", () => { clearTimeout(searchTimer); $("search").value = ""; $("status-filter").value = ""; page = 1; load(); });
$("refresh").addEventListener("click", () => { clearTimeout(searchTimer); load(); });
$("page-prev").addEventListener("click", () => { if (page > 1 && !loading) { page--; load(); } });
$("page-next").addEventListener("click", () => { if (!loading && page < Math.ceil(total / Number($("page-size").value))) { page++; load(); } });
$("order-rows").addEventListener("click", (event) => { const button = event.target.closest("[data-order]"); if (button) openDetail(button.dataset.order); });
$("merchant-checked").addEventListener("change", () => { $("confirm-submit").disabled = confirming || !confirmationReady(); });
$("delete-order-id").addEventListener("input", () => { $("confirm-submit").disabled = confirming || !confirmationReady(); });
$("confirm-submit").addEventListener("click", saveMutation);
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => { if (!confirming && !creating) $(button.dataset.close).close(); }));
$("create-open").addEventListener("click", openCreate);
$("create-submit").addEventListener("click", submitCreate);
$("create-form").addEventListener("submit", (event) => { event.preventDefault(); submitCreate(); });
$("create-form").addEventListener("input", () => { createKey = null; });
$("create-form").addEventListener("change", () => { createKey = null; });
bindItemRows($("create-items"), "create-estimate", "create-add-row", () => { createKey = null; });
$("create-dialog").addEventListener("close", () => { if (!creating) resetCreate(); });
$("detail-content").addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]");
  const replace = event.target.closest("[data-replace]");
  const remove = event.target.closest("[data-remove-proof]");
  if (view) viewProof(view.dataset.view);
  else if (replace && !confirming && detail) { replaceTarget = replace.dataset.replace; showError("proof-error", ""); $("proof-replace-input").click(); }
  else if (remove) openConfirmation("proof-delete", { proofID: remove.dataset.removeProof });
});
$("confirm-dialog").addEventListener("close", () => {
  if (!$("confirm-dialog").open) {
    pendingMutation = null;
    $("delete-order-id").value = "";
    $("confirm-summary").replaceChildren();
    $("confirm-description").textContent = "";
  }
});
$("detail-dialog").addEventListener("close", () => {
  if (!$("detail-dialog").open) {
    if (user && contactDraft()) toast("Input nomor yang belum disimpan ditinggalkan saat detail ditutup.", true);
    if (user) notifyEditorReset();
    detailVersion++; detail = null; detailID = null; draft = null; itemsEditorOpen = false;
    clearProofURLs();
    $("detail-content").replaceChildren(); $("detail-title").textContent = "Detail pesanan";
  }
});
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("cancel", (event) => { if (confirming || creating) event.preventDefault(); }));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const dialogs = [...document.querySelectorAll("dialog[open]")];
  if (!dialogs.length) return;
  event.preventDefault(); event.stopPropagation();
  if (!confirming && !creating) dialogs.at(-1).close();
}, true);
// Clear even a pending login before navigation; BFCache must return to a locked UI.
window.addEventListener("pagehide", () => leaveWorkspace({ focus: false }));
