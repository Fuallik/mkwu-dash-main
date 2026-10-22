"""Browser tests for the extended admin contract: manual orders, name/item/note editors
and payment proof photos. Uses the same cross-origin HTTP fixture approach as
browser_test.py; no production API, real credentials, or database access.
Run: python tests/browser_extended_test.py (Chrome + websocket-client).
"""
import copy
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import zlib
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse

import browser_test as base
from browser_test import ARTIFACTS, LOCK, ORDERS, RESULTS, STATE, Browser, Handler, check

CATALOG = [
    {"id": "bite-original", "line": "bite", "name": "Le Mini Bite Original", "flavor": "Original", "price": 12000},
    {"id": "bite-chocolate", "line": "bite", "name": "Le Mini Bite Chocolate", "flavor": "Chocolate", "price": 12000},
    {"id": "classic-matcha", "line": "classic", "name": "Le Mini Classic Matcha", "flavor": "Matcha", "price": 18000},
]
TOPPINGS = ["Tanpa topping", "Selai blueberry", "Selai strawberry", "Drizzle matcha", "Drizzle cokelat", "Salted Caramel"]
EXT = {"requests": [], "uploads": [], "creates": [], "proofs": {}, "upload_mode": "normal", "create_mode": "normal", "serial": 0}


def png(width=8, height=6, rgb=(97, 107, 54)):
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def priced(items):
    rows, bite, classic = [], 0, 0
    for item in items:
        product = next(p for p in CATALOG if p["id"] == item["product_id"])
        rows.append({"product_id": product["id"], "product_name": product["name"], "topping": item["topping"], "qty": item["qty"],
                     "unit_price": product["price"], "subtotal": product["price"] * item["qty"]})
        bite += item["qty"] if product["line"] == "bite" else 0
        classic += item["qty"] if product["line"] == "classic" else 0
    subtotal = sum(row["subtotal"] for row in rows)
    discount = bite // 3 * 1000 + classic // 2 * 1000
    return rows, subtotal, discount, subtotal - discount


def new_proof(content, kind="image/jpeg"):
    EXT["serial"] += 1
    proof_id = f"prf_{EXT['serial']}"
    EXT["proofs"][proof_id] = (kind, content)
    return {"proof_id": proof_id, "content_type": kind, "size": len(content), "created_at": "2026-10-22T07:00:00Z"}


def valid_items(items):
    return isinstance(items, list) and 1 <= len(items) <= 30 and all(
        isinstance(i, dict) and set(i) == {"product_id", "topping", "qty"} and any(p["id"] == i["product_id"] for p in CATALOG)
        and i["topping"] in TOPPINGS and isinstance(i["qty"], int) and 1 <= i["qty"] <= 99 for i in items)


class ExtendedAPI(base.APIHandler):
    def do_OPTIONS(self):
        STATE["requests"].append(("OPTIONS", self.path))
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", STATE["origin"])
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret, Idempotency-Key")
        self.end_headers()

    def do_POST(self):
        self.extended("POST")

    def do_PUT(self):
        self.extended("PUT")

    def raw(self, content, kind):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", STATE["origin"])
        self.end_headers()
        self.wfile.write(content)

    def fixture(self, method):
        path = urlparse(self.path).path
        parts = path.split("/")
        if path == "/products":
            EXT["requests"].append(("GET", path, self.headers.get("X-Admin-Secret")))
            return self.reply(CATALOG)
        if self.headers.get("X-Admin-Secret") == "test-only":
            if len(parts) == 6 and parts[4] == "payment-proofs" and method in ["GET", "DELETE"]:
                return self.proof(method, parts[3], parts[5])
            if len(parts) == 5 and parts[4] in ["customer", "note", "items"] and method == "PATCH":
                return self.edit(parts[3], parts[4])
        return super().fixture(method)

    def order(self, order_id):
        return next((row for row in ORDERS if row["order_id"] == order_id), None)

    def proof(self, method, order_id, proof_id):
        EXT["requests"].append((method, self.path, None))
        row = self.order(order_id)
        entry = row and next((p for p in row.get("payment_proofs", []) if p["proof_id"] == proof_id), None)
        if not entry:
            return self.reply({}, 404)
        if method == "GET":
            kind, content = EXT["proofs"][proof_id]
            return self.raw(content, kind)
        with LOCK:
            row["payment_proofs"].remove(entry)
        return self.reply(None, 204)

    def edit(self, order_id, operation):
        row = self.order(order_id)
        if row is None or "payment_proofs" not in row:
            return self.reply({}, 404)
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        STATE["mutations"].append((self.path, body))
        if STATE["mode"] == "conflict":
            return self.reply({}, 409)
        with LOCK:
            if operation == "items":
                expected = [{k: i[k] for k in ["product_name", "topping", "qty", "unit_price"]} for i in row["items"]]
                if set(body) != {"items", "expected_items"} or not valid_items(body["items"]):
                    return self.reply({}, 422)
                if row["status"] == "COMPLETED" or body["expected_items"] != expected:
                    return self.reply({}, 409)
                row["items"], row["subtotal"], row["discount"], row["total"] = priced(body["items"])
                return self.reply({"order": copy.deepcopy(row), "changed": True})
            field = {"customer": "customer_name", "note": "note"}[operation]
            if set(body) != {field, "expected_" + field}:
                return self.reply({}, 422)
            if row[field] != body["expected_" + field]:
                return self.reply({}, 409)
            changed = row[field] != body[field]
            row[field] = body[field]
            return self.reply({"order": copy.deepcopy(row), "changed": changed})

    def extended(self, method):
        path = urlparse(self.path).path
        parts = path.split("/")
        assert self.headers.get("X-Admin-Secret") == "test-only", "Admin secret required"
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        kind = self.headers.get("Content-Type")
        if method == "POST" and path == "/admin/orders":
            data = json.loads(body)
            EXT["creates"].append({"body": data, "key": self.headers.get("Idempotency-Key")})
            if EXT["create_mode"] == "error":
                return self.reply("<html>private</html>", 500, "text/html")
            if set(data) != {"customer_name", "items", "wa_number", "payment_method", "note"} or not valid_items(data["items"]):
                return self.reply({}, 422)
            existing = next((row for row in ORDERS if row.get("_key") == self.headers.get("Idempotency-Key")), None)
            if existing:
                return self.reply({"order": {k: v for k, v in existing.items() if k != "_key"}}, 201)
            items, subtotal, discount, total = priced(data["items"])
            row = {"order_id": f"ORD-NEW{len(EXT['creates'])}", "customer_name": data["customer_name"], "status": "PENDING",
                   "wa_number": base.normalize(data["wa_number"]), "payment_method": data["payment_method"], "note": data["note"],
                   "payment_proofs": [], "items": items, "subtotal": subtotal, "discount": discount, "total": total,
                   "created_at": "2026-10-22T08:00:00Z", "_key": self.headers.get("Idempotency-Key")}
            with LOCK:
                ORDERS.insert(0, row)
            return self.reply({"order": {k: v for k, v in row.items() if k != "_key"}}, 201)
        row = self.order(parts[3]) if len(parts) > 3 else None
        EXT["uploads"].append({"method": method, "path": path, "type": kind, "size": len(body), "magic": body[:3].hex()})
        if row is None:
            return self.reply({}, 404)
        if EXT["upload_mode"] == "conflict":
            return self.reply({}, 409)
        if kind not in ["image/jpeg", "image/png", "image/webp"] or not body or length > 1536 * 1024:
            return self.reply({}, 415)
        with LOCK:
            if method == "POST":
                if len(row["payment_proofs"]) >= 5:
                    return self.reply({}, 409)
                row["payment_proofs"].append(new_proof(body, kind))
            else:
                index = next((n for n, p in enumerate(row["payment_proofs"]) if p["proof_id"] == parts[5]), None)
                if index is None:
                    return self.reply({}, 404)
                row["payment_proofs"][index] = new_proof(body, kind)
            return self.reply({"order": copy.deepcopy(row), "changed": True})


def run(b, url):
    def loaded():
        b.loaded()
    def open_order(order_id, ready="#customer-name"):
        b.click(f"[data-order='{order_id}']")
        b.wait(f"!!document.querySelector('{ready}') && !document.querySelector('{ready}').disabled")
    def confirm():
        b.wait("document.querySelector('#confirm-dialog').open")
        b.click("#merchant-checked")
        b.click("#confirm-submit")
    def saved():
        b.wait("!document.querySelector('#confirm-dialog').open && !!document.querySelector('#customer-name') && !document.querySelector('#customer-name').disabled")
        loaded()
    def attach(selector, count, size=(2400, 1600)):
        b.js("(async()=>{const dt=new DataTransfer();for(let i=0;i<" + str(count) + ";i++){const c=document.createElement('canvas');c.width=" + str(size[0]) + ";c.height=" + str(size[1]) + ";const x=c.getContext('2d');x.fillStyle='hsl('+(i*90)+',60%,50%)';x.fillRect(0,0,c.width,c.height);x.fillStyle='#fff';x.font='120px sans-serif';x.fillText('Transfer '+i,100,300);const blob=await new Promise(r=>c.toBlob(r,'image/png'));dt.items.add(new File([blob],'bukti'+i+'.png',{type:'image/png'}));}const input=document.querySelector(" + json.dumps(selector) + ");input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()")

    target = ORDERS[0]
    target.update({"status": "PENDING", "note": None, "payment_proofs": [new_proof(png(), "image/png")], "proof_count": 1})
    target["items"], target["subtotal"], target["discount"], target["total"] = priced([{"product_id": "bite-original", "topping": "Selai blueberry", "qty": 3}])
    paid = ORDERS[1]
    paid.update({"status": "COMPLETED", "note": "Lunas", "payment_proofs": []})

    b.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
    b.goto(url + "fixture/")
    b.fill("#password", "test-only")
    b.click("#login-button")
    loaded()
    check(b, "Proof count from list row is shown as a small indicator", "document.querySelector('.proof-pill') && document.querySelector('.proof-pill').textContent.includes('1')")

    # Detail, thumbnails and viewer
    open_order(target["order_id"])
    b.wait("!!document.querySelector('.proof-thumb img')")
    check(b, "Extended detail shows name, item, note and proof editors", "['customer-name','items-edit','note-input','note-clear','proof-add'].every(id=>document.getElementById(id)) && document.querySelector('#note-clear').disabled")
    check(b, "Proof thumbnail is fetched with credential and rendered from a blob URL", "document.querySelector('.proof-thumb img').src.startsWith('blob:')")
    assert any(r[0] == "GET" and "/payment-proofs/" in r[1] for r in EXT["requests"])
    b.click(".proof-thumb")
    check(b, "Viewer dialog shows the photo and a download link", "document.querySelector('#proof-dialog').open && document.querySelector('#proof-view').src.startsWith('blob:') && document.querySelector('#proof-download').download.endsWith('.jpg')")
    b.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    check(b, "Escape closes only the viewer and keeps detail open", "!document.querySelector('#proof-dialog').open && document.querySelector('#detail-dialog').open")

    # Customer name
    count = len(STATE["mutations"])
    b.fill("#customer-name", "   ")
    b.click("#customer-save")
    check(b, "Blank customer name is rejected without request", "!document.querySelector('#customer-error').hidden && !document.querySelector('#confirm-dialog').open")
    assert len(STATE["mutations"]) == count
    old_name = target["customer_name"]
    b.fill("#customer-name", '  <b onclick="x">Nadia</b>  ')
    b.click("#customer-save")
    check(b, "Name confirmation shows markup as text and starts unchecked", "document.querySelector('#confirm-description').textContent.includes('<b onclick') && !document.querySelector('#confirm-description b') && document.querySelector('#confirm-submit').disabled")
    b.click("#merchant-checked")
    b.click("#confirm-submit")
    saved()
    assert STATE["mutations"][-1][1] == {"customer_name": '<b onclick="x">Nadia</b>', "expected_customer_name": old_name}
    check(b, "Name saved with exact CAS payload, detail and list refreshed", "document.querySelector('#customer-name').value === '<b onclick=\"x\">Nadia</b>' && document.querySelector('#order-rows').textContent.includes('Nadia') && !document.querySelector('#order-rows b')")

    # Note
    b.fill("#note-input", "  Ambil hari Sabtu, bayar QRIS  ")
    check(b, "Note counter follows input length", "document.querySelector('#note-count').textContent.startsWith('32')")
    b.click("#note-save")
    confirm()
    saved()
    assert STATE["mutations"][-1][1] == {"note": "Ambil hari Sabtu, bayar QRIS", "expected_note": None}
    check(b, "Note saved trimmed and Kosongkan becomes available", "document.querySelector('#note-input').value === 'Ambil hari Sabtu, bayar QRIS' && !document.querySelector('#note-clear').disabled")
    b.fill("#note-input", "")
    b.click("#note-save")
    check(b, "Empty note save points to Kosongkan instead of sending", "document.querySelector('#note-error').textContent.includes('Kosongkan') && !document.querySelector('#confirm-dialog').open")
    b.fill("#note-input", "Ambil hari Sabtu, bayar QRIS")
    b.click("#note-clear")
    confirm()
    saved()
    assert STATE["mutations"][-1][1] == {"note": None, "expected_note": "Ambil hari Sabtu, bayar QRIS"}
    check(b, "Note cleared to null", "document.querySelector('#note-input').value === '' && document.querySelector('#note-clear').disabled")

    # Items
    snapshot = [{k: i[k] for k in ["product_name", "topping", "qty", "unit_price"]} for i in target["items"]]
    b.click("#items-edit")
    b.wait("document.querySelectorAll('#items-editor .item-row').length === 1")
    assert any(r[1] == "/products" and r[2] is None for r in EXT["requests"]), "Catalog must not receive admin secret"
    check(b, "Item editor is prefilled from the order snapshot and public catalog", "document.querySelector('#items-editor [data-field=product]').value === 'bite-original' && document.querySelector('#items-editor [data-field=topping]').value === 'Selai blueberry' && document.querySelector('#items-estimate').textContent.includes('36.000')")
    b.click("#items-add-row")
    b.fill("#items-editor .item-row:last-child [data-field=product]", "classic-matcha", "change")
    b.click("#items-save")
    check(b, "Incomplete item row is rejected before confirmation", "document.querySelector('#items-error').textContent.includes('topping') && !document.querySelector('#confirm-dialog').open")
    b.fill("#items-editor .item-row:last-child [data-field=topping]", "Drizzle cokelat", "change")
    b.fill("#items-editor .item-row:last-child [data-field=qty]", "2")
    check(b, "Estimate updates from catalog prices", "document.querySelector('#items-estimate').textContent.includes('72.000')")
    b.click("#items-save")
    check(b, "Item confirmation summarizes new items", "document.querySelector('#confirm-description').textContent.includes('2× Le Mini Classic Matcha (Drizzle cokelat)')")
    b.click("#merchant-checked")
    b.click("#confirm-submit")
    saved()
    assert STATE["mutations"][-1][1] == {"items": [{"product_id": "bite-original", "topping": "Selai blueberry", "qty": 3},
                                                   {"product_id": "classic-matcha", "topping": "Drizzle cokelat", "qty": 2}],
                                         "expected_items": snapshot}
    check(b, "Items saved; server-computed subtotal, discount and total shown", "document.querySelector('.detail-total strong').textContent.includes('70.000') && document.querySelector('.detail-totals').textContent.includes('2.000') && document.querySelectorAll('.detail-items li').length === 2 && !document.querySelector('#items-save')")
    b.click("#items-edit")
    b.wait("!!document.querySelector('#items-save')")
    b.fill("#note-input", "draft")
    b.click("#retry-detail")
    b.wait("!!document.querySelector('#items-edit') && !document.querySelector('#items-edit').disabled")
    check(b, "Reloading detail discards open item editor and note draft with a notice", "document.querySelector('#toasts').textContent.includes('catatan dan item pesanan')")

    # Uploads
    before = len(EXT["uploads"])
    attach("#proof-input", 2)
    b.wait("document.querySelectorAll('.proof-card').length === 3 && !!document.querySelector('#customer-name') && !document.querySelector('#customer-name').disabled", 20)
    b.wait("document.querySelectorAll('.proof-thumb img').length === 3")
    posted = EXT["uploads"][before:]
    assert [u["method"] for u in posted] == ["POST", "POST"], posted
    assert all(u["type"] == "image/jpeg" and u["magic"] == "ffd8ff" and u["size"] <= 1536 * 1024 for u in posted), posted
    check(b, "Two photos compressed to JPEG and uploaded as separate POSTs", "document.querySelector('#proof-section .count-pill').textContent.includes('3 / 5') && document.querySelector('#toasts').textContent.includes('2 foto')")
    before = len(EXT["uploads"])
    attach("#proof-input", 3, (40, 30))
    check(b, "Selecting more photos than free slots is rejected without upload", "document.querySelector('#proof-error').textContent.includes('Sisa slot: 2')")
    assert len(EXT["uploads"]) == before

    # Replace
    first = target["payment_proofs"][0]["proof_id"]
    b.click(f"[data-replace='{first}']")
    attach("#proof-replace-input", 1, (640, 480))
    b.wait("document.querySelector('#confirm-dialog').open")
    check(b, "Replace asks for confirmation and shows the compressed size", "document.querySelector('#confirm-title').textContent === 'Ganti foto bukti?' && /KB|MB/.test(document.querySelector('#confirm-description').textContent)")
    b.click("#merchant-checked")
    b.click("#confirm-submit")
    saved()
    assert EXT["uploads"][-1]["method"] == "PUT" and EXT["uploads"][-1]["path"].endswith(first) and EXT["uploads"][-1]["type"] == "image/jpeg"
    check(b, "Replaced proof gets a new id and still three photos", f"document.querySelectorAll('.proof-card').length === 3 && !document.querySelector('[data-replace={json.dumps(first)}]')")

    # Delete
    victim = target["payment_proofs"][1]["proof_id"]
    b.click(f"[data-remove-proof='{victim}']")
    count = len(EXT["requests"])
    b.click("#confirm-cancel")
    assert not any(r[0] == "DELETE" for r in EXT["requests"][count:])
    b.click(f"[data-remove-proof='{victim}']")
    confirm()
    saved()
    assert any(r[0] == "DELETE" and r[1].endswith(victim) for r in EXT["requests"])
    check(b, "Proof deleted after confirmation; other photos kept", "document.querySelectorAll('.proof-card').length === 2 && document.querySelector('#toasts').textContent.length > 0")

    # Upload failure requires reload
    EXT["upload_mode"] = "conflict"
    attach("#proof-input", 1, (300, 200))
    b.wait("!document.querySelector('#proof-error').hidden && document.querySelector('#proof-error').textContent.includes('Muat ulang')", 10)
    check(b, "Failed upload locks editors until detail is reloaded", "document.querySelector('#proof-add').disabled && document.querySelector('#customer-save').disabled && !document.querySelector('#retry-detail').disabled")
    EXT["upload_mode"] = "normal"
    b.click("#retry-detail")
    b.wait("!!document.querySelector('#customer-name') && !document.querySelector('#customer-name').disabled")
    b.click("[data-close='detail-dialog']")

    # Paid order: items locked; legacy order: backend hint
    open_order(paid["order_id"])
    check(b, "Paid order keeps items locked and shows existing note", "!document.querySelector('#items-edit') && document.querySelector('#detail-content').textContent.includes('sudah dibayar dikunci') && document.querySelector('#note-input').value === 'Lunas'")
    b.click("[data-close='detail-dialog']")
    legacy = ORDERS[2]
    open_order(legacy["order_id"], "#status-save")
    check(b, "Order without extended fields explains backend update, no new editors", "!document.querySelector('#customer-name') && !document.querySelector('#proof-add') && document.querySelector('#detail-content').textContent.includes('Backend belum mengirim')")
    b.click("[data-close='detail-dialog']")

    # Manual order
    b.click("#create-open")
    b.wait("document.querySelector('#create-dialog').open && !!document.querySelector('#create-items .item-row') && !document.querySelector('#create-submit').disabled")
    check(b, "Create dialog loads catalog with one empty item row", "document.querySelectorAll('#create-items .item-row').length === 1 && document.activeElement.id === 'create-name'")
    b.click("#create-submit")
    check(b, "Empty name is rejected locally", "document.querySelector('#create-error').textContent.includes('Nama')")
    b.fill("#create-name", "Pembeli Chat")
    b.fill("#create-items [data-field=product]", "bite-chocolate", "change")
    b.fill("#create-items [data-field=topping]", "Salted Caramel", "change")
    b.fill("#create-items [data-field=qty]", "3")
    b.fill("#create-wa", "javascript:1")
    b.click("#create-submit")
    check(b, "Invalid optional WA is rejected locally", "document.querySelector('#create-error').textContent.includes('Nomor WA')")
    assert not EXT["creates"]
    b.fill("#create-wa", "0812 3456 7890")
    b.fill("#create-payment", "QRIS", "change")
    b.fill("#create-note", " via DM ")
    EXT["create_mode"] = "error"
    b.click("#create-submit")
    b.wait("document.querySelector('#create-error').textContent.includes('belum pasti') && !document.querySelector('#create-submit').disabled")
    b.click("#create-submit")
    deadline = time.monotonic() + 8
    while len(EXT["creates"]) < 2 and time.monotonic() < deadline:
        time.sleep(.05)
    b.wait("document.querySelector('#create-error').textContent.includes('belum pasti') && !document.querySelector('#create-submit').disabled")
    assert EXT["creates"][0]["key"] and EXT["creates"][0]["key"] == EXT["creates"][1]["key"], EXT["creates"]
    check(b, "Uncertain create keeps the same Idempotency-Key for an unchanged resubmit", "true")
    b.fill("#create-note", "via DM")
    EXT["create_mode"] = "normal"
    b.click("#create-submit")
    b.wait("!document.querySelector('#create-dialog').open && !!document.querySelector('#customer-name')", 10)
    created = EXT["creates"][-1]
    assert created["key"] != EXT["creates"][0]["key"], "Edited form must use a new key"
    assert created["body"] == {"customer_name": "Pembeli Chat", "items": [{"product_id": "bite-chocolate", "topping": "Salted Caramel", "qty": 3}],
                               "wa_number": "6281234567890", "payment_method": "QRIS", "note": "via DM"}, created
    loaded()
    check(b, "Created order opens in detail with server total and appears in list", "document.querySelector('#detail-title').textContent.startsWith('ORD-NEW') && document.querySelector('.detail-total strong').textContent.includes('35.000') && document.querySelector('#order-rows').textContent.includes('Pembeli Chat')")
    b.screenshot("extended-detail-desktop.png")

    # Mobile layout and logout cleanup
    b.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
    b.click("[data-close='detail-dialog']")
    open_order(target["order_id"])
    b.wait("document.querySelectorAll('.proof-thumb img').length === 2")
    check(b, "Mobile detail has no horizontal overflow in the new editors", "[...document.querySelectorAll('#detail-content .detail-editor')].every(s => s.scrollWidth <= s.clientWidth + 1)")
    b.screenshot("extended-detail-mobile.png")
    b.click("#logout")
    check(b, "Logout clears detail, proof viewer and create form", "document.querySelector('#workspace').hidden && !document.querySelector('#detail-content').textContent && !document.querySelector('#proof-view').getAttribute('src') && !document.querySelector('#create-items').textContent && !document.querySelector('dialog[open]')")
    assert not b.errors, b.errors
    check(b, "Extended scenarios have no uncaught exceptions", "true")


def main():
    chrome = os.environ.get("CHROME_PATH") or shutil.which("chrome") or "C:/Program Files/Google/Chrome/Application/chrome.exe"
    if not Path(chrome).is_file():
        raise SystemExit("Chrome not found. Set CHROME_PATH to the browser executable.")
    api_server = ThreadingHTTPServer(("127.0.0.1", 0), ExtendedAPI)
    threading.Thread(target=api_server.serve_forever, daemon=True).start()
    STATE["api_url"] = f"http://127.0.0.1:{api_server.server_port}"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    STATE["origin"] = f"http://127.0.0.1:{server.server_port}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="chrome-ext-", dir=ARTIFACTS)
    process = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", f"--user-data-dir={profile}", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    browser = None
    try:
        port_file = Path(profile) / "DevToolsActivePort"
        deadline = time.monotonic() + 15
        while not port_file.exists() and time.monotonic() < deadline:
            time.sleep(.1)
        if not port_file.exists():
            raise RuntimeError("Headless Chrome did not start; check sandbox permissions.")
        browser = Browser(int(port_file.read_text().splitlines()[0]))
        run(browser, f"http://127.0.0.1:{server.server_port}/")
        (ARTIFACTS / "results-extended.json").write_text(json.dumps({"passed": len(RESULTS), "checks": RESULTS}, indent=2), encoding="utf-8")
        print(f"\n{len(RESULTS)} extended checks passed. Mock contract only; no real backend/DB.", flush=True)
    except Exception:
        if browser:
            browser.screenshot("failure-extended.png")
        raise
    finally:
        if browser:
            try:
                browser.call("Browser.close")
                browser.ws.close()
            except Exception:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
        server.shutdown()
        api_server.shutdown()


if __name__ == "__main__":
    main()
