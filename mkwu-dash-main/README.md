# Le Cheese · Dashboard admin

Dashboard HTML/CSS/Vanilla JS existing, tanpa framework, bundler, atau dependency runtime baru. Root project: `E:/cheesecake-dash/cheesecake-admin`. Desain existing dipertahankan.

Adapter mengikuti kontrak admin, termasuk metode pembayaran dan DELETE satu pesanan. Config aktif: `VITE_API_URL = "https://cheesecake-api-mu.vercel.app"`, `ADMIN_API_ENABLED = true`, `DEMO_ENABLED = false`. Source backend aktual dibaca sebagai referensi; backend tidak diubah pada task penyelesaian dashboard ini. Rincian ada di [kontrak API](docs/API-CONTRACT.md). Backend/Supabase asli tidak diakses dan integrasi runtime belum diverifikasi. API gagal menampilkan error; tidak ada fallback demo.

## Menjalankan lokal

Jalankan dashboard pada port **5501**, terpisah dari landing page (contoh port 5500):

```powershell
cd E:/cheesecake-dash/cheesecake-admin
python tools/serve.py --port 5501
```

Buka **http://127.0.0.1:5501**. Helper ini hanya HTTP server statis loopback, memakai security headers dari `vercel.json`, tanpa framework atau build. Hentikan dengan Ctrl+C. Jangan memakai `file://`.

Alternatif dasar: `python -m http.server 5501 --bind 127.0.0.1`. Server standar Python tidak menerapkan header dari `vercel.json`; meta CSP masih berlaku, tetapi frame protection/no-store/header lain harus diuji dengan helper di atas atau hosting sebenarnya.

Pengguna menjalankan backend dari project backend, dengan environment miliknya sendiri:

```powershell
cd E:/cheesecake-api
.venv/Scripts/python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000 --no-access-log
```

Pertahankan semua origin landing page dalam `ALLOWED_ORIGINS` backend, lalu **tambahkan** `http://127.0.0.1:5501` dan, jika digunakan, `http://localhost:5501`. Origin berbeda menurut skema/host/port, tanpa path/trailing slash. Backend perlu mengizinkan GET/POST/PUT/PATCH/DELETE, header `X-Admin-Secret`, `Content-Type`, dan `Idempotency-Key`, OPTIONS preflight tanpa password, serta `allow_credentials=false`. Source backend sudah mengatur metode/header ini; daftar origin aktual belum diperiksa. Restart backend setelah pengguna mengubah environment. Tidak ada `.env` backend yang dibaca atau diubah pada pekerjaan ini.

Isi password admin langsung di form. `ADMIN_SECRET` hanya berada di backend dan memori modul browser selama akses. Tidak ada email, pilihan role, bearer, token, sesi palsu, atau endpoint login/logout. Verifikasi hanya `GET /admin/me`. Logout/reload/navigasi membersihkan credential, request aktif dan DOM sensitif. Password tetap valid pada perangkat lain sampai dirotasi di backend; logout bukan pencabutan sesi server.

## Perilaku

- List: search ID case-insensitive maksimum 64 karakter, empat filter status, pagination 8/16/32. Summary dimuat terpisah dan tidak mengikuti filter tabel. Kegagalan summary non-autentikasi menampilkan statistik tidak tersedia beserta error tersendiri; daftar, pagination, dan detail tetap berfungsi. 401/403 tetap mengunci dashboard.
- Detail memakai snapshot item, diskon/total backend, Rupiah dan WIB. Metode QRIS → QRIS, CASH → Tunai, null → Belum ditentukan pada daftar dan detail.
- Editor metode pembayaran memiliki tombol dan konfirmasi tersendiri. PATCH hanya mengirim `payment_method` dan `expected_payment_method` persis dari GET detail terakhir, keduanya QRIS/CASH/null. Memilih QRIS atau Tunai tidak mengubah status maupun menandakan dana diterima. Status COMPLETED tetap keputusan manual admin.
- Status tujuan PENDING/COMPLETED/CANCELLED; NEEDS_REVIEW lama terbaca dan dapat dikoreksi. COMPLETED = **Sudah dibayar**. Semua perubahan, termasuk koreksi/no-op, memakai konfirmasi dan PATCH dengan `expected_status`.
- Kontak manual: isi/edit/kosongkan dengan konfirmasi, PATCH terpisah dengan `expected_wa_number` persis dari detail. Nomor Indonesia dinormalisasi; legacy tetap terbaca apa adanya. Link chat hanya dari nomor canonical valid `https://wa.me/<digits>`, dengan `noopener noreferrer`.
- Hapus pesanan: tombol di detail PENDING/NEEDS_REVIEW/CANCELLED; COMPLETED ditolak. Wajib mengetik Order ID persis setelah peringatan hapus permanen. DELETE memakai query `expected_status` dari detail terakhir tanpa body JSON; 204 tidak diparsing. Detail ditutup, daftar/summary dimuat ulang dan pagination dikoreksi. Konflik mengunci mutation sampai GET berhasil; timeout memeriksa detail tanpa retry DELETE. GET 404 membersihkan order dari layar; GET sukses menampilkan data terbaru. Tidak ada bulk delete.
- Ketiga aksi simpan terpisah; tidak menyimpan draft editor lain. Submit seluruh editor dikunci selama request. Sesudah sukses, GET ulang detail/list/summary. Sesudah error mutation, termasuk timeout/409, simpan terkunci sampai GET detail berhasil. Mutation tidak diulang otomatis. Draft kontak dipertahankan saat refresh/gagal dan saat menyimpan metode/status; draft status/metode yang dibuang saat refresh diberi pemberitahuan. Menutup detail memberi pemberitahuan jika draft ditinggalkan.
- 429 meminta menunggu, 413 menjelaskan ukuran input, 503 layanan sementara tidak tersedia. HTML/non-JSON/error CORS ditangani generik tanpa membocorkan respons mentah. Retry manual, tanpa polling/retry loop.
- **Tambah pesanan manual** (tombol di atas daftar), **edit nama pelanggan**, **edit item** (dikunci untuk COMPLETED; total dihitung ulang server), **catatan admin**, dan **bukti pembayaran** (maks. 5 foto per pesanan; lihat, unduh, ganti, hapus). Foto dikompres di browser menjadi JPEG ≤1,5 MiB sebelum diunggah. Fitur ini membutuhkan endpoint backend baru di [kontrak tambahan](docs/API-CONTRACT.md#kontrak-tambahan--tambah-pesanan-edit-data-dan-bukti-pembayaran); selama backend belum mendukung, detail menampilkan pemberitahuan dan fitur lama tetap berjalan.
- Nilai summary **Nilai semua pesanan** mencakup CANCELLED, bukan omzet. Export, FINANCE dan alur demo tidak tersedia. `js/demo.js` merupakan fixture lama yang tidak diimpor dashboard.

## Konfigurasi dan keamanan

`js/config.js` dan `js/config.example.js` adalah konfigurasi publik ES Module. `VITE_API_URL` merupakan konstanta existing, tanpa Vite atau `.env` frontend. Jangan menaruh password/key/secret di file ini, URL, localStorage, sessionStorage, cookie, console, atau screenshot.

CSP sekarang mengizinkan origin backend `https://cheesecake-api-mu.vercel.app`. Untuk beralih ke backend lain atau lokal, perbarui **tiga tempat**: `VITE_API_URL` di `js/config.js`, `connect-src` meta CSP `index.html`, dan `connect-src` header `vercel.json`; sesuaikan juga contoh config dan URL pengganti fixture di `tests/browser_test.py`. `ALLOWED_ORIGINS` di backend harus mencakup origin dashboard yang mengakses API. Tidak ada `https:` wildcard, `unsafe-inline`, `unsafe-eval`, atau script eksternal baru. Frame protection diterapkan lewat header HTTP karena `frame-ancestors` tidak didukung meta CSP.

Root hosting tetap `cheesecake-admin`, statis tanpa build/install. `vercel.json` menyiapkan no-store, CSP, nosniff, no-referrer, DENY, dan Permissions-Policy. Tidak ada deploy atau pengaturan akun hosting yang diterapkan. Lihat [keamanan dan batas hosting](docs/security.md).

## Tes

```powershell
node --test tests/api.test.mjs
python tests/browser_test.py
python tests/browser_extended_test.py
```

Node hanya untuk tes adapter, bukan runtime aplikasi. Browser suite memakai Chrome dan dependency tooling Python existing `websocket-client`. Jika belum tersedia, pengguna dapat memasangnya di environment tes dengan `python -m pip install websocket-client`. Tidak ada dependency runtime/frontend baru. `CHROME_PATH` dapat menunjuk executable Chrome.

Tes browser memakai dua HTTP server lokal dengan origin berbeda, fixture sesuai kontrak, preflight, header/CSP hosting, dan fetch browser nyata. Tidak mengakses backend/Supabase sebenarnya. Artefak di `tests/artifacts/` diabaikan Git/deploy. Lihat [hasil aktual](docs/TEST-RESULTS.md), [kontrak final](docs/API-CONTRACT.md), dan [tes backend manual](docs/MANUAL-TEST.md).
