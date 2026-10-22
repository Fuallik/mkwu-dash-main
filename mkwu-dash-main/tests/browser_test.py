"""Frontend contract tests using real browser fetch and cross-origin HTTP mocks.
No production API, real credentials, backend .env, or database access.
Run: python tests/browser_test.py (Chrome + websocket-client).
"""
import base64
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen
import websocket

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "tests" / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
RESULTS = []
STATE = {"fail": 0, "detail_fail": 0, "mode": "normal", "invalid": False,
         "delete_mode": "normal", "deletes": [],
         "summary_fail": 0, "summary_delay": 0, "list_delay": 0,
         "identity": {"id": "admin", "name": "Admin", "role": "ADMIN"}, "requests": [], "mutations": []}
LOCK = threading.Lock()
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
ORDERS = [{
    "order_id": "ORD-TEST" + ALPHABET[i], "customer_name": f"Fixture Customer {i}",
    "status": ["PENDING", "COMPLETED", "NEEDS_REVIEW", "CANCELLED"][i % 4],
    "wa_number": None, "payment_method": None,
    "total": 35000, "subtotal": 36000, "discount": 1000,
    "created_at": "2026-10-19T06:42:00Z",
    "items": [{"product_name": "Fixture Bite", "topping": "Original", "qty": 3, "unit_price": 12000, "subtotal": 36000}],
} for i in range(18)]


def normalize(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 32 or not re.fullmatch(r"\+?[0-9 ()-]+", value):
        raise ValueError()
    value = re.sub(r"[ ()-]", "", value)
    if value.startswith("+62"):
        value = value[1:]
    elif value.startswith("08"):
        value = "62" + value[1:]
    if not re.fullmatch(r"628[0-9]{7,12}", value):
        raise ValueError()
    return value


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_):
        pass

    def end_headers(self):
        cfg = json.loads((ROOT / "vercel.json").read_text(encoding="utf-8"))
        for h in cfg["headers"][0]["headers"]:
            self.send_header(h["key"], h["value"].replace("https://cheesecake-api-mu.vercel.app", STATE["api_url"]))
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ["/fixture/js/config.js", "/fixture/index.html", "/fixture/"]:
            source = "js/config.js" if path.endswith("config.js") else "index.html"
            content = (ROOT / source).read_text(encoding="utf-8").replace("https://cheesecake-api-mu.vercel.app", STATE["api_url"])
            content = content.replace("REQUEST_TIMEOUT_MS = 15000", "REQUEST_TIMEOUT_MS = 400")
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript" if source.endswith(".js") else "text/html")
            self.end_headers()
            self.wfile.write(content.encode())
            return
        if path.startswith("/fixture/"):
            self.path = self.path.removeprefix("/fixture")
        super().do_GET()


class APIHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200, kind="application/json"):
        body = b"" if status == 204 else json.dumps(data).encode() if kind == "application/json" else data.encode()
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin == STATE.get("origin"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_OPTIONS(self):
        STATE["requests"].append(("OPTIONS", self.path))
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", STATE["origin"])
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret")
        self.end_headers()

    def do_GET(self):
        self.fixture("GET")

    def do_PATCH(self):
        self.fixture("PATCH")

    def do_DELETE(self):
        self.fixture("DELETE")

    def fixture(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        STATE["requests"].append((method, path))
        if method == "DELETE":
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            STATE["deletes"].append({"path": path, "query": query, "body": body.decode(),
                                     "content_type": self.headers.get("Content-Type")})
        assert not self.headers.get("Authorization"), "Bearer must not be sent"
        assert not self.headers.get("Cookie"), "Credentials must be omitted"
        if self.headers.get("X-Admin-Secret") != "test-only":
            return self.reply({}, 401)
        if STATE["fail"]:
            return self.reply("<html>private edge details</html>", STATE["fail"], "text/html")
        if path == "/admin/me":
            return self.reply(STATE["identity"])
        if path == "/admin/summary":
            time.sleep(STATE["summary_delay"])
            if STATE["summary_fail"]:
                return self.reply("private summary diagnostic", STATE["summary_fail"], "text/html")
            return self.reply({"total_orders": len(ORDERS), "total_transaction_value": sum(row["total"] for row in ORDERS), "confirmed_payments": sum(row["status"] == "COMPLETED" for row in ORDERS), "pending_payments": sum(row["status"] == "PENDING" for row in ORDERS)})
        if path == "/admin/orders":
            time.sleep(STATE["list_delay"])
            if STATE["invalid"]:
                return self.reply({"items": [{}], "total": 1, "page": 1, "page_size": 8})
            search = query.get("search", [""])[0].lower().strip()
            status = query.get("status", [""])[0]
            rows = [row for row in ORDERS if search in row["order_id"].lower() and (not status or row["status"] == status)]
            page = int(query.get("page", ["1"])[0])
            size = int(query.get("page_size", ["8"])[0])
            # Contact only belongs in authenticated detail, never in a list row.
            rows = [{k: v for k, v in row.items() if k not in ["wa_number", "subtotal", "discount", "items"]} for row in rows]
            return self.reply({"items": rows[(page-1)*size:page*size], "total": len(rows), "page": page, "page_size": size})
        parts = path.split("/")
        row = next((row for row in ORDERS if len(parts) >= 4 and row["order_id"] == parts[3]), None)
        if row is None:
            return self.reply({}, 404)
        if method == "DELETE":
            mode = STATE["delete_mode"]
            if isinstance(mode, int):
                return self.reply("private delete diagnostic", mode, "text/html")
            if set(query) != {"expected_status"} or len(query["expected_status"]) != 1:
                return self.reply({}, 422)
            expected = query["expected_status"][0]
            if expected not in ["PENDING", "NEEDS_REVIEW", "CANCELLED", "COMPLETED"]:
                return self.reply({}, 422)
            assert not body and not self.headers.get("Content-Type"), "DELETE uses query only"
            with LOCK:
                if mode == "conflict":
                    row["status"] = "COMPLETED"
                if row["status"] == "COMPLETED" or row["status"] != expected:
                    return self.reply({}, 409)
                if mode == "timeout_present":
                    row["status"] = "NEEDS_REVIEW"
                else:
                    ORDERS.remove(row)  # In-memory fixture only; not proof of DB cascade.
            if mode in ["timeout", "timeout_present"]:
                time.sleep(.8)
            elif mode == "slow":
                time.sleep(.18)
            return self.reply(None, 204)
        if method == "GET":
            if STATE["detail_fail"]:
                return self.reply({}, STATE["detail_fail"])
            return self.reply(row)
        operation = parts[-1]
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        STATE["mutations"].append((path, body))
        mode = STATE["mode"]
        if isinstance(mode, int):
            return self.reply("<html>private edge details</html>", mode, "text/html")
        if mode == "html":
            return self.reply("<html>challenge</html>", kind="text/html")
        if mode == "malformed":
            return self.reply({"order": row, "already_confirmed": False})
        field = {"status": "status", "contact": "wa_number", "payment-method": "payment_method"}.get(operation)
        if field is None:
            return self.reply({}, 404)
        expected = "expected_" + field
        if set(body) != {field, expected}:
            return self.reply({}, 422)
        try:
            target = normalize(body[field]) if field == "wa_number" else body[field]
            if field == "status" and target not in ["PENDING", "COMPLETED", "CANCELLED"]:
                raise ValueError()
            if field == "payment_method" and (target not in [None, "QRIS", "CASH"] or body[expected] not in [None, "QRIS", "CASH"]):
                raise ValueError()
        except ValueError:
            return self.reply({}, 422)
        with LOCK:
            if mode == "conflict":
                row[field] = {"status": "CANCELLED", "wa_number": "628999999999", "payment_method": "CASH"}[field]
                return self.reply({}, 409)
            changed = target != body[expected] and row[field] == body[expected]
            if changed:
                row[field] = target
            if not changed and row[field] != target:
                return self.reply({}, 409)
            result = {"order": copy.deepcopy(row), "changed": changed}
        if mode == "slow":
            time.sleep(.18)
        if mode == "timeout":
            time.sleep(.8)  # Committed before client abort; UI must GET before retry.
        return self.reply(result)


class Browser:
    def __init__(self, port):
        pages = json.load(urlopen(f"http://127.0.0.1:{port}/json"))
        page = next(page for page in pages if page["type"] == "page")
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True, timeout=12)
        self.serial = 0
        self.errors = []
        self.call("Runtime.enable")
        self.call("Page.enable")
        self.call("Browser.setDownloadBehavior", {"behavior": "allow", "downloadPath": str(ARTIFACTS)})

    def call(self, method, params=None):
        self.serial += 1
        request_id = self.serial
        self.ws.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            data = json.loads(self.ws.recv())
            if data.get("method") == "Runtime.exceptionThrown":
                self.errors.append(data["params"]["exceptionDetails"])
            if data.get("id") == request_id:
                if "error" in data:
                    raise RuntimeError(data["error"])
                return data.get("result", {})

    def js(self, expression):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in result:
            raise AssertionError(result["exceptionDetails"])
        return result.get("result", {}).get("value")

    def wait(self, expression, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.js(expression):
                return
            time.sleep(.04)
        raise AssertionError(f"Timed out: {expression}")

    def click(self, selector):
        self.js(f"(() => {{const e=document.querySelector({json.dumps(selector)});e.focus();e.click();}})()")

    def fill(self, selector, value, event="input"):
        self.js(f"(() => {{const e=document.querySelector({json.dumps(selector)});e.value={json.dumps(value)};e.dispatchEvent(new Event({json.dumps(event)},{{bubbles:true}}));}})()")

    def goto(self, url):
        self.js("window.__testNavigationPending = true")
        self.call("Page.navigate", {"url": url})
        self.wait("!window.__testNavigationPending && document.readyState === 'complete' && !!document.querySelector('#password')")

    def loaded(self):
        self.wait("!document.querySelector('#workspace').hidden && document.querySelector('#table-region').getAttribute('aria-busy') === 'false' && document.querySelector('#stats').getAttribute('aria-busy') === 'false'")

    def screenshot(self, filename):
        result = self.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True})
        (ARTIFACTS / filename).write_bytes(base64.b64decode(result["data"]))


def check(browser, name, expression):
    assert browser.js(expression), name
    RESULTS.append(name)
    print(f"PASS {name}", flush=True)


def run(browser, base):
    b = browser
    def check_here(name, expr):
        check(b, name, expr)
    def login(password="test-only"):
        b.fill("#password", password)
        b.click("#login-button")
    def detail(index=0):
        b.click("[data-order='" + ORDERS[index]["order_id"] + "']")
        b.wait("!!document.querySelector('#status-save')")
    def status(target="COMPLETED"):
        b.fill("#target-status", target, "change")
        b.click("#status-save")
    def payment(target="QRIS"):
        b.fill("#payment-method", target or "", "change")
        b.click("#payment-save")
    def submit():
        b.click("#merchant-checked")
        b.click("#confirm-submit")
    def saved():
        b.wait("!document.querySelector('#confirm-dialog').open && !!document.querySelector('#status-save') && !document.querySelector('#status-save').disabled")
        b.loaded()
    def failed():
        b.wait("!document.querySelector('#confirm-error').hidden && !document.querySelector('#confirm-cancel').disabled")
    def reload_detail():
        b.click("#retry-detail")
        b.wait("!!document.querySelector('#status-save') && !document.querySelector('#status-save').disabled")

    b.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1100, "deviceScaleFactor": 1, "mobile": False})
    b.goto(base)
    check_here("Locked initially, one password input, no demo/role/export", "document.querySelector('#workspace').hidden && document.querySelectorAll('#login-form input').length === 1 && !document.querySelector('#email, #demo-role, #enter-demo, #export-open, #report-nav')")
    assert not STATE["requests"]
    b.screenshot("access-desktop.png")
    b.goto(base + "fixture/")
    login("wrong")
    b.wait("!document.querySelector('#login-error').hidden")
    check_here("Wrong password leaves UI locked and clears input", "document.querySelector('#workspace').hidden && document.querySelector('#password').value === ''")
    check_here("Failed login clears module credential", "(async()=>{try {await (await import('./js/api.js')).api.me();return false;} catch(e){return e.status===401;}})()")
    STATE["identity"]["role"] = "FINANCE"
    login()
    b.wait("document.querySelector('#login-error').textContent.includes('Struktur')")
    check_here("Unexpected FINANCE identity rejected", "document.querySelector('#workspace').hidden")
    STATE["identity"]["role"] = "ADMIN"
    login()
    b.loaded()
    check_here("GET /admin/me identity and global summary loaded via cross-origin fetch", "document.querySelector('#user-name').textContent === 'Admin' && document.querySelector('#stat-orders').textContent === '18' && document.querySelector('#stat-value').textContent.includes('630.000') && document.querySelectorAll('[data-order]').length === 8")
    check_here("Credential absent from persistent storage and password DOM", "localStorage.length === 0 && sessionStorage.length === 0 && !document.cookie && !document.querySelector('#password').value")
    check_here("Correct summary labels and legacy filter retained", "document.querySelector('#stats').textContent.includes('Nilai semua pesanan') && document.querySelector('#stats').textContent.includes('Sudah dibayar') && !!document.querySelector('#status-filter option[value=NEEDS_REVIEW]')")
    b.screenshot("dashboard-desktop.png")
    b.click("#page-next")
    b.loaded()
    check_here("Pagination second page", "document.querySelector('#page-number').textContent === '2 / 3'")
    b.fill("#search", ORDERS[0]["order_id"].lower())
    b.wait("document.querySelectorAll('[data-order]').length === 1")
    check_here("Case-insensitive search resets page, summary stays global", "document.querySelector('#page-number').textContent === '1 / 1' && document.querySelector('#stat-orders').textContent === '18'")
    b.fill("#status-filter", "COMPLETED", "change")
    b.wait("!document.querySelector('#table-state').hidden")
    check_here("Combined filter empty state", "document.querySelector('#table-state').textContent.includes('Tidak ada pesanan yang cocok')")
    b.click("#reset-filters")
    b.loaded()
    b.fill("#page-size", "16", "change")
    b.loaded()
    check_here("Page size 16", "document.querySelectorAll('[data-order]').length === 16")
    b.fill("#page-size", "8", "change")
    b.loaded()
    original_name = ORDERS[0]["customer_name"]
    ORDERS[0]["customer_name"] = '<img src=x onerror="window.xss=1">'
    b.click("#refresh")
    b.loaded()
    check_here("Stored customer markup escaped in rows", "!window.xss && !document.querySelector('#order-rows img') && document.querySelector('#order-rows').textContent.includes('<img')")
    detail()
    check_here("Detail snapshot, null payment method and escaped markup", "!document.querySelector('#detail-content img') && document.querySelector('#detail-content').textContent.includes('36.000') && document.querySelector('#detail-content').textContent.includes('1.000') && !document.querySelector('#status-save').disabled")
    ORDERS[0]["customer_name"] = original_name
    status()
    check_here("Every status action requires confirmation and defaults focus to cancel", "document.querySelector('#confirm-dialog').open && document.querySelector('#confirm-submit').disabled && document.activeElement.id === 'confirm-cancel'")
    count = len(STATE["mutations"])
    b.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    b.wait("!document.querySelector('#confirm-dialog').open")
    check_here("Escape cancels without mutation and restores focus", "document.querySelector('#detail-dialog').open && document.activeElement.id === 'status-save'")
    assert len(STATE["mutations"]) == count
    STATE["mode"] = "slow"
    status()
    b.click("#merchant-checked")
    b.js("document.querySelector('#confirm-submit').click();document.querySelector('#confirm-submit').click()")
    check_here("In-flight mutation locks submit, close and detail, no optimistic status", "document.querySelector('#confirm-submit').disabled && document.querySelector('#confirm-cancel').disabled && document.querySelector('#status-save').disabled && document.querySelector('#detail-content').textContent.includes('PENDING')")
    saved()
    assert len(STATE["mutations"]) == count + 1
    assert STATE["mutations"][-1][1] == {"status": "COMPLETED", "expected_status": "PENDING"}
    check_here("One PATCH only; status/detail/list/summary refresh after success", "document.querySelector('#target-status').value === 'COMPLETED' && document.querySelector('#detail-content').textContent.includes('Sudah dibayar') && document.querySelector('#stat-confirmed').textContent === '6'")
    STATE["mode"] = "normal"
    for initial in ["PENDING", "COMPLETED", "CANCELLED", "NEEDS_REVIEW"]:
        for target in ["PENDING", "COMPLETED", "CANCELLED"]:
            ORDERS[0]["status"] = initial
            reload_detail()
            status(target)
            submit()
            saved()
            assert STATE["mutations"][-1][1] == {"status": target, "expected_status": initial}
            check_here(f"Status transition {initial} -> {target} with null method", "document.querySelector('#target-status').value === '" + target + "' && document.querySelectorAll('#target-status option[value=NEEDS_REVIEW]').length === 0")
    status("CANCELLED")
    submit()
    saved()
    check_here("Idempotent changed=false handled", "document.querySelector('#toasts').textContent.includes('tanpa perubahan')")

    check_here("Payment dropdown maps all three values and explains manual payment verification", "JSON.stringify([...document.querySelector('#payment-method').options].map(o=>[o.value,o.textContent])) === JSON.stringify([['','Belum ditentukan'],['QRIS','QRIS'],['CASH','Tunai']]) && document.querySelector('#payment-method').value === '' && document.querySelector('#saved-payment-method').textContent === 'Belum ditentukan' && document.querySelector('#payment-note').textContent.includes('manual')")
    count = len(STATE["mutations"])
    payment()
    check_here("Payment confirmation starts unchecked and focuses cancel", "document.querySelector('#confirm-title').textContent === 'Simpan metode pembayaran?' && document.querySelector('#confirm-description').textContent.includes('Belum ditentukan → QRIS') && document.querySelector('#confirm-submit').disabled && document.activeElement.id === 'confirm-cancel'")
    b.click("#confirm-cancel")
    check_here("Cancel payment keeps draft without PATCH", "!document.querySelector('#confirm-dialog').open && document.querySelector('#payment-method').value === 'QRIS'")
    assert len(STATE["mutations"]) == count
    STATE["mode"] = "slow"
    b.fill("#wa-number", "081211111111")
    b.fill("#target-status", "PENDING", "change")
    payment()
    b.click("#merchant-checked")
    b.js("document.querySelector('#confirm-submit').click();document.querySelector('#confirm-submit').click();document.querySelector('#status-save').click();document.querySelector('#contact-save').click()")
    check_here("Payment in flight locks every editor and prevents concurrent saves", "['payment-save','status-save','contact-save','contact-clear','payment-method','target-status','wa-number'].every(id=>document.getElementById(id).disabled) && document.querySelector('#confirm-cancel').disabled")
    saved()
    assert len(STATE["mutations"]) == count + 1
    assert STATE["mutations"][-1][1] == {"payment_method": "QRIS", "expected_payment_method": None}
    assert ORDERS[0]["status"] == "CANCELLED" and ORDERS[0]["wa_number"] is None
    check_here("Payment save preserves contact draft, discards status draft with notice and refreshes labels", "document.querySelector('#wa-number').value === '081211111111' && document.querySelector('#contact-note').textContent.includes('dipertahankan') && document.querySelector('#target-status').value === 'CANCELLED' && document.querySelector('#saved-payment-method').textContent === 'QRIS' && document.querySelector('#order-rows .method').textContent === 'QRIS' && document.querySelector('#toasts').textContent.includes('Draft status')")
    STATE["mode"] = "normal"
    labels = {None: "Belum ditentukan", "QRIS": "QRIS", "CASH": "Tunai"}
    for initial in [None, "QRIS", "CASH"]:
        for target in [None, "QRIS", "CASH"]:
            ORDERS[0]["payment_method"] = initial
            reload_detail()
            check_here(f"Payment editor initialized from GET {initial}", "document.querySelector('#payment-method').value === " + json.dumps(initial or ""))
            unchanged = {k: copy.deepcopy(v) for k, v in ORDERS[0].items() if k != "payment_method"}
            payment(target)
            submit()
            saved()
            assert STATE["mutations"][-1][1] == {"payment_method": target, "expected_payment_method": initial}
            assert {k: v for k, v in ORDERS[0].items() if k != "payment_method"} == unchanged
            check_here(f"Payment {initial} -> {target}: detail/list label refreshed, other fields unchanged in mock", "document.querySelector('#saved-payment-method').textContent === " + json.dumps(labels[target]) + " && document.querySelector('#order-rows .method').textContent === " + json.dumps(labels[target]))
            if initial == target:
                check_here(f"Payment {target} no-op changed=false", "document.querySelector('#toasts').textContent.includes('tanpa perubahan')")

    # An unsaved payment choice must never be included in status/contact writes.
    payment_draft = "QRIS" if ORDERS[0]["payment_method"] != "QRIS" else "CASH"
    b.fill("#payment-method", payment_draft, "change")
    status("PENDING")
    submit()
    saved()
    assert ORDERS[0]["payment_method"] == "CASH"
    check_here("Status save does not save payment draft and warns on discard", "document.querySelector('#payment-method').value === 'CASH' && document.querySelector('#toasts').textContent.includes('Draft metode pembayaran')")
    b.fill("#payment-method", "QRIS", "change")
    b.fill("#wa-number", "081234567890")
    b.click("#contact-save")
    submit()
    saved()
    assert ORDERS[0]["payment_method"] == "CASH"
    check_here("Contact save does not save payment draft and warns on discard", "document.querySelector('#payment-method').value === 'CASH' && document.querySelector('#toasts').textContent.includes('Draft metode pembayaran')")

    # Another admin changes payment after this browser's last GET.
    ORDERS[0]["payment_method"] = None
    reload_detail()
    payment("QRIS")
    ORDERS[0]["payment_method"] = "CASH"
    submit()
    failed()
    assert STATE["mutations"][-1][1] == {"payment_method": "QRIS", "expected_payment_method": None}
    assert ORDERS[0]["payment_method"] == "CASH"
    b.click("#confirm-cancel")
    reload_detail()
    check_here("Stale payment CAS cannot overwrite another admin and GET sets new expected value", "document.querySelector('#payment-method').value === 'CASH'")
    payment("QRIS")
    ORDERS[0]["payment_method"] = "QRIS"
    submit()
    saved()
    check_here("Stale payment already at target is idempotent", "document.querySelector('#toasts').textContent.includes('tanpa perubahan')")

    # Concurrent fixture requests exercise adapter CAS payloads, not Supabase locking.
    ORDERS[1]["payment_method"] = None
    outcomes = b.js("(async()=>{const {api}=await import('./js/api.js'); return await Promise.all(['QRIS','CASH'].map(target=>api.paymentMethod(" + json.dumps(ORDERS[1]["order_id"]) + ",target,null).then(r=>r.changed?'changed':'unchanged',e=>e.status)));})()")
    assert sorted(map(str, outcomes)) == ["409", "changed"], outcomes
    check_here("Concurrent payment requests: one success and one conflict in locked HTTP fixture", "true")
    ORDERS[1]["payment_method"] = None
    ORDERS[0]["payment_method"] = None
    reload_detail()

    for value in ["081234567890", "+62 (812) 3456-7891", "6281234567892"]:
        expected = ORDERS[0]["wa_number"]
        b.fill("#wa-number", value)
        b.click("#contact-save")
        submit()
        saved()
        assert STATE["mutations"][-1][1] == {"wa_number": normalize(value), "expected_wa_number": expected}
        check_here("Contact normalization " + value + " and safe saved chat link", "document.querySelector('#wa-number').value === '" + normalize(value) + "' && document.querySelector('#wa-chat').href === 'https://wa.me/" + normalize(value) + "' && document.querySelector('#wa-chat').rel.includes('noreferrer')")
    for value in ["", "   ", "javascript:alert(1)", "62812345<script>", "081234567890 ext1", "\uff18\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18\uff19\uff10", "0"*33]:
        count = len(STATE["mutations"])
        b.fill("#wa-number", value)
        b.click("#contact-save")
        check_here("Invalid contact rejected: " + ascii(value), "!document.querySelector('#contact-error').hidden && !document.querySelector('#confirm-dialog').open")
        assert len(STATE["mutations"]) == count
    b.fill("#wa-number", ORDERS[0]["wa_number"])
    b.click("#contact-clear")
    check_here("Clearing contact requires explicit confirmation", "document.querySelector('#confirm-description').textContent.includes('Kosongkan') && document.querySelector('#confirm-submit').disabled")
    count = len(STATE["mutations"])
    b.click("#confirm-cancel")
    assert len(STATE["mutations"]) == count
    b.click("#contact-clear")
    submit()
    saved()
    assert STATE["mutations"][-1][1]["wa_number"] is None
    check_here("Contact cleared to null, chat link removed", "!document.querySelector('#wa-chat') && document.querySelector('#wa-number').value === ''")
    ORDERS[0]["wa_number"] = ' +62 812-3456-7890 '
    reload_detail()
    check_here("Legacy contact stays exact and has no chat URL", "document.querySelector('#wa-number').value === ' +62 812-3456-7890 ' && !document.querySelector('#wa-chat')")
    b.fill("#wa-number", "081234567890")
    b.click("#contact-save")
    submit()
    saved()
    assert STATE["mutations"][-1][1]["expected_wa_number"] == ' +62 812-3456-7890 '
    check_here("Legacy expected value sent unchanged", "document.querySelector('#wa-chat').href === 'https://wa.me/6281234567890'")
    b.fill("#wa-number", "081277777777")
    status("PENDING")
    submit()
    saved()
    check_here("Status save preserves unsaved contact draft and explains it", "document.querySelector('#wa-number').value === '081277777777' && document.querySelector('#contact-note').textContent.includes('dipertahankan')")
    STATE["mode"] = "slow"
    count = len(STATE["mutations"])
    b.click("#contact-save")
    b.click("#merchant-checked")
    b.js("document.querySelector('#confirm-submit').click();document.querySelector('#confirm-submit').click()")
    saved()
    assert len(STATE["mutations"]) == count + 1
    check_here("Contact double submit sends one PATCH and refreshes canonical value", "document.querySelector('#wa-number').value === '6281277777777'")
    STATE["mode"] = "normal"

    for operation in ["status", "contact", "payment"]:
        for mode in ["conflict", "timeout", 404, 422, 500, 429, 413, 503, "html", "malformed"]:
            STATE["mode"] = mode
            if operation == "status":
                status("COMPLETED")
            elif operation == "contact":
                b.fill("#wa-number", "081234567891")
                b.click("#contact-save")
            else:
                ORDERS[0]["payment_method"] = None
                reload_detail()
                b.fill("#wa-number", "081299999999")
                payment("QRIS")
            count = len(STATE["mutations"])
            submit()
            failed()
            check_here(f"{operation} {mode}: locked until GET, no unsafe error echo", "document.querySelector('#confirm-submit').disabled && document.querySelector('#merchant-checked').disabled && document.querySelector('#payment-save').disabled && document.querySelector('#status-save').disabled && document.querySelector('#contact-save').disabled && !document.querySelector('#retry-detail').disabled && !document.querySelector('#confirm-error').textContent.includes('private edge')")
            time.sleep(.15)
            assert len(STATE["mutations"]) == count + 1, "No automatic PATCH retry"
            b.click("#confirm-cancel")
            # Failed refresh must not unlock mutations.
            STATE["detail_fail"] = 503
            b.click("#retry-detail")
            b.wait("!!document.querySelector('#retry-detail') && !document.querySelector('.details-loading')")
            check_here(f"{operation} {mode}: failed GET stays locked", "!document.querySelector('#status-save') && !!document.querySelector('#retry-detail')")
            STATE["detail_fail"] = 0
            STATE["mode"] = "normal"
            reload_detail()
            if operation == "contact":
                check_here(f"Contact {mode}: unsaved draft retained with notice", "document.querySelector('#wa-number').value === '081234567891' && document.querySelector('#contact-note').textContent.includes('dipertahankan')")
            if operation == "payment":
                check_here(f"Payment {mode}: contact draft retained after failed GET and recovery", "document.querySelector('#wa-number').value === '081299999999' && document.querySelector('#contact-note').textContent.includes('dipertahankan')")
            if mode == "timeout":
                assert ORDERS[0][{"status": "status", "contact": "wa_number", "payment": "payment_method"}[operation]] == {"status": "COMPLETED", "contact": "6281234567891", "payment": "QRIS"}[operation]
    # Two tabs: external edit changes stored value; fixture CAS must reject stale expected.
    b.fill("#wa-number", "081222222222")
    b.click("#contact-save")
    previous = ORDERS[0]["wa_number"]
    ORDERS[0]["wa_number"] = "628333333333"
    submit()
    failed()
    assert STATE["mutations"][-1][1]["expected_wa_number"] == previous
    assert ORDERS[0]["wa_number"] == "628333333333"
    b.click("#confirm-cancel")
    reload_detail()
    check_here("Stale contact CAS cannot overwrite other tab; draft and new snapshot shown", "document.querySelector('#wa-number').value === '081222222222' && document.querySelector('#saved-wa').textContent === '628333333333'")
    b.click("#detail-dialog [data-close]")
    b.wait("!document.querySelector('#detail-dialog').open && !document.querySelector('#detail-content').textContent")
    check_here("Closing unsaved draft warns user and removes sensitive detail DOM", "document.querySelector('#toasts').textContent.includes('ditinggalkan') && !document.querySelector('#detail-content').textContent")
    for width in [1024, 768, 390, 320]:
        b.call("Emulation.setDeviceMetricsOverride", {"width": width, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        check_here(f"Responsive {width}px no document overflow", "document.documentElement.scrollWidth <= innerWidth")
        detail()
        check_here(f"Responsive detail {width}px within viewport", "document.querySelector('#detail-dialog').getBoundingClientRect().right <= innerWidth && document.querySelector('#detail-dialog').getBoundingClientRect().left >= 0")
        if width == 390:
            b.screenshot("detail-mobile.png")
        b.click("#detail-dialog [data-close]")
    STATE["summary_delay"] = .3
    b.click("#refresh")
    b.wait("document.querySelector('#table-region').getAttribute('aria-busy') === 'false'")
    check_here("List becomes available while summary is still loading", "document.querySelectorAll('[data-order]').length === 8 && document.querySelector('#stats').getAttribute('aria-busy') === 'true'")
    b.loaded()
    STATE["summary_delay"] = 0
    for code in [503, 429, 200]:
        STATE["summary_fail"] = code
        b.click("#refresh")
        b.loaded()
        check_here(f"Summary {code} failure keeps rows, pagination and own sanitized error", "document.querySelectorAll('[data-order]').length === 8 && document.querySelector('#table-state').hidden && document.querySelector('#stat-orders').textContent === 'Tidak tersedia' && document.querySelector('#summary-error').textContent.includes('Statistik tidak tersedia') && !document.querySelector('#summary-error').textContent.includes('private summary') && !document.querySelector('#page-next').disabled")
        b.click("#page-next")
        b.loaded()
        check_here(f"Summary {code} does not prevent list pagination", "document.querySelector('#page-number').textContent === '2 / 3'")
        b.click("#page-prev")
        b.loaded()
        detail()
        check_here(f"Summary {code} does not prevent order detail", "!!document.querySelector('#payment-save') && !document.querySelector('#payment-save').disabled")
        b.click("#detail-dialog [data-close]")
    STATE["summary_fail"] = 0
    b.click("#refresh")
    b.loaded()
    check_here("Summary recovery clears its independent error", "document.querySelector('#summary-error').hidden && document.querySelector('#stat-orders').textContent === '18'")

    detail()
    payment("CASH")
    STATE["detail_fail"] = 503
    submit()
    b.wait("!document.querySelector('#confirm-dialog').open && !!document.querySelector('#retry-detail') && !document.querySelector('.details-loading')")
    b.loaded()
    check_here("Successful payment with failed GET still requires a successful detail refresh", "!document.querySelector('#payment-save') && document.querySelector('#order-rows .method').textContent === 'Tunai'")
    STATE["detail_fail"] = 0
    reload_detail()
    check_here("Recovery GET uses committed payment value", "document.querySelector('#payment-method').value === 'CASH'")
    b.click("#detail-dialog [data-close]")
    STATE["invalid"] = True
    b.click("#refresh")
    b.wait("!!document.querySelector('#retry-load')")
    b.loaded()
    check_here("Malformed list rejected while independently successful summary remains available", "document.querySelector('#stat-orders').textContent === '18' && document.querySelector('#table-state').textContent.includes('Struktur')")
    STATE["invalid"] = False
    b.click("#retry-load")
    b.loaded()
    for code, message in [(429, "Terlalu banyak"), (413, "Ukuran input"), (503, "sementara"), (200, "bukan JSON")]:
        STATE["fail"] = code
        b.click("#refresh")
        b.wait("!!document.querySelector('#retry-load') && !document.querySelector('#table-state').hidden && document.querySelector('#table-region').getAttribute('aria-busy') === 'false'")
        b.loaded()
        check_here(f"List edge {code}: sanitized manual retry feedback", "document.querySelector('#table-state').textContent.includes('" + message + "') && document.querySelector('#stat-orders').textContent === 'Tidak tersedia'")
        count = len(STATE["requests"])
        time.sleep(.15)
        assert len(STATE["requests"]) == count, "No automatic retries or summary polling"
        STATE["fail"] = 0
        b.click("#retry-load")
        b.loaded()
    detail()
    STATE["fail"] = 401
    b.click("#retry-detail")
    b.wait("!document.querySelector('#access-screen').hidden")
    check_here("401 clears credential, customer rows, contacts and dialogs", "document.querySelector('#workspace').hidden && !document.querySelector('#order-rows').textContent && !document.querySelector('#detail-content').textContent && !document.querySelector('dialog[open]')")
    STATE["fail"] = 0
    login()
    b.loaded()
    # Summary authentication failure must lock the UI even with a late list.
    for code in [401, 403]:
        STATE["summary_fail"] = code
        STATE["list_delay"] = .15
        b.click("#refresh")
        b.wait("document.querySelector('#workspace').hidden")
        time.sleep(.2)
        check_here(f"Summary {code} locks dashboard and late list cannot restore sensitive DOM", "!document.querySelector('#order-rows').textContent && !document.querySelector('#detail-content').textContent && document.querySelector('#summary-error').hidden && document.querySelector('#stat-orders').textContent === '—'")
        STATE["summary_fail"] = 0
        STATE["list_delay"] = 0
        login()
        b.loaded()
    detail()
    b.fill("#wa-number", "081288888888")
    payment("QRIS")
    STATE["mode"] = 401
    submit()
    b.wait("document.querySelector('#workspace').hidden")
    check_here("Payment 401 clears all editor drafts, confirmation, rows and credential", "!document.querySelector('#detail-content').textContent && !document.querySelector('#confirm-summary').textContent && !document.querySelector('#confirm-description').textContent && !document.querySelector('dialog[open]') && !document.querySelector('#order-rows').textContent && !document.querySelector('#toasts').textContent")
    STATE["mode"] = "normal"
    login()
    b.loaded()
    count = len(STATE["requests"])
    detail()
    b.fill("#wa-number", "081288888888")
    b.fill("#payment-method", "CASH", "change")
    b.fill("#target-status", "CANCELLED", "change")
    count = len(STATE["requests"])
    b.click("#logout")
    check_here("Logout clears credential and all sensitive editor drafts without fake server session/logout", "document.querySelector('#workspace').hidden && !document.querySelector('#order-rows').textContent && !document.querySelector('#confirm-summary').textContent && !document.querySelector('#detail-content').textContent && !document.querySelector('#toasts').textContent && !document.querySelector('dialog[open]')")
    time.sleep(.15)
    assert len(STATE["requests"]) == count
    login()
    b.loaded()
    b.goto(base + "fixture/")
    check_here("Reload starts locked with empty private DOM and no password", "document.querySelector('#workspace').hidden && !document.querySelector('#order-rows').textContent.trim() && !document.querySelector('#password').value")
    check_here("Reload removed module credential", "(async()=>{try{await (await import('./js/api.js')).api.me();return false;}catch(e){return e.status===401;}})()")
    check_here("CSP allows assets and concrete cross-origin API without unsafe script", """(async()=>{const r=await fetch('./');const c=r.headers.get('Content-Security-Policy');return c.includes("script-src 'self'") && !c.includes('unsafe-') && c.includes("frame-ancestors 'none'") && r.headers.get('X-Content-Type-Options')==='nosniff' && r.headers.get('Referrer-Policy')==='no-referrer' && r.headers.get('Cache-Control')==='no-store' && !!document.querySelector('.brand img').naturalWidth;})()""")
    check_here("CSP blocks unlisted connections", "(async()=>{try{await fetch('https://example.invalid/private');return false;}catch{return true;}})()")
    assert any(method == "OPTIONS" for method, path in STATE["requests"]), "Cross-origin preflight exercised"
    assert all(path.startswith("/admin/") for method, path in STATE["requests"])
    assert not any("/auth/" in path or "confirm-payment" in path or "export" in path for method, path in STATE["requests"])
    assert not b.errors, b.errors
    check_here("No uncaught browser exceptions", "true")


def run_delete(browser, base):
    """Exercise the reachable UI, using only orders in the HTTP fixture."""
    b = browser
    original = copy.deepcopy(ORDERS)
    victim = copy.deepcopy(original[0])
    survivor = copy.deepcopy(original[1])

    def setup(status="PENDING", rows=None):
        STATE.update(fail=0, detail_fail=0, mode="normal", delete_mode="normal",
                     summary_fail=0, summary_delay=0, list_delay=0)
        victim["status"] = status
        ORDERS[:] = copy.deepcopy(rows if rows is not None else [victim, survivor])
        b.goto(base + "fixture/")
        b.fill("#password", "test-only")
        b.click("#login-button")
        b.loaded()

    def open_order(order_id=None):
        b.click("[data-order='" + (order_id or victim["order_id"]) + "']")
        b.wait("!!document.querySelector('#status-save')")

    def begin():
        check(b, "Reachable Hapus pesanan button in loaded order detail",
              "document.querySelector('#order-delete').textContent === 'Hapus pesanan' && !document.querySelector('#order-delete').disabled")
        b.click("#order-delete")
        b.wait("document.querySelector('#confirm-dialog').open")

    def confirm(order_id=None):
        b.fill("#delete-order-id", order_id or victim["order_id"])
        b.click("#confirm-submit")

    def deleted():
        b.wait("!document.querySelector('#detail-dialog').open && !document.querySelector('#confirm-dialog').open && document.querySelector('#delete-order-id').value === ''")
        b.loaded()

    def latest_delete(order_id, status):
        assert STATE["deletes"][-1] == {"path": "/admin/orders/" + order_id,
            "query": {"expected_status": [status]}, "body": "", "content_type": None}

    for status in ["PENDING", "NEEDS_REVIEW", "CANCELLED"]:
        setup(status)
        open_order()
        # Draft editors must not alter the expected value from the last GET.
        b.fill("#target-status", "COMPLETED", "change")
        b.fill("#payment-method", "CASH", "change")
        b.fill("#wa-number", "081211111111")
        before = len(STATE["deletes"])
        start = len(STATE["requests"])
        begin()
        check(b, f"Delete {status}: permanent item deletion warning and exact ID confirmation",
              "document.querySelector('#confirm-description').textContent.includes('rincian item') && document.querySelector('#confirm-description').textContent.includes('permanen') && !document.querySelector('#delete-confirmation').hidden && document.querySelector('#merchant-confirmation').hidden && document.querySelector('#confirm-submit').disabled && document.activeElement.id === 'confirm-cancel'")
        for value in ["", victim["order_id"].lower(), " " + victim["order_id"], victim["order_id"] + " ", "ORD-WRONG"]:
            b.fill("#delete-order-id", value)
            b.click("#confirm-submit")
            assert b.js("document.querySelector('#confirm-submit').disabled")
            assert len(STATE["deletes"]) == before
        b.fill("#delete-order-id", victim["order_id"])
        check(b, f"Delete {status}: exact Order ID enables destructive confirmation",
              "!document.querySelector('#confirm-submit').disabled")
        b.click("#confirm-cancel")
        b.wait("!document.querySelector('#confirm-dialog').open && document.querySelector('#delete-order-id').value === ''")
        assert len(STATE["deletes"]) == before
        check(b, f"Delete {status}: cancellation keeps order and clears typed ID",
              "document.querySelector('#detail-dialog').open && !document.querySelector('#confirm-dialog').open && document.querySelector('#delete-order-id').value === ''")
        begin()
        STATE["delete_mode"] = "slow"
        b.fill("#delete-order-id", victim["order_id"])
        b.js("document.querySelector('#confirm-submit').click();document.querySelector('#confirm-submit').click();document.querySelector('#status-save').click();document.querySelector('#payment-save').click();document.querySelector('#contact-save').click()")
        check(b, f"Delete {status}: double submit and competing editor actions are locked",
              "['order-delete','status-save','payment-save','contact-save','delete-order-id','confirm-submit','confirm-cancel'].every(id=>document.getElementById(id).disabled)")
        deleted()
        assert len(STATE["deletes"]) == before + 1
        latest_delete(victim["order_id"], status)
        assert ORDERS == [survivor]
        calls = STATE["requests"][start:]
        assert ("GET", "/admin/orders") in calls and ("GET", "/admin/summary") in calls
        assert not any(method == "PATCH" for method, path in calls)
        check(b, f"Delete {status}: one query-only DELETE, real empty 204, detail closed and list/summary refreshed",
              "document.querySelectorAll('[data-order]').length === 1 && document.querySelector('#stat-orders').textContent === '1' && !document.querySelector('#detail-content').textContent && !document.querySelector('#delete-order-id').value && document.querySelector('#toasts').textContent.includes('dihapus permanen')")

    setup()
    open_order()
    b.js("window.__staleDeleteButton = document.querySelector('#order-delete')")
    ORDERS[0]["status"] = "COMPLETED"
    b.click("#retry-detail")
    b.wait("document.querySelector('#target-status')?.value === 'COMPLETED'")
    before = len(STATE["deletes"])
    b.js("window.__staleDeleteButton.click();window.__staleDeleteButton=null")
    check(b, "COMPLETED has no delete button and retained old handler is guarded",
          "!document.querySelector('#order-delete') && !document.querySelector('#confirm-dialog').open")
    assert len(STATE["deletes"]) == before

    setup()
    open_order()
    begin()
    # Status changes in another admin session after the last detail GET.
    ORDERS[0]["status"] = "COMPLETED"
    before = len(STATE["deletes"])
    confirm()
    b.wait("!document.querySelector('#confirm-error').hidden && !document.querySelector('#confirm-cancel').disabled")
    latest_delete(victim["order_id"], "PENDING")
    check(b, "Delete conflict locks deletion and all editor mutations until GET succeeds",
          "document.querySelector('#confirm-submit').disabled && document.querySelector('#order-delete').disabled && document.querySelector('#status-save').disabled && document.querySelector('#payment-save').disabled && document.querySelector('#contact-save').disabled && !document.querySelector('#retry-detail').disabled")
    assert len(STATE["deletes"]) == before + 1
    b.click("#confirm-cancel")
    STATE["detail_fail"] = 503
    b.click("#retry-detail")
    b.wait("!!document.querySelector('#retry-detail') && !document.querySelector('.details-loading')")
    check(b, "Delete conflict: unsuccessful refresh cannot restore mutation buttons",
          "!document.querySelector('#status-save, #order-delete')")
    STATE["detail_fail"] = 0
    b.click("#retry-detail")
    b.wait("document.querySelector('#target-status')?.value === 'COMPLETED'")
    check(b, "Delete conflict: successful GET shows latest COMPLETED status and no delete",
          "!document.querySelector('#order-delete') && !document.querySelector('#status-save').disabled")

    for mode in ["timeout", "timeout_present"]:
        setup()
        open_order()
        b.fill("#wa-number", "081299999999")
        begin()
        STATE["delete_mode"] = mode
        before = len(STATE["deletes"])
        start = len(STATE["requests"])
        confirm()
        if mode == "timeout":
            deleted()
            check(b, "Delete timeout after commit: recovery GET 404 closes detail and refreshes list",
                  "document.querySelectorAll('[data-order]').length === 1 && document.querySelector('#stat-orders').textContent === '1' && document.querySelector('#toasts').textContent.includes('sudah tidak ada')")
        else:
            b.wait("!document.querySelector('#confirm-dialog').open && document.querySelector('#detail-content').textContent.includes('NEEDS_REVIEW') && !!document.querySelector('#status-save') && !document.querySelector('#status-save').disabled")
            check(b, "Delete timeout without commit: recovery GET shows latest data and preserves contact draft",
                  "document.querySelector('#wa-number').value === '081299999999' && document.querySelector('#contact-note').textContent.includes('dipertahankan') && !!document.querySelector('#order-delete') && document.querySelector('#toasts').textContent.includes('belum pasti')")
        time.sleep(.15)
        assert len(STATE["deletes"]) == before + 1, "Never retry DELETE after timeout"
        calls = STATE["requests"][start:]
        assert ("GET", "/admin/orders/" + victim["order_id"]) in calls
        assert sum(method == "DELETE" for method, path in calls) == 1
        check(b, f"Delete {mode}: one DELETE followed by detail GET, no automatic retry", "true")

    setup()
    open_order()
    begin()
    STATE["detail_fail"] = 503
    STATE["delete_mode"] = "timeout_present"
    before = len(STATE["deletes"])
    confirm()
    b.wait("!document.querySelector('#confirm-dialog').open && !!document.querySelector('#retry-detail') && !document.querySelector('.details-loading')")
    check(b, "Delete timeout with failed recovery GET leaves every mutation unavailable",
          "!document.querySelector('#status-save, #order-delete')")
    STATE["detail_fail"] = 0
    b.click("#retry-detail")
    b.wait("document.querySelector('#detail-content').textContent.includes('NEEDS_REVIEW') && !!document.querySelector('#status-save')")
    assert len(STATE["deletes"]) == before + 1

    setup()
    open_order()
    begin()
    ORDERS.pop(0)  # Another admin removed it after this detail was read.
    confirm()
    deleted()
    check(b, "Missing order during DELETE is verified with GET 404 and removed from screen",
          "document.querySelectorAll('[data-order]').length === 1 && document.querySelector('#stat-orders').textContent === '1'")

    setup(rows=[copy.deepcopy(row) for row in original[:9]])
    ORDERS[-1]["status"] = "CANCELLED"
    last_id = ORDERS[-1]["order_id"]
    b.click("#page-next")
    b.loaded()
    check(b, "Delete pagination setup: last page contains exactly one order",
          "document.querySelector('#page-number').textContent === '2 / 2' && document.querySelectorAll('[data-order]').length === 1")
    open_order(last_id)
    begin()
    confirm(last_id)
    deleted()
    latest_delete(last_id, "CANCELLED")
    check(b, "Deleting last row corrects pagination and reloads previous valid page plus summary",
          "document.querySelector('#page-number').textContent === '1 / 1' && document.querySelectorAll('[data-order]').length === 8 && document.querySelector('#stat-orders').textContent === '8' && document.querySelector('#page-next').disabled")

    setup()
    open_order()
    begin()
    STATE["delete_mode"] = 401
    confirm()
    b.wait("document.querySelector('#workspace').hidden")
    check(b, "Delete 401 clears credential, rows, details, typed ID and confirmation",
          "!document.querySelector('#order-rows').textContent && !document.querySelector('#detail-content').textContent && !document.querySelector('#delete-order-id').value && !document.querySelector('#confirm-summary').textContent && !document.querySelector('dialog[open]')")
    check(b, "Delete 401 leaves adapter without credential",
          "(async()=>{try{await(await import('./js/api.js')).api.me();return false;}catch(e){return e.status===401;}})()")

    setup()
    open_order()
    begin()
    b.fill("#delete-order-id", victim["order_id"])
    before = len(STATE["deletes"])
    b.click("#logout")
    check(b, "Logout during delete confirmation clears typed ID without sending DELETE",
          "document.querySelector('#workspace').hidden && !document.querySelector('#delete-order-id').value && !document.querySelector('#detail-content').textContent && !document.querySelector('#confirm-summary').textContent")
    assert len(STATE["deletes"]) == before
    assert not b.errors, b.errors
    ORDERS[:] = original
    check(b, "Delete browser scenarios have no uncaught exceptions", "true")


def main():
    chrome = os.environ.get("CHROME_PATH") or shutil.which("chrome") or "C:/Program Files/Google/Chrome/Application/chrome.exe"
    if not Path(chrome).is_file():
        raise SystemExit("Chrome not found. Set CHROME_PATH to the browser executable.")
    api_server = ThreadingHTTPServer(("127.0.0.1", 0), APIHandler)
    threading.Thread(target=api_server.serve_forever, daemon=True).start()
    STATE["api_url"] = f"http://127.0.0.1:{api_server.server_port}"
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    STATE["origin"] = f"http://127.0.0.1:{server.server_port}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    profile = tempfile.mkdtemp(prefix="chrome-test-", dir=ARTIFACTS)
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
        run_delete(browser, f"http://127.0.0.1:{server.server_port}/")
        (ARTIFACTS / "results.json").write_text(json.dumps({"passed": len(RESULTS), "checks": RESULTS}, indent=2), encoding="utf-8")
        print(f"\n{len(RESULTS)} checks passed. HTTP static frontend + cross-origin mock contract only; no real backend/DB.", flush=True)
    except Exception:
        if browser:
            browser.screenshot("failure.png")
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
        # Keep profile in ignored test artifacts; no recursive filesystem deletion.


if __name__ == "__main__":
    main()
