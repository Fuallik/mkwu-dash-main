// Public ES-module constants, without a build step. Never put credentials here.
export const VITE_API_URL = "https://cheesecake-api-mu.vercel.app";
export const API_BASE_URL = VITE_API_URL;
// Admin contract and source availability: docs/API-CONTRACT.md.
export const ADMIN_API_ENABLED = true;
export const DEMO_ENABLED = false;
export const REQUEST_TIMEOUT_MS = 15000;
// Upload needs more time than a JSON mutation on slow mobile networks.
export const UPLOAD_TIMEOUT_MS = 45000;
export const ENDPOINTS = Object.freeze({
  me: "/admin/me",
  orders: "/admin/orders",
  summary: "/admin/summary",
  products: "/products",
  create: "/admin/orders",
  detail: (id) => `/admin/orders/${encodeURIComponent(id)}`,
  status: (id) => `/admin/orders/${encodeURIComponent(id)}/status`,
  contact: (id) => `/admin/orders/${encodeURIComponent(id)}/contact`,
  paymentMethod: (id) => `/admin/orders/${encodeURIComponent(id)}/payment-method`,
  customer: (id) => `/admin/orders/${encodeURIComponent(id)}/customer`,
  note: (id) => `/admin/orders/${encodeURIComponent(id)}/note`,
  items: (id) => `/admin/orders/${encodeURIComponent(id)}/items`,
  proofs: (id) => `/admin/orders/${encodeURIComponent(id)}/payment-proofs`,
  proof: (id, proofID) => `/admin/orders/${encodeURIComponent(id)}/payment-proofs/${encodeURIComponent(proofID)}`,
  remove: (id) => `/admin/orders/${encodeURIComponent(id)}`,
});
// Must match the topping validation in the backend (same list as MKWU-WEB).
export const TOPPINGS = Object.freeze([
  "Tanpa topping",
  "Selai blueberry",
  "Selai strawberry",
  "Drizzle matcha",
  "Drizzle cokelat",
  "Salted Caramel",
]);
export const LIMITS = Object.freeze({
  customerName: 100,
  note: 500,
  items: 30,
  qty: 99,
  proofsPerOrder: 5,
  // Original photo accepted from the device before compression.
  proofSourceBytes: 20 * 1024 * 1024,
  // Uploaded JPEG after browser compression; below the Vercel function body limit.
  proofUploadBytes: 1536 * 1024,
  proofMaxSide: 2000,
});
