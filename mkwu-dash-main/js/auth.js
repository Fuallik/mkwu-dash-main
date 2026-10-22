import { api, setAdminSecret } from "./api.js";
let user = null;
let generation = 0;
export function currentUser() { return user; }
export async function login(password) {
  clearSession();
  const attempt = generation;
  setAdminSecret(password);
  password = null;
  try {
    const identity = await api.me();
    if (attempt !== generation) throw new Error("Pemeriksaan akses dibatalkan.");
    user = identity;
    return user;
  } catch (error) {
    if (attempt === generation) clearSession();
    throw error;
  }
}
export function clearSession() { generation++; user = null; setAdminSecret(null); }
// No server session or logout endpoint. Rotation of ADMIN_SECRET revokes access.
export function logout() { clearSession(); }
