// Synthetic UI fixtures. Loaded only after the user explicitly enters DEMO.
// This adapter never calls an API and never persists transactions.
import { APIError } from "./api.js";
import { ordersCSV } from "./utils.js";
const names = ["Nadia Putri", "Rizky Pratama", "Aulia Rahma", "Dimas Saputra", "Citra Lestari", "Fajar Maulana", "Intan Permata", "Bagas Aditya", "Salsa Kirana", "Rafi Ramadhan", "Dewi Anggraini", "Ardi Nugraha", "Maya Safitri", "Reza Mahendra", "Tiara Amelia", "Galih Prakoso", "Nabila Zahra", "Farhan Akbar"];
const codes = ["K7MPQ", "A3HNX", "B8RTV", "C9WYZ", "D2FGH", "E4JKM", "F5NPQ", "G6RST", "H7VWX", "J8YZA", "K9BCD", "M2EFG", "N3HJK", "P4MNP", "Q5RST", "R6VWX", "S7YZA", "T8BCD"];
export function createDemo() {
  let scenario = "normal";
  let role = "ADMIN";
  const orders = names.map((name, index) => ({
    order_id: `ORD-${codes[index]}`, customer_name: name,
    status: ["PENDING", "COMPLETED", "COMPLETED", "NEEDS_REVIEW", "PENDING", "COMPLETED", "CANCELLED"][index % 7],
    total: 35000, subtotal: 36000, discount: 1000, payment_method: "QRIS",
    created_at: new Date(Date.UTC(2026, 9, 19, 6, 42) - index * 2740000).toISOString(),
    items: [{ product_name: "Le Mini Bite · Original", topping: "Selai blueberry", qty: 3, unit_price: 12000, subtotal: 36000 }],
  }));
  async function wait() {
    await new Promise((resolve) => setTimeout(resolve, scenario === "slow" ? 2200 : 300));
    if (scenario === "error") throw new APIError("DEMO: simulasi koneksi terputus. Pilih skenario Normal untuk mencoba kembali.");
  }
  function filtered({ search = "", status = "" } = {}) {
    if (scenario === "empty") return [];
    return orders.filter((order) => order.order_id.toLowerCase().includes(search.trim().toLowerCase()) && (!status || order.status === status));
  }
  return {
    setScenario(value) { scenario = value; },
    setRole(value) { role = value; },
    async list(filters) { await wait(); const rows = filtered(filters); return { items: structuredClone(rows.slice((filters.page - 1) * filters.page_size, filters.page * filters.page_size)), total: rows.length, page: filters.page, page_size: filters.page_size }; },
    async summary() { await wait(); const rows = filtered(); return { total_orders: rows.length, total_transaction_value: rows.reduce((sum, row) => sum + row.total, 0), confirmed_payments: rows.filter((row) => row.status === "COMPLETED").length, pending_payments: rows.filter((row) => row.status === "PENDING").length }; },
    async detail(id) { await wait(); const order = orders.find((row) => row.order_id === id); if (!order) throw new APIError("Pesanan tidak ditemukan.", 404); return structuredClone(order); },
    async confirm(id, expectedStatus) {
      await wait();
      if (role !== "ADMIN") throw new APIError("DEMO: peran FINANCE tidak dapat mengonfirmasi.", 403);
      const order = orders.find((row) => row.order_id === id);
      if (!order) throw new APIError("Pesanan tidak ditemukan.", 404);
      if (order.status === "COMPLETED") return { order: structuredClone(order), already_confirmed: true };
      if (order.status !== expectedStatus || !["PENDING", "NEEDS_REVIEW"].includes(order.status)) throw new APIError("Status pesanan sudah berubah.", 409);
      order.status = "COMPLETED";
      return { order: structuredClone(order), already_confirmed: false };
    },
    async export(filters) { await wait(); return new Blob([ordersCSV(filtered(filters))], { type: "text/csv;charset=utf-8" }); },
  };
}
