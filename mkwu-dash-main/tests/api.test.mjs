import test from "node:test";
import assert from "node:assert/strict";
import { api, setAdminSecret, validateOrder } from "../js/api.js";
import * as auth from "../js/auth.js";
import { chatURL, normalizeWA, escapeHTML, dateTime, paymentLabel } from "../js/utils.js";

globalThis.location = { hostname: "127.0.0.1" };
const identity = { id: "admin", name: "Admin", role: "ADMIN" };
const row = {
  order_id: "ORD-K7MPQ", customer_name: "Customer", status: "PENDING", total: 35000,
  payment_method: null, created_at: "2026-10-19T06:42:00Z", wa_number: null,
  subtotal: 36000, discount: 1000,
  items: [{ product_name: "Snapshot", topping: "Original", qty: 3, unit_price: 12000, subtotal: 36000 }],
};
const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

test("contact validation and links require exact ASCII canonical digits", () => {
  for (const value of ["081234567890", "+62 (812) 3456-7890", "6281234567890"]) assert.equal(normalizeWA(value), "6281234567890");
  for (const value of ["", " ", "0".repeat(33), "081234567890\n", "6281234567890\u2028", "++6281234567890", "https://wa.me/6281234567890", "javascript:alert(1)", "８１２３４５６７８９０"]) {
    assert.equal(normalizeWA(value), null);
    assert.equal(chatURL(value), null);
  }
  assert.equal(chatURL("6281234567890"), "https://wa.me/6281234567890");
  assert.equal(chatURL("+62 812-3456-7890"), null);
  assert.equal(escapeHTML('<img onerror="x">'), "&lt;img onerror=&quot;x&quot;&gt;");
  assert.match(dateTime(row.created_at), /13[.:]42/);
});

test("detail requires nullable contact and snapshot; legacy contact remains exact", () => {
  assert.equal(validateOrder({ ...row, wa_number: " +62 812-3456-7890 " }, true).wa_number, " +62 812-3456-7890 ");
  for (const patch of [{ wa_number: undefined }, { wa_number: 62812345 }, { status: "PAID" }, { total: -1 }, { created_at: "2026-10-19" }, { items: [null] }]) {
    assert.throws(() => validateOrder({ ...row, ...patch }, true), /Struktur/);
  }
});

test("adapter sends exact status/contact CAS payload, header and fetch security options", async () => {
  setAdminSecret("test-only");
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return json({ order: row, changed: false });
  };
  await api.status(row.order_id, "PENDING", "NEEDS_REVIEW");
  await api.contact(row.order_id, null, " +62 812-3456-7890 ");
  for (const call of calls) {
    assert.equal(call.method, "PATCH");
    assert.equal(call.headers["X-Admin-Secret"], "test-only");
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.credentials, "omit");
    assert.equal(call.cache, "no-store");
    assert.equal(call.redirect, "error");
  }
  assert.deepEqual(JSON.parse(calls[0].body), { status: "PENDING", expected_status: "NEEDS_REVIEW" });
  assert.deepEqual(JSON.parse(calls[1].body), { wa_number: null, expected_wa_number: " +62 812-3456-7890 " });
  assert.match(calls[1].url, /\/contact$/);
  setAdminSecret(null);
});

test("edge and malformed responses sanitize details and never retry", async () => {
  for (const status of [401, 403, 404, 409, 413, 422, 429, 500, 503, 200]) {
    let count = 0;
    setAdminSecret("test-only");
    globalThis.fetch = async () => {
      count++;
      return new Response("<html>private-password-contact</html>", { status, headers: { "Content-Type": "text/html" } });
    };
    await assert.rejects(api.status(row.order_id, "COMPLETED", "PENDING"), (error) => {
      assert.equal(error.status, status === 200 ? 0 : status);
      assert.doesNotMatch(error.message, /private-password-contact/);
      return true;
    });
    assert.equal(count, 1);
  }
  setAdminSecret(null);
});

test("network/CORS errors and invalid JSON never disclose raw error", async () => {
  setAdminSecret("test-only");
  globalThis.fetch = async () => { throw new Error("secret-in-edge-diagnostic"); };
  await assert.rejects(api.me(), (error) => /CORS/.test(error.message) && !error.message.includes("secret-in-edge"));
  globalThis.fetch = async () => new Response("invalid-json-secret", { headers: { "Content-Type": "application/json" } });
  await assert.rejects(api.me(), (error) => !error.message.includes("invalid-json-secret"));
  setAdminSecret(null);
});

test("logout aborts in-flight reads and removes credential before next request", async () => {
  globalThis.fetch = async () => json(identity);
  await auth.login("test-only");
  let signal;
  globalThis.fetch = async (_, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const read = api.detail(row.order_id);
  auth.logout();
  assert.equal(signal.aborted, true);
  await assert.rejects(read);
  assert.equal(auth.currentUser(), null);
  await assert.rejects(api.me(), (error) => error.status === 401);
});

test("late verification cannot log in again after logout", async () => {
  let resolve;
  globalThis.fetch = () => new Promise((done) => { resolve = done; });
  const login = auth.login("test-only");
  auth.logout();
  resolve(json(identity));
  await assert.rejects(login, /dibatalkan/);
  assert.equal(auth.currentUser(), null);
  await assert.rejects(api.me(), (error) => error.status === 401);
});

test("a 401 revokes module credential even outside the dashboard", async () => {
  setAdminSecret("test-only");
  let count = 0;
  globalThis.fetch = async () => { count++; return new Response("", { status: 401 }); };
  await assert.rejects(api.me(), (error) => error.status === 401);
  await assert.rejects(api.me(), (error) => error.status === 401);
  assert.equal(count, 1);
});

test("list, detail and all mutation envelopes accept only QRIS/CASH/null", async () => {
  setAdminSecret("test-only");
  const filters = { page: 1, page_size: 8 };
  for (const method of [null, "QRIS", "CASH", "Tunai", "", "qris", "null", 0, false, {}, [], undefined]) {
    const order = { ...row, payment_method: method };
    const valid = [null, "QRIS", "CASH"].includes(method);
    for (const operation of ["list", "detail", "payment", "status", "contact"]) {
      globalThis.fetch = async () => json(operation === "list" ? { items: [order], total: 1, ...filters }
        : operation === "detail" ? order : { order, changed: false });
      const request = operation === "list" ? api.list(filters) : operation === "detail" ? api.detail(row.order_id)
        : operation === "payment" ? api.paymentMethod(row.order_id, method, null)
        : operation === "status" ? api.status(row.order_id, "PENDING", "PENDING")
        : api.contact(row.order_id, null, null);
      if (valid) {
        const result = await request;
        assert.equal((operation === "list" ? result.items[0] : operation === "detail" ? result : result.order).payment_method, method);
      } else await assert.rejects(request, /Struktur/);
    }
  }
  assert.deepEqual([null, "QRIS", "CASH"].map(paymentLabel), ["Belum ditentukan", "QRIS", "Tunai"]);
  setAdminSecret(null);
});

test("payment adapter sends exact two-field CAS for all targets and expectations", async () => {
  setAdminSecret("test-only");
  for (const expected of [null, "QRIS", "CASH"]) {
    for (const target of [null, "QRIS", "CASH"]) {
      let count = 0;
      globalThis.fetch = async (url, options) => {
        count++;
        assert.match(url, /\/admin\/orders\/ORD-K7MPQ\/payment-method$/);
        assert.deepEqual(JSON.parse(options.body), { payment_method: target, expected_payment_method: expected });
        assert.equal(options.method, "PATCH");
        assert.equal(options.headers["X-Admin-Secret"], "test-only");
        assert.equal(options.credentials, "omit");
        assert.equal(options.cache, "no-store");
        assert.equal(options.redirect, "error");
        return json({ order: { ...row, payment_method: target }, changed: expected !== target });
      };
      const result = await api.paymentMethod(row.order_id, target, expected);
      assert.equal(result.order.payment_method, target);
      assert.equal(result.changed, expected !== target);
      assert.equal(count, 1);
    }
  }
  setAdminSecret(null);
  globalThis.fetch = async () => assert.fail("No request without credential");
  await assert.rejects(api.paymentMethod(row.order_id, "QRIS", null), (error) => error.status === 401);
});

test("payment mutation timeout uses configured deadline and never retries", async () => {
  setAdminSecret("test-only");
  const originalTimeout = globalThis.setTimeout;
  let count = 0;
  // Advance only the adapter deadline; no 15-second wait or config mutation.
  globalThis.setTimeout = (callback, ms) => {
    assert.equal(ms, 15000);
    return originalTimeout(callback, 1);
  };
  globalThis.fetch = async (_, options) => {
    count++;
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("private", "AbortError"))));
  };
  try {
    await assert.rejects(api.paymentMethod(row.order_id, "QRIS", null), /batas waktu/);
    assert.equal(count, 1);
  } finally { globalThis.setTimeout = originalTimeout; setAdminSecret(null); }
});

test("payment mutation sanitizes errors and rejects uncertain success envelopes", async () => {
  for (const body of [{ order: row }, { order: { ...row, order_id: "other" }, changed: true },
    { order: { ...row, items: undefined }, changed: true }, { changed: true }, null]) {
    setAdminSecret("test-only");
    globalThis.fetch = async () => json(body);
    await assert.rejects(api.paymentMethod(row.order_id, "QRIS", null), /Struktur/);
  }
  for (const status of [401, 403, 404, 409, 413, 422, 429, 500, 503, 200]) {
    setAdminSecret("test-only");
    let count = 0;
    globalThis.fetch = async () => {
      count++;
      return new Response("private details", { status, headers: { "Content-Type": "text/html" } });
    };
    await assert.rejects(api.paymentMethod(row.order_id, "QRIS", null), (error) => !error.message.includes("private"));
    assert.equal(count, 1);
  }
  setAdminSecret(null);
});

test("delete sends one conditional request and accepts 204 without reading JSON", async () => {
  setAdminSecret("test-only");
  let count = 0;
  globalThis.fetch = async (url, options) => {
    count++;
    assert.match(url, /\/admin\/orders\/ORD-K7MPQ\?expected_status=CANCELLED$/);
    assert.equal(options.method, "DELETE");
    assert.equal(options.body, undefined);
    assert.equal(options.headers["Content-Type"], undefined);
    assert.equal(options.headers["X-Admin-Secret"], "test-only");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    return { ok: true, status: 204, headers: { get: () => assert.fail("204 does not need content type") },
      json: () => assert.fail("Never parse 204") };
  };
  assert.equal(await api.remove(row.order_id, "CANCELLED"), undefined);
  assert.equal(count, 1);
  setAdminSecret(null);
  globalThis.fetch = async () => assert.fail("No delete without credential");
  await assert.rejects(api.remove(row.order_id, "CANCELLED"), (error) => error.status === 401);
});

test("delete rejects unexpected success and sanitizes errors without retry", async () => {
  for (const status of [200, 202, 401, 403, 404, 409, 413, 422, 429, 500, 503]) {
    setAdminSecret("test-only");
    let count = 0;
    globalThis.fetch = async () => { count++; return new Response("private delete details", { status }); };
    await assert.rejects(api.remove(row.order_id, "CANCELLED"), (error) => !error.message.includes("private"));
    assert.equal(count, 1);
  }
  setAdminSecret(null);
});

test("delete timeout aborts once and never retries automatically", async () => {
  setAdminSecret("test-only");
  const originalTimeout = globalThis.setTimeout;
  let count = 0;
  globalThis.setTimeout = (callback, ms) => {
    assert.equal(ms, 15000);
    return originalTimeout(callback, 1);
  };
  globalThis.fetch = async (_, options) => {
    count++;
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("private", "AbortError"))));
  };
  try {
    await assert.rejects(api.remove(row.order_id, "CANCELLED"), /batas waktu/);
    assert.equal(count, 1);
  } finally { globalThis.setTimeout = originalTimeout; setAdminSecret(null); }
});

const extendedOrder = {
  ...row, note: null,
  payment_proofs: [{ proof_id: "prf_1", content_type: "image/jpeg", size: 2048, created_at: "2026-10-22T07:00:00Z" }],
  items: [{ ...row.items[0], product_id: "bite-original" }],
};

test("extended detail fields are optional but strictly validated when present", () => {
  assert.equal(validateOrder(extendedOrder, true).note, null);
  assert.equal(validateOrder({ ...row, proof_count: 2 }).proof_count, 2);
  for (const patch of [{ note: 5 }, { note: "x".repeat(501) }, { payment_proofs: {} },
    { payment_proofs: [{ ...extendedOrder.payment_proofs[0], proof_id: "../x" }] },
    { payment_proofs: [{ ...extendedOrder.payment_proofs[0], content_type: "image/svg+xml" }] },
    { payment_proofs: [extendedOrder.payment_proofs[0], extendedOrder.payment_proofs[0]] },
    { payment_proofs: Array.from({ length: 6 }, (_, i) => ({ ...extendedOrder.payment_proofs[0], proof_id: "p" + i })) },
    { items: [{ ...row.items[0], product_id: 7 }] }]) {
    assert.throws(() => validateOrder({ ...extendedOrder, ...patch }, true), /Struktur/);
  }
  assert.throws(() => validateOrder({ ...row, proof_count: -1 }), /Struktur/);
});

test("customer, note and items send exact two-field CAS payloads", async () => {
  setAdminSecret("test-only");
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return json({ order: extendedOrder, changed: true }); };
  const items = [{ product_id: "bite-original", topping: "Selai blueberry", qty: 3 }];
  const expected = [{ product_name: "Snapshot", topping: "Original", qty: 3, unit_price: 12000 }];
  await api.customer(row.order_id, "Nama", "Customer");
  await api.note(row.order_id, null, "lama");
  await api.items(row.order_id, items, expected);
  assert.deepEqual(calls.map((call) => [call.method, call.url.replace(/^.*\/ORD-K7MPQ/, "")]), [["PATCH", "/customer"], ["PATCH", "/note"], ["PATCH", "/items"]]);
  assert.deepEqual(calls.map((call) => JSON.parse(call.body)), [
    { customer_name: "Nama", expected_customer_name: "Customer" }, { note: null, expected_note: "lama" }, { items, expected_items: expected }]);
  assert.ok(calls.every((call) => call.headers["X-Admin-Secret"] === "test-only" && call.credentials === "omit" && call.cache === "no-store"));
  setAdminSecret(null);
});

test("create sends Idempotency-Key and validates returned detail", async () => {
  setAdminSecret("test-only");
  let seen;
  globalThis.fetch = async (url, options) => { seen = { url, ...options }; return new Response(JSON.stringify({ order: extendedOrder }), { status: 201, headers: { "Content-Type": "application/json" } }); };
  const body = { customer_name: "A", items: [{ product_id: "bite-original", topping: "Tanpa topping", qty: 1 }], wa_number: null, payment_method: null, note: null };
  const order = await api.create(body, "key-1");
  assert.equal(order.order_id, row.order_id);
  assert.equal(seen.method, "POST");
  assert.match(seen.url, /\/admin\/orders$/);
  assert.equal(seen.headers["Idempotency-Key"], "key-1");
  assert.deepEqual(JSON.parse(seen.body), body);
  globalThis.fetch = async () => json({ order: { ...extendedOrder, total: -1 } });
  await assert.rejects(api.create(body, "key-2"), /Struktur/);
  globalThis.fetch = async () => new Response("", { status: 405 });
  await assert.rejects(api.create(body, "key-3"), (error) => error.status === 405 && /belum tersedia/.test(error.message));
  setAdminSecret(null);
});

test("public catalog never carries the admin secret and is validated", async () => {
  setAdminSecret("test-only");
  let headers;
  globalThis.fetch = async (url, options) => { headers = options.headers; return json([{ id: "bite-original", name: "Le Mini Bite Original", price: 12000, line: "bite" }]); };
  assert.equal((await api.products())[0].id, "bite-original");
  assert.equal(headers["X-Admin-Secret"], undefined);
  for (const bad of [[], [{ id: "", name: "x", price: 1 }], [{ id: "a", name: "x", price: -1 }], [{ id: "a", name: "x", price: 1 }, { id: "a", name: "y", price: 1 }]]) {
    globalThis.fetch = async () => json(bad);
    await assert.rejects(api.products(), /Struktur/);
  }
  globalThis.fetch = async () => new Response("", { status: 401 });
  await assert.rejects(api.products());
  globalThis.fetch = async () => json(identity);
  assert.deepEqual(await api.me(), identity, "public 401 must not revoke the admin credential");
  setAdminSecret(null);
});

test("proof upload/replace send raw JPEG once; delete expects 204; image read requires image type", async () => {
  setAdminSecret("test-only");
  const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return json({ order: extendedOrder, changed: true }); };
  await api.uploadProof(row.order_id, jpeg);
  await api.replaceProof(row.order_id, "prf_1", jpeg);
  assert.deepEqual(calls.map((call) => [call.method, call.url.replace(/^.*\/ORD-K7MPQ/, ""), call.headers["Content-Type"], call.body]),
    [["POST", "/payment-proofs", "image/jpeg", jpeg], ["PUT", "/payment-proofs/prf_1", "image/jpeg", jpeg]]);
  for (const bad of [new Blob([], { type: "image/jpeg" }), new Blob(["x"], { type: "image/svg+xml" }), new Blob([new Uint8Array(1536 * 1024 + 1)], { type: "image/jpeg" }), "file"]) {
    globalThis.fetch = async () => assert.fail("Invalid file must not be sent");
    await assert.rejects(api.uploadProof(row.order_id, bad), /Foto tidak valid/);
  }
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, "DELETE");
    assert.match(url, /\/payment-proofs\/prf_1$/);
    return { ok: true, status: 204, headers: { get: () => null }, json: () => assert.fail("Never parse 204") };
  };
  assert.equal(await api.removeProof(row.order_id, "prf_1"), undefined);
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers["X-Admin-Secret"], "test-only");
    return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
  };
  assert.equal((await api.proofImage(row.order_id, "prf_1")).type, "image/jpeg");
  globalThis.fetch = async () => new Response("<svg onload=x>", { headers: { "Content-Type": "image/svg+xml" } });
  await assert.rejects(api.proofImage(row.order_id, "prf_1"), /bukan gambar/);
  globalThis.fetch = async () => new Response("private", { status: 413, headers: { "Content-Type": "text/html" } });
  await assert.rejects(api.uploadProof(row.order_id, jpeg), (error) => error.status === 413 && !error.message.includes("private"));
  setAdminSecret(null);
});
