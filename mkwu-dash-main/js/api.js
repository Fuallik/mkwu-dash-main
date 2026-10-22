import { API_BASE_URL, ADMIN_API_ENABLED, ENDPOINTS, LIMITS, REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from "./config.js";

export class APIError extends Error {
  constructor(message, status = 0) { super(message); this.name = "APIError"; this.status = status; }
}
let secret = null; // Only module memory; never exposed through a getter or persisted.
const active = new Set();
export function setAdminSecret(value) {
  active.forEach((controller) => controller.abort());
  active.clear();
  secret = value;
}
function apiURL(path) {
  if (!ADMIN_API_ENABLED) throw new APIError("API admin belum diaktifkan.");
  let base;
  try { base = new URL(API_BASE_URL); } catch { throw new APIError("Konfigurasi URL API tidak valid."); }
  const loopback = (host) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && loopback(base.hostname) && loopback(location.hostname)))) {
    throw new APIError("Konfigurasi API tidak valid. Gunakan HTTPS untuk jaringan publik.");
  }
  return base.href.replace(/\/$/, "") + path;
}
async function request(path, { method = "GET", body, upload, emptyResponse = false, image = false,
  auth = true, headers: extra = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = apiURL(path);
  if (auth && !secret) throw new APIError("Silakan masuk kembali.", 401);
  const controller = new AbortController();
  active.add(controller);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: image ? "image/jpeg, image/png, image/webp" : "application/json", ...extra };
    if (auth) headers["X-Admin-Secret"] = secret;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    // Raw image bytes: the body is the file, its MIME type is the Content-Type.
    if (upload) headers["Content-Type"] = upload.type;
    const response = await fetch(url, {
      method, headers, body: upload ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error",
    });
    if (!response.ok) {
      // Edge responses may be HTML or contain private internals. Never echo them.
      const messages = {
        401: "Password admin tidak valid. Silakan masuk kembali.",
        403: "Akses ditolak. Periksa izin atau kebijakan keamanan layanan.",
        404: "Pesanan, foto, atau endpoint admin tidak ditemukan.",
        405: "Fitur ini belum tersedia di backend. Hubungi pengelola API.",
        409: "Data pesanan telah berubah. Wajib muat ulang detail sebelum menyimpan lagi.",
        413: "Ukuran input atau foto terlalu besar. Kurangi input sebelum mencoba kembali.",
        415: "Format file tidak didukung. Gunakan foto JPG, PNG, atau WEBP.",
        422: "Input tidak valid. Periksa nama, item, catatan, metode pembayaran, nomor WA, status, dan batas panjang input.",
        429: "Terlalu banyak permintaan. Tunggu sebentar, lalu coba kembali secara manual.",
        503: "Layanan sementara tidak tersedia. Tunggu, lalu coba kembali secara manual.",
      };
      if (response.status === 401 && auth) setAdminSecret(null);
      throw new APIError(messages[response.status] || "Server gagal memproses permintaan. Coba kembali secara manual.", response.status);
    }
    if (emptyResponse) {
      if (response.status !== 204) throw new APIError("Respons penghapusan tidak sesuai kontrak. Muat ulang detail sebelum mencoba lagi.");
      return;
    }
    if (image) {
      const type = (response.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (!PROOF_TYPES.includes(type)) throw new APIError("Respons foto bukan gambar yang diharapkan.");
      const blob = await response.blob();
      return blob.type === type ? blob : new Blob([blob], { type });
    }
    if (!(response.headers.get("Content-Type") || "").includes("application/json")) {
      throw new APIError("Respons layanan bukan JSON yang diharapkan. Periksa koneksi atau layanan edge.");
    }
    return await response.json();
  } catch (error) {
    if (error instanceof APIError) throw error;
    if (error.name === "AbortError") throw new APIError("Permintaan melewati batas waktu atau dibatalkan. Muat ulang detail sebelum menyimpan lagi.");
    throw new APIError("Tidak dapat membaca respons API. Periksa koneksi, CORS, alamat API, atau layanan edge. Muat ulang detail sebelum menyimpan lagi.");
  } finally { clearTimeout(timeout); active.delete(controller); }
}
const invalid = () => { throw new APIError("Struktur respons API tidak sesuai kontrak. Data tidak ditampilkan."); };
const amount = (value) => Number.isSafeInteger(value) && value >= 0;
const statuses = ["PENDING", "COMPLETED", "CANCELLED", "NEEDS_REVIEW"];
export const PROOF_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
const timestamp = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
const proofID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
// Optional fields keep the dashboard usable against a backend without the new endpoints.
function validateExtensions(order, detail) {
  if ("proof_count" in order && !amount(order.proof_count)) invalid();
  if (!detail) return;
  if ("note" in order && !(order.note === null || (typeof order.note === "string" && order.note.length <= LIMITS.note))) invalid();
  if ("payment_proofs" in order) {
    if (!Array.isArray(order.payment_proofs) || order.payment_proofs.length > LIMITS.proofsPerOrder ||
        order.payment_proofs.some((proof) => !proof || !proofID(proof.proof_id) || !PROOF_TYPES.includes(proof.content_type) ||
        !amount(proof.size) || !timestamp(proof.created_at)) ||
        new Set(order.payment_proofs.map((proof) => proof.proof_id)).size !== order.payment_proofs.length) invalid();
  }
  if (order.items.some((item) => "product_id" in item && !(item.product_id === null || typeof item.product_id === "string"))) invalid();
}
export function validateOrder(order, detail = false) {
  if (!order || typeof order.order_id !== "string" || !order.order_id ||
      typeof order.customer_name !== "string" || !statuses.includes(order.status) ||
      !amount(order.total) || typeof order.created_at !== "string" ||
      Number.isNaN(Date.parse(order.created_at)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(order.created_at) ||
      ![null, "QRIS", "CASH"].includes(order.payment_method)) invalid();
  if (detail && (!(order.wa_number === null || typeof order.wa_number === "string") ||
      !amount(order.subtotal) || !amount(order.discount) || !Array.isArray(order.items) ||
      order.items.some((item) => !item || typeof item.product_name !== "string" || typeof item.topping !== "string" ||
      !Number.isSafeInteger(item.qty) || item.qty < 1 || !amount(item.unit_price) || !amount(item.subtotal)))) invalid();
  validateExtensions(order, detail);
  return order;
}
export function validateProducts(products) {
  if (!Array.isArray(products) || !products.length || products.some((product) => !product ||
      typeof product.id !== "string" || !product.id || product.id.length > 64 || typeof product.name !== "string" ||
      !amount(product.price) || ("line" in product && typeof product.line !== "string")) ||
      new Set(products.map((product) => product.id)).size !== products.length) invalid();
  return products;
}
export function validateUser(user) {
  if (!user || user.id !== "admin" || user.name !== "Admin" || user.role !== "ADMIN") invalid();
  return user;
}
function query(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value !== "" && value != null) params.set(key, value); });
  return params.size ? "?" + params : "";
}
async function mutate(path, id, body, options = { method: "PATCH", body }) {
  const data = await request(path, options);
  if (!data || typeof data.changed !== "boolean") invalid();
  validateOrder(data.order, true);
  if (data.order.order_id !== id) invalid();
  return data;
}
export const api = {
  async me() { return validateUser(await request(ENDPOINTS.me)); },
  async list(filters) {
    const data = await request(ENDPOINTS.orders + query(filters));
    if (!data || !Array.isArray(data.items) || !amount(data.total) || data.total < data.items.length ||
        data.page !== filters.page || data.page_size !== filters.page_size || data.items.length > filters.page_size) invalid();
    data.items.forEach((item) => validateOrder(item));
    return data;
  },
  async summary() {
    const data = await request(ENDPOINTS.summary);
    if (!data || ["total_orders", "total_transaction_value", "confirmed_payments", "pending_payments"].some((key) => !amount(data[key]))) invalid();
    return data;
  },
  async detail(id) {
    const data = validateOrder(await request(ENDPOINTS.detail(id)), true);
    if (data.order_id !== id) invalid();
    return data;
  },
  status: (id, status, expected_status) => mutate(ENDPOINTS.status(id), id, { status, expected_status }),
  contact: (id, wa_number, expected_wa_number) => mutate(ENDPOINTS.contact(id), id, { wa_number, expected_wa_number }),
  paymentMethod: (id, payment_method, expected_payment_method) => mutate(ENDPOINTS.paymentMethod(id), id, { payment_method, expected_payment_method }),
  remove: (id, expected_status) => request(ENDPOINTS.remove(id) + query({ expected_status }), { method: "DELETE", emptyResponse: true }),
  // Public catalog; never send the admin secret to a public endpoint.
  async products() { return validateProducts(await request(ENDPOINTS.products, { auth: false })); },
  async create(order, idempotencyKey) {
    const data = await request(ENDPOINTS.create, { method: "POST", body: order, headers: { "Idempotency-Key": idempotencyKey } });
    if (!data) invalid();
    return validateOrder(data.order, true);
  },
  customer: (id, customer_name, expected_customer_name) => mutate(ENDPOINTS.customer(id), id, { customer_name, expected_customer_name }),
  note: (id, note, expected_note) => mutate(ENDPOINTS.note(id), id, { note, expected_note }),
  items: (id, items, expected_items) => mutate(ENDPOINTS.items(id), id, { items, expected_items }),
  proofImage: (id, proof) => request(ENDPOINTS.proof(id, proof), { image: true }),
  uploadProof: async (id, file) => mutate(ENDPOINTS.proofs(id), id, null, { method: "POST", upload: proofFile(file), timeoutMs: UPLOAD_TIMEOUT_MS }),
  replaceProof: async (id, proof, file) => mutate(ENDPOINTS.proof(id, proof), id, null, { method: "PUT", upload: proofFile(file), timeoutMs: UPLOAD_TIMEOUT_MS }),
  removeProof: (id, proof) => request(ENDPOINTS.proof(id, proof), { method: "DELETE", emptyResponse: true }),
};
function proofFile(file) {
  if (!(file instanceof Blob) || !PROOF_TYPES.includes(file.type) || !file.size || file.size > LIMITS.proofUploadBytes) {
    throw new APIError("Foto tidak valid atau melebihi batas ukuran unggah.");
  }
  return file;
}
