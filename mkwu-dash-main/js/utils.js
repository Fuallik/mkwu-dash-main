export const STATUS = Object.freeze({
  PENDING: { label: "Menunggu", className: "pending" },
  COMPLETED: { label: "Sudah dibayar", className: "completed" },
  NEEDS_REVIEW: { label: "Perlu diperiksa", className: "review" },
  CANCELLED: { label: "Dibatalkan", className: "cancelled" },
});
export const paymentLabel = (value) => value === "QRIS" ? "QRIS" : value === "CASH" ? "Tunai" : "Belum ditentukan";
const rupiah = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const money = (value) => Number.isFinite(value) ? rupiah.format(value) : "—";
export const number = (value) => Number.isFinite(value) ? new Intl.NumberFormat("id-ID").format(value) : "—";
export function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta",
  }).format(date);
}
export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
export function badge(status) {
  const info = STATUS[status] || { label: status || "Tidak diketahui", className: "unknown" };
  return `<span class="badge ${info.className}"><span aria-hidden="true"></span>${escapeHTML(info.label)}</span>`;
}
export function normalizeWA(value) {
  if (typeof value !== "string" || value.length > 32 || /^\+?[0-9 ()-]+$/.exec(value)?.[0] !== value) return null;
  let digits = value.replace(/[ ()-]/g, "");
  if (digits.startsWith("+62")) digits = digits.slice(1);
  else if (digits.startsWith("08")) digits = `62${digits.slice(1)}`;
  return canonicalWA(digits) ? digits : null;
}
const canonicalWA = (value) => typeof value === "string" && /^628[0-9]{7,12}$/.exec(value)?.[0] === value;
// Reading legacy data must not normalize it silently into a clickable link.
export function chatURL(value) {
  return canonicalWA(value) ? `https://wa.me/${value}` : null;
}
export function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}
// Quote every cell, escape quotes, and neutralize spreadsheet formulas.
export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function ordersCSV(orders) {
  const rows = [["Order ID", "Customer", "Total IDR", "Payment Method", "Status", "Order Date (ISO)"]];
  orders.forEach((order) => rows.push([order.order_id, order.customer_name, order.total, order.payment_method ?? "Tidak tersedia", order.status, order.created_at]));
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
