# Hasil tes dashboard

## Update 22 Oktober 2026 — CRUD per pesanan dan bukti pembayaran

| Perintah | Hasil | Batas cakupan |
| --- | --- | --- |
| `node --test tests/api.test.mjs` | **20 tests passed, 0 failed** (15 lama + 5 baru) | Fetch mock |
| `python tests/browser_test.py` | **240 checks passed** (regresi, tidak ada yang berubah) | Chromium headless, mock lintas origin |
| `python tests/browser_extended_test.py` | **34 checks passed** | Chromium headless, mock kontrak tambahan |

Runtime: Linux, Node v22, Python 3, Chromium headless (Playwright build) dengan `--no-sandbox` lewat `CHROME_PATH` wrapper karena dijalankan sebagai root di container.

Cakupan baru: validasi field opsional `note`/`payment_proofs`/`product_id`/`proof_count`; payload CAS nama, catatan, item; POST pesanan dengan `Idempotency-Key` (kunci sama untuk simpan ulang tanpa perubahan, kunci baru setelah form diubah); katalog publik tanpa secret; upload/ganti foto mengirim JPEG mentah hasil kompresi (magic bytes FFD8FF, ≤1,5 MiB) sebagai request terpisah; DELETE foto 204; foto hanya dibaca bila Content-Type gambar raster; thumbnail dan viewer memakai `blob:` URL; tolak foto melebihi sisa slot tanpa request; error upload mengunci editor sampai detail dimuat ulang; pesanan COMPLETED mengunci editor item; detail tanpa field baru menampilkan pemberitahuan backend; layout 390 px tanpa overflow; logout membersihkan detail, viewer, dan form.

Batas: backend belum mengimplementasikan endpoint tambahan, jadi seluruh fitur baru hanya terbukti terhadap mock. Supabase Storage, migration, idempotency server, transaksi penggantian item, dan batas upload Vercel belum diverifikasi.

## Run 20 Oktober 2026

## Hasil aktual

| Perintah/pemeriksaan | Hasil | Batas cakupan |
| --- | --- | --- |
| `node --test tests/api.test.mjs` | **15 tests passed, 0 failed**, exit 0 | Fetch mock; tanpa backend/DB |
| `python tests/browser_test.py` | **240 checks passed**, exit 0 | Chrome headless, fetch nyata ke dua HTTP server mock lintas origin |
| `node --check` untuk api/auth/config/config.example/dashboard/utils | **6 file lulus**, exit 0 | Sintaks ES module |
| Pemeriksaan screenshot detail mobile | Editor pembayaran mengikuti desain existing | Screenshot dari fixture, bukan deployment |

Runtime: Windows, Node v24.19.0, Python 3.13.7, Chrome headless dan websocket-client existing. Tidak menambah dependency.

Baseline dashboard sebelumnya lulus 195 checks. Pada pengembangan tes hapus, assertion pembatalan sempat membaca input konfirmasi sebelum browser mengirim event close dialog. Helper tes diperbaiki agar menunggu dialog tertutup dan input ID dibersihkan. Run final lulus 240 checks, termasuk 45 pemeriksaan alur hapus yang baru. Tidak ada kegagalan tersisa pada perintah final di atas.

## Cakupan

- Adapter menerima QRIS/CASH/null pada list, detail, dan envelope seluruh mutation. Nilai respons invalid (termasuk string kosong, Tunai, lowercase, angka, boolean, object, array) dan field metode hilang ditolak.
- Seluruh sembilan kombinasi target/expected pembayaran mengirim tepat dua field kontrak, termasuk null eksplisit. Header X-Admin-Secret, credentials omit, cache no-store, redirect error tetap dipakai. Tanpa credential tidak mengirim request.
- Timeout adapter memicu abort pada deadline konfigurasi tanpa retry. Error 401/403/404/409/413/422/429/500/503, HTML, dan envelope tidak lengkap ditangani tanpa membocorkan respons mentah.
- Browser: dropdown awal mengikuti GET, label QRIS/Tunai/Belum ditentukan benar pada daftar/detail, dialog konfirmasi belum dicentang dan fokus Batal, pembatalan tanpa PATCH, double-submit hanya satu PATCH, seluruh editor terkunci saat mutation, detail/list/summary GET ulang setelah sukses.
- Sembilan transisi pembayaran termasuk null CAS/no-op. Payload tidak membawa field editor lain; fixture memastikan status, kontak, harga, items, subtotal, diskon, total tetap sama. Pemilihan QRIS tidak mengonfirmasi dana.
- Snapshot stale menimbulkan 409; stale tetapi nilai sudah di tujuan menjadi changed=false. Dua PATCH bersamaan melalui adapter menghasilkan satu sukses dan satu konflik pada fixture HTTP ber-lock. Ini bukan bukti atomisitas database nyata.
- Pembayaran/status/kontak: konflik, timeout simulasi setelah commit, 404, 422, 500, 429, 413, 503, HTML 200 dan envelope salah mengunci simpan sampai GET berhasil. GET gagal tetap terkunci; PATCH tidak diulang otomatis. PATCH sukses dengan GET gagal juga tetap terkunci.
- Draft kontak dipertahankan setelah refresh, simpan status/metode, dan error diikuti GET gagal lalu recovery. Draft metode/status tidak disimpan oleh editor lain; ada pemberitahuan saat dibuang. Logout/401 menghapus data sensitif dan seluruh draft.
- Summary lambat tidak menahan daftar. Summary 503/429/HTML tetap menampilkan daftar, pagination dan detail dengan error statistik terpisah; recovery membersihkan error. Summary 401/403 mengunci dashboard dan respons list terlambat tidak mengisi ulang DOM. List invalid tidak menghapus summary yang sukses.
- Regresi: 12 transisi status, NEEDS_REVIEW, kontak null/isi/edit/kosongkan, normalisasi dan expected legacy persis, chat link aman, pencarian/filter/pagination, escaping, login/logout/reload, CORS preflight, CSP/security headers fixture, layout 1024/768/390/320 px. Tidak ada uncaught browser exception.

## Hapus pesanan: alur UI yang benar-benar dijalankan

- Membuka detail dari tombol pada baris daftar, menemukan tombol Hapus pesanan, mengeklik tombol, dan mengonfirmasi Order ID pada setiap status PENDING, NEEDS_REVIEW, CANCELLED. Ini menjalankan event handler dashboard melalui browser, bukan hanya mendefinisikan fungsi/dialog.
- Dialog menjelaskan penghapusan permanen rincian item, fokus awal Batal, dan konfirmasi nonaktif untuk ID kosong, huruf kecil, whitespace tambahan, atau ID berbeda. ID persis mengaktifkan konfirmasi. Pembatalan tidak mengirim DELETE dan membersihkan ID.
- Double-submit dan percobaan menyimpan status/metode/kontak bersamaan hanya menghasilkan satu DELETE. Draft status COMPLETED tidak mengubah expected_status dari detail tersimpan atau membuat PATCH tambahan.
- Request HTTP fixture diperiksa memakai path satu order, satu query expected_status sesuai status terakhir, body kosong, tanpa Content-Type JSON. Server membalas 204 tanpa body maupun Content-Type; detail ditutup dan dibersihkan, daftar/summary GET ulang, order lain tetap sama.
- Detail COMPLETED tidak memiliki tombol hapus. Menahan referensi tombol lama, lalu memuat ulang detail menjadi COMPLETED dan mengeklik tombol lama, tidak membuka dialog maupun mengirim DELETE. Ini menguji guard handler selain visibilitas tombol.
- Konflik status menjadi COMPLETED mengunci hapus dan ketiga editor sampai GET berhasil. GET gagal tetap terkunci; GET sukses menampilkan COMPLETED tanpa tombol hapus.
- Timeout setelah commit: DELETE hanya sekali, lalu GET detail 404 menutup detail dan memperbarui daftar/summary. Timeout tanpa commit: GET menampilkan data terbaru dan mempertahankan draft kontak. GET recovery gagal tetap meniadakan mutation sampai retry baca berhasil. DELETE 404 akibat order dihapus sesi lain juga diverifikasi dengan GET.
- Menghapus satu-satunya baris halaman 2 dari 2 mengoreksi pagination ke halaman 1 dari 1, menampilkan delapan baris tersisa dan summary terbaru.
- DELETE 401 membersihkan credential, tabel, detail, dialog dan input ID; request berikutnya tanpa credential ditolak lokal. Logout saat konfirmasi juga membersihkan input ID tanpa DELETE.
- Tes adapter secara terpisah memeriksa 204 tanpa memanggil JSON parser, query expected_status tanpa body, header keamanan, autentikasi lokal sebelum fetch, error tersanitasi dan timeout tanpa retry.

Artefak final ada di `tests/artifacts/results.json` (240 checks), screenshot akses/dashboard/detail, dan profile Chrome tes. Seluruhnya diabaikan Git/deploy. Credential `test-only` hanya milik fixture.

## Batas verifikasi

Source backend aktual dibaca sebagai referensi dan kini memuat kontrak metode pembayaran serta DELETE dengan query expected_status; lihat [API-CONTRACT.md](API-CONTRACT.md). Tidak menjalankan endpoint asli. Task ini menyelesaikan integrasi dashboard, bukan mengimplementasikan ulang backend.

Penolakan request invalid/missing/extra dengan 422 adalah kontrak backend, bukan hasil uji backend pada pekerjaan ini. Tes frontend membuktikan payload valid berisi tepat dua field, penolakan respons invalid/missing, dan penanganan respons 422. Fixture tidak menggantikan pengujian FastAPI/Pydantic atau Supabase.

Backend dan MKWU-WEB tidak diubah pada task penyelesaian ini. Tidak menjalankan pytest/backend, mengakses database asli, mengeksekusi SQL, membaca/menulis .env asli, mengubah transaksi nyata, deploy, atau push. DELETE hanya menghapus order fixture dalam memori server tes. Cascade item database nyata, integrasi Supabase, locking/CAS database, konfigurasi CORS environment nyata dan deployment belum diverifikasi. Mock tidak membuktikan FK ON DELETE CASCADE.

Jalankan dari root dashboard:

```powershell
node --test tests/api.test.mjs
python tests/browser_test.py
python tools/serve.py --port 5501
```

Buka http://127.0.0.1:5501 untuk UI lokal. Uji integrasi hanya dengan backend yang memenuhi kontrak dan order uji sesuai [MANUAL-TEST.md](MANUAL-TEST.md).
