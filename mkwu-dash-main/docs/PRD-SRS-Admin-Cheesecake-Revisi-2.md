# PRD, SRS, dan Prompt Codex — Admin Cheesecake, Kontak Manual, dan Keamanan

Revisi 2 — 19 Oktober 2026. Perubahan: kontak WA manual dan persyaratan keamanan sebelum publikasi. Target: menambah kemampuan admin pada cheesecake-api existing, lalu menghubungkan cheesecake-admin secara lokal.

Dokumen ini berdasarkan inspeksi arsip cheesecake-api - Copy.rar, cheesecake-admin(1).rar, MKWU-WEB.rar, dan roadmap revisi Fase 1–5 yang diberikan pengguna. Ini spesifikasi pekerjaan baru, bukan klaim fitur sudah berjalan. Codex wajib memeriksa ulang source aktual di laptop sebelum implementasi.

## A. PRD — kebutuhan produk

### A1. Tujuan

Satu admin dapat masuk menggunakan satu password, melihat dan mencari pesanan, membuka detail, mengisi, memperbaiki, atau mengosongkan nomor WA pembeli secara manual, serta mengubah status setelah memeriksa pembayaran di WhatsApp. Dashboard hanya mengakses REST API cheesecake-api; backend tetap memakai Supabase existing.

Label status pengguna:

| Label dashboard | Nilai database/API | Arti |
|---|---|---|
| Pending | PENDING | Menunggu pembayaran atau pemeriksaan admin |
| Sudah dibayar | COMPLETED | Admin telah memverifikasi pembayaran secara manual |
| Cancelled | CANCELLED | Pesanan dibatalkan |

Istilah “udah” ditetapkan sebagai “Sudah dibayar”, bukan penanda barang sudah dikirim. NEEDS_REVIEW yang sudah diizinkan schema tetap dapat dibaca sebagai “Perlu diperiksa”, tetapi bukan pilihan status baru pada form sederhana.

### A2. Kondisi existing yang ditemukan

- main.py menyediakan GET /products dan POST /orders; belum ada endpoint admin atau autentikasi.
- config.py membaca SUPABASE_URL, SUPABASE_KEY, WA_NUMBER, ALLOWED_ORIGINS, dan ORDER_TTL_HOURS.
- orders.id adalah ID pesanan; order_items.price menyimpan harga satuan snapshot.
- orders.wa_number sudah tersedia sebagai kolom nullable; tetapkan untuk kontak pembeli. WA_NUMBER di environment tetap nomor bisnis tujuan pesan.
- Schema sudah mendukung PENDING, COMPLETED, NEEDS_REVIEW, CANCELLED. Tidak ada kolom payment_method.
- CORS baru mengizinkan GET/POST dan Content-Type.
- Dashboard memiliki adapter API, form email/password, bearer-token flow, role ADMIN/FINANCE, dan konfirmasi khusus QRIS. Semua ini masih kontrak usulan; ADMIN_API_ENABLED=false.
- VITE_API_URL dalam dashboard adalah konstanta publik di js/config.js, bukan environment variable build Vite.
- Salinan landing page memiliki API_URL kosong. Jangan mengubahnya dalam pekerjaan ini.

### A3. Ruang lingkup wajib

1. Satu identitas admin dengan password dari ADMIN_SECRET di environment backend.
2. Verifikasi password, lihat daftar/detail order, cari berdasarkan Order ID, filter status, pagination.
3. Ubah status dari halaman detail dengan dialog konfirmasi dan pembacaan ulang data.
4. Ringkasan dasar untuk empat kartu dashboard existing.
5. CORS untuk origin landing page dan dashboard lokal yang didaftarkan eksplisit.
6. Tes autentikasi, query, perubahan status, CORS, dan regresi endpoint publik.
7. Panduan menjalankan dan menguji secara lokal tanpa menampilkan secret.
8. Tambah/baca/edit/kosongkan nomor WA pembeli di detail order (B11).
9. Proteksi aplikasi dan rencana konfigurasi firewall/rate limiting terverifikasi sebelum publikasi (B12).

“CRUD sederhana” pada pekerjaan ini berarti membaca order, memperbarui status, serta mengisi/edit/mengosongkan nomor WA pembeli. Pembuatan order tetap melalui POST /orders existing. Tidak ada hard delete, edit harga, edit item, atau pembuatan order admin.

### A4. Di luar lingkup

Multiuser, role FINANCE, registrasi, reset password, JWT/refresh token, Supabase Auth, tabel akun admin, upload bukti bayar, OCR/AI, payment gateway, export CSV, grafik lanjutan, perubahan schema, eksekusi deploy, dan perubahan landing page. Integrasi WhatsApp otomatis, Baileys, serta webhook juga di luar lingkup. Persiapan keamanan deployment termasuk lingkup; penerapan konfigurasi akun eksternal harus dilaporkan terpisah dari perubahan kode.

### A5. Alur pengguna

1. Admin membuka dashboard dari HTTP server lokal dan memasukkan password.
2. Dashboard memverifikasi password melalui GET /admin/me.
3. Dashboard memuat daftar order dan ringkasan.
4. Admin mencari Order ID dari WhatsApp, membuka detail, lalu mencatat nomor pembeli dari chat. Nomor bisa diedit atau dikosongkan dengan konfirmasi.
5. Admin memilih Pending / Sudah dibayar / Cancelled, mengecek konfirmasi, lalu menyimpan.
6. Backend memvalidasi autentikasi dan status, memperbarui status secara atomik, lalu dashboard memuat ulang detail, daftar, dan ringkasan.
7. Logout menghapus password dari memori dan data sensitif dari layar; reload meminta login lagi.

### A6. Kriteria selesai

- Tanpa password yang benar, seluruh endpoint /admin/* menolak akses.
- Data tampil dari backend asli saat pengujian lokal oleh pengguna.
- Perubahan status tersimpan ke orders tanpa mengubah item, total, atau diskon.
- Status dapat dikoreksi kembali oleh admin melalui konfirmasi.
- Konflik perubahan tidak menimpa status terbaru secara diam-diam.
- Endpoint publik existing dan test regresinya tetap berfungsi.
- Tidak ada Supabase key atau ADMIN_SECRET dalam source frontend maupun commit.
- Hasil tes otomatis dan langkah tes manual dicatat terpisah; tidak mengklaim tes Supabase asli jika belum dijalankan.

## B. SRS — spesifikasi teknis

### B1. Arsitektur dan batas perubahan

Backend tetap FastAPI + Supabase existing. Gunakan APIRouter berprefix /admin dan dependency autentikasi bersama. Pisahkan schema/query admin dari main.py bila membantu keterbacaan. Gunakan pola dependency injection database yang kompatibel dengan test suite existing.

Jangan mengganti implementasi create_order, pricing, RPC create_order, atau schema database. Tidak perlu SQL migration untuk fitur ini. Hindari refactor luas di luar kebutuhan admin.

### B2. Autentikasi admin tunggal

- Tambahkan ADMIN_SECRET wajib ke Settings backend; minimal 32 karakter acak untuk password operasional.
- Secret kosong, terlalu pendek, atau hanya whitespace menyebabkan ConfigError dengan nama variabel saja, tanpa nilainya. Perbarui fixture tes existing untuk requirement baru ini.
- Semua endpoint admin menerima header X-Admin-Secret. Bandingkan byte UTF-8 menggunakan secrets.compare_digest; jangan menyimpan atau mencetak header.
- Header hilang, kosong, salah, atau tidak valid menghasilkan 401 dengan pesan generik yang sama.
- GET /admin/me dengan header valid mengembalikan identitas tetap {"id":"admin","name":"Admin","role":"ADMIN"}.
- Tidak ada endpoint login yang menerbitkan token. Form login hanya menyimpan password sementara di memori modul dan memanggil /admin/me.
- Tidak ada endpoint logout server. Logout adalah penghapusan password lokal. Password yang diketahui tetap valid sampai ADMIN_SECRET dirotasi dan proses backend dimuat ulang; ini bukan sistem sesi yang bisa dicabut per perangkat.
- Tidak boleh menyimpan password di localStorage, sessionStorage, cookie, URL, file config publik, atau console. Bersihkan nilai input password setelah pemeriksaan login.
- Respons admin, termasuk error autentikasi, memakai Cache-Control: no-store. Pastikan error handler tidak membocorkan ADMIN_SECRET.
- HTTPS wajib ketika digunakan melalui jaringan publik. HTTP diperbolehkan untuk loopback lokal.
- Proteksi rate limiting sebelum publikasi wajib mengikuti B12. Jangan mengklaim limiter in-memory aman lintas worker/serverless; jangan mengklaim firewall aktif hanya dari hasil tes kode lokal.

### B3. Kontrak endpoint

Semua endpoint berikut wajib X-Admin-Secret. Nama dan payload ini menggantikan kontrak bearer dan confirm-payment usulan di dashboard.

| Method | Path | Tujuan |
|---|---|---|
| GET | /admin/me | Memverifikasi password dan identitas admin |
| GET | /admin/orders | Daftar, pencarian, filter, pagination |
| GET | /admin/orders/{order_id} | Detail lengkap order |
| PATCH | /admin/orders/{order_id}/status | Mengubah status |
| PATCH | /admin/orders/{order_id}/contact | Mengisi/edit/mengosongkan nomor WA pembeli |
| GET | /admin/summary | Ringkasan seluruh order |

Tidak menambah /admin/auth/login, /admin/auth/logout, /confirm-payment, atau endpoint export pada scope ini.

### B4. Daftar order

Query GET /admin/orders:

- search: opsional, trim whitespace, maksimum 64 karakter; pencarian substring Order ID case-insensitive, bukan nama pelanggan.
- status: opsional, salah satu empat status schema termasuk NEEDS_REVIEW; nilai lain 422.
- page: integer >=1, default 1.
- page_size: integer 1–100, default 8; cocok untuk pilihan UI 8/16/32.
- Urutan stabil created_at DESC, id DESC. total menghitung seluruh hasil filter sebelum pagination.
- Gunakan query builder terparameterisasi, bukan merakit SQL dari input. Perlakukan karakter wildcard pencarian sebagai literal; uji karakter %, _, dan backslash.
- Halaman melampaui hasil mengembalikan items=[] dengan total yang benar, bukan error.

Contoh respons 200:

```json
{
  "items": [{
    "order_id": "ORD-K7MPQ",
    "customer_name": "Contoh Pelanggan",
    "status": "PENDING",
    "total": 35000,
    "payment_method": null,
    "created_at": "2026-10-19T08:00:00+00:00"
  }],
  "total": 1,
  "page": 1,
  "page_size": 8
}
```

Pemetaan: orders.id menjadi order_id. payment_method=null untuk kompatibilitas baca dashboard; jangan mengarang QRIS. Semua nominal integer rupiah, seluruh timestamp ISO 8601 dengan timezone.

### B5. Detail order

GET /admin/orders/{order_id} mengembalikan seluruh field objek daftar ditambah wa_number (string atau null), subtotal, discount, dan items. Nomor hanya tersedia lewat detail admin yang terautentikasi; jangan menambahkannya ke respons publik. Contoh tambahan field:

```json
{
  "subtotal": 36000,
  "discount": 1000,
  "items": [{
    "product_name": "Le Mini Bite Original",
    "topping": "Selai blueberry",
    "qty": 3,
    "unit_price": 12000,
    "subtotal": 36000
  }]
}
```

Ini tambahan pada objek lengkap, bukan respons terpisah. Gunakan snapshot order_items.product_name dan price, bukan nama/harga katalog terkini. unit_price=price; subtotal item=qty*price. Total order tetap membaca orders.total, tanpa menghitung ulang diskon. Order tidak ditemukan menghasilkan 404. Gunakan aturan format ID existing untuk validasi path; format invalid menghasilkan 422.

### B6. Perubahan status

PATCH /admin/orders/{order_id}/status:

```json
{"status":"COMPLETED","expected_status":"PENDING"}
```

- status hanya PENDING, COMPLETED, CANCELLED.
- expected_status menerima keempat status existing, wajib diisi.
- Tolak field tambahan dengan 422, termasuk total, price, items, customer_name.
- Admin boleh beralih antar ketiga status tujuan, termasuk mengembalikan COMPLETED/CANCELLED ke PENDING sebagai koreksi manual.
- Order NEEDS_REVIEW boleh dialihkan ke salah satu dari tiga status tujuan. Jangan menghapus nilai NEEDS_REVIEW dari constraint database.
- Tidak ada syarat payment_method=QRIS. Konfirmasi pembayaran merupakan keputusan manual admin.
- Perbarui dengan kondisi id DAN status=expected_status dalam satu operasi database (compare-and-set). Jangan melakukan update tanpa kondisi setelah SELECT.
- Jika kondisi tidak cocok, baca ulang: order hilang ->404; status saat ini sudah sama dengan tujuan ->200 idempotent; selain itu ->409 dan minta pengguna memuat ulang.
- Jika status tujuan sudah sama dengan status saat ini, respons 200 tanpa perubahan. Jangan retry mutation secara otomatis setelah timeout.
- Return objek detail lengkap:

```json
{"order": "OBJEK_DETAIL_LENGKAP", "changed": true}
```

String di atas hanya placeholder dokumentasi; implementasi wajib mengembalikan objek JSON detail. changed=false untuk no-op/idempotent. Backend dapat mengalami perubahan lanjutan dari request lain sebelum GET berikutnya; dashboard selalu menampilkan hasil baca terbaru.

Catat log operasional sukses: aktor tetap admin, order_id, status lama/baru, waktu UTC. Jangan log password, header autentikasi, atau seluruh payload pelanggan. Log ini bukan audit trail permanen per pengguna.

### B7. Ringkasan

GET /admin/summary mengembalikan:

```json
{
  "total_orders": 18,
  "total_transaction_value": 630000,
  "confirmed_payments": 8,
  "pending_payments": 5
}
```

Definisi:

- total_orders: jumlah seluruh order, semua status.
- total_transaction_value: jumlah total seluruh order termasuk CANCELLED; label UI harus “Nilai semua pesanan”, bukan omzet.
- confirmed_payments: jumlah order COMPLETED.
- pending_payments: jumlah order PENDING; NEEDS_REVIEW tidak termasuk.
- Tidak mengikuti filter/pagination tabel. Database kosong menghasilkan empat angka nol.
- Jangan hanya menjumlahkan satu halaman atau terpotong batas default hasil Supabase. Tanpa migration, lakukan pembacaan kolom minimal id/status/total secara batch dengan urutan stabil sampai selesai, atau gunakan kemampuan agregasi existing yang sudah diverifikasi. Batasi pekerjaan sesuai B12, jangan scan tanpa batas; jangan mengembalikan angka parsial seolah lengkap. Dokumentasikan keterbatasan skalabilitas dan bahwa pembacaan beberapa batch bukan snapshot transaksi yang sepenuhnya konsisten saat ada perubahan bersamaan.

### B8. CORS dan environment

Pertahankan ALLOWED_ORIGINS sebagai daftar origin eksplisit dipisahkan koma, mencakup landing page dan dashboard. Contoh lokal (sesuaikan port aktual):

```dotenv
SUPABASE_URL=
SUPABASE_KEY=
WA_NUMBER=
ALLOWED_ORIGINS=http://127.0.0.1:5500,http://localhost:5500,http://127.0.0.1:5501,http://localhost:5501
ORDER_TTL_HOURS=24
ADMIN_SECRET=
```

ADMIN_SECRET sengaja kosong dalam contoh agar pengguna mengisi sendiri; startup harus menolak nilai kosong. Jangan mengganti .env asli dengan contoh ini.

- allow_methods: GET, POST, PATCH.
- allow_headers: Content-Type, X-Admin-Secret. Tidak perlu Authorization untuk kontrak ini.
- allow_credentials=false; frontend credentials:"omit".
- OPTIONS preflight ditangani CORSMiddleware, tanpa meminta password pada preflight.
- Jangan menambah wildcard origin. Origin harus mencakup skema/host/port, tanpa path; localhost dan 127.0.0.1 berbeda.
- Origin tak terdaftar tidak mendapat izin CORS. CORS bukan autentikasi: request curl tetap harus ditolak jika tidak memiliki secret valid.
- Pastikan respons error tetap bisa dibaca frontend dari origin terdaftar, termasuk error 500 yang disanitasi.
- Restart backend setelah mengubah environment. Tidak mencetak .env atau nilai secret untuk debugging.

### B9. Penyesuaian dashboard, tahap terpisah setelah backend

- Pertahankan desain HTML/CSS existing dan Vanilla JS.
- Login menjadi satu input password, tanpa email dan tanpa pilihan role.
- Ubah api.js/auth.js/config.js agar memakai X-Admin-Secret dan /admin/me; hapus ketergantungan bearer flow.
- Detail menampilkan input nomor WA, tombol Simpan nomor, serta Kosongkan nomor dengan konfirmasi (B11). Simpan kontak dan status adalah aksi terpisah.
- Detail menampilkan dropdown tiga status dan tombol Simpan status dengan dialog konfirmasi. Pembatalan dialog tidak mengirim request.
- Hilangkan syarat QRIS pada aksi status dan jelaskan COMPLETED sebagai Sudah dibayar. Kolom metode pembayaran boleh disembunyikan karena tidak tersedia.
- Hilangkan pemilih FINANCE. Sembunyikan export karena endpoint-nya tidak termasuk scope ini.
- Respons 429 menampilkan pesan tunggu; jangan membuat loop retry. 413 menjelaskan ukuran input berlebih; 503 menjelaskan layanan sementara tidak tersedia.
- Login gagal/401 membersihkan secret dan tampilan data; gangguan jaringan menampilkan error yang dapat dicoba ulang.
- Tombol simpan dikunci selama request. Setelah timeout/409, wajib refresh detail sebelum simpan ulang. Setelah sukses, muat ulang detail, list, summary.
- Tampilkan data server dengan escaping atau textContent, bukan HTML mentah.
- Set ADMIN_API_ENABLED=true hanya setelah kontrak diimplementasikan dan diverifikasi. DEMO_ENABLED=false untuk alur integrasi; tidak ada fallback diam-diam ke data demo.
- VITE_API_URL tetap konstanta publik di config.js; jangan memperkenalkan Vite atau menaruh secret di sana.

### B10. Matriks tes wajib

| ID | Skenario | Hasil |
|---|---|---|
| A01 | ADMIN_SECRET kosong/pendek | ConfigError tanpa nilai secret |
| A02 | Setiap endpoint admin: header hilang/salah | 401, tanpa kebocoran data |
| A03 | /admin/me dengan secret valid | Identitas admin tetap, no-store |
| A04 | Endpoint publik tanpa secret request | GET /products dan POST /orders tetap berfungsi |
| O01 | List kosong, pagination, beyond-last-page | Envelope dan total benar |
| O02 | Search, wildcard literal, filter semua status | Hasil sesuai kontrak |
| O03 | Detail dengan snapshot item | Field dan nominal benar |
| O04 | ID invalid/hilang | 422/404 |
| U01 | Semua transisi status yang diizinkan | Status tersimpan, field lain tetap |
| U02 | NEEDS_REVIEW ke tiga tujuan | Berhasil; target NEEDS_REVIEW ditolak |
| U03 | Field tambahan/status invalid | 422, data tidak berubah |
| U04 | expected_status sudah basi | 409 tanpa menimpa status terbaru |
| U05 | Dua update berbeda dari status awal sama | Hanya satu menang; lainnya konflik |
| U06 | Ulang request ke status tujuan yang sama | 200 changed=false |
| S01 | Summary kosong/campuran status | Hitungan dan definisi nilai benar |
| S02 | Dataset melebihi batas satu batch | Seluruh data terhitung |
| C01 | Preflight origin terdaftar + PATCH + X-Admin-Secret | Diizinkan |
| C02 | Origin tak terdaftar | Tidak mendapat izin CORS |
| C03 | Error 401/422/500 dari origin terdaftar | Error terbaca, secret tidak bocor |
| F01 | Login/logout/reload dashboard | Secret hanya di memori, data dibersihkan |
| F02 | Simpan status sukses/konflik/timeout | Refresh dan penguncian tombol benar |
| F03 | Nama pelanggan berisi markup | Ditampilkan sebagai teks |
| R01 | Semua tes backend existing | Lulus atau kegagalan baseline dijelaskan |

Tes otomatis memakai fake/mock DB dan environment test. Tidak membuat atau mengubah transaksi Supabase asli secara otomatis. Uji konkurensi mock harus menguji compare-and-set, bukan sekadar dua respons stub sukses. Verifikasi database nyata tetap dicatat sebagai langkah manual tersendiri jika tidak tersedia.

### B11. Kontak WA pembeli manual

Endpoint PATCH /admin/orders/{order_id}/contact wajib memakai autentikasi admin yang sama. Contoh:

```json
{"wa_number":"081234567890","expected_wa_number":null}
```

Respons 200 mengikuti pola mutation status: {"order": OBJEK_DETAIL_LENGKAP, "changed": true}. Detail mengembalikan wa_number dalam bentuk canonical atau null.

Aturan input dan penyimpanan:

- wa_number dan expected_wa_number wajib hadir; keduanya nullable. Extra fields ditolak 422. Tidak boleh mengubah nama/harga/item/status lewat endpoint ini.
- Input nomor berupa string maksimal 32 karakter sebelum normalisasi. Boleh angka ASCII, satu plus di awal, spasi, tanda kurung, dan tanda minus pemisah; huruf/URL/ekstensi/karakter lain ditolak.
- Hilangkan pemisah; bentuk Indonesia 08... diubah menjadi 628..., +62... menjadi 62..., dan 62... dipertahankan. Scope MVP hanya nomor mobile Indonesia: bentuk akhir ^628[0-9]{7,12}$ (10–15 digit). Ini validasi format aplikasi, bukan pembuktian bahwa akun WhatsApp aktif atau pemilik nomor benar.
- String kosong/whitespace ditolak 422; null dipakai secara eksplisit untuk mengosongkan nomor. UI boleh memetakan aksi kosongkan ke null setelah konfirmasi.
- expected_wa_number harus berisi nilai persis yang terakhir diterima detail, tanpa normalisasi sebelum perbandingan. Ini juga memungkinkan koreksi nilai legacy yang belum canonical. Jangan mengubah data legacy diam-diam saat membaca.
- Update bersyarat atomik berdasarkan id dan nilai wa_number sebelumnya. Untuk null gunakan filter SQL IS NULL yang benar, bukan eq(null).
- Konflik nomor terbaru ->409, ID tidak ditemukan ->404. Jika nilai tersimpan sudah sama dengan target hasil normalisasi ->200 changed=false.
- Dua tab dengan nilai awal sama tidak boleh saling menimpa tanpa deteksi. Status dan kontak diubah terpisah agar update status tidak menimpa nomor.
- Simpan dengan type text; jangan parse sebagai integer. Nomor tidak unik: pelanggan boleh memiliki banyak order.
- Tombol Simpan nomor dikunci selama request. Setelah 409/timeout wajib muat ulang detail sebelum retry. Jangan menghapus input yang belum tersimpan tanpa memberi tahu pengguna.
- Link buka chat hanya dibentuk dari digit canonical yang valid menjadi https://wa.me/<digits>; jangan menggunakan URL bebas dari input pengguna.
- Backend log hanya aktor admin, order_id, operasi kontak, waktu; tanpa nomor penuh, secret, atau isi chat.
- Tidak ada hard delete order. “Hapus” pada fitur ini berarti mengosongkan kontak ke null, bukan menghapus transaksi.

Tes tambahan: isi saat null, baca, edit, kosongkan, normalisasi tiga format, input invalid/terlalu panjang, field tambahan, autentikasi, konflik dua tab, idempotent, null CAS, nomor sama pada banyak order, nomor tidak bocor ke endpoint publik, dan link aman di UI.

### B12. Keamanan aplikasi dan kesiapan Vercel

Tujuan: mengurangi spam order, tebakan password, kebocoran kontak/secret, dan konsumsi sumber daya. Tidak ada klaim kebal DDoS. Belum ada pemeriksaan konfigurasi akun Vercel atau Supabase live; jangan menganggap konfigurasi berikut sudah aktif.

#### B12.1 Model ancaman dan prioritas

| Risiko konkret | Permukaan | Proteksi |
|---|---|---|
| Spam order valid berulang | POST /orders publik | Rate limit di edge sebelum function/DB, monitoring volume |
| Tebakan password | Seluruh /admin/*, bukan hanya /admin/me | Secret acak kuat, edge rate limit, autentikasi sebelum query DB |
| Payload besar | POST/PATCH | Batas byte aktual, batas schema dan tipe input |
| Query mahal | list/summary | Pagination, batas kerja dan timeout |
| Nomor pelanggan bocor | detail/error/log | Auth wajib, no-store, sanitasi log, output minimal |
| Stored XSS dari nama pelanggan | dashboard | textContent/escaping, CSP yang sesuai aplikasi |
| Secret Supabase bocor | repo/build/log | Secret hanya server, RLS, verifikasi privilege |
| Resource/kuota habis | function/DB/traffic | Firewall, monitor error/latency/usage, prosedur darurat |

CORS hanya membatasi perilaku browser. CORS, menyembunyikan API URL, mematikan Swagger, atau Order ID acak bukan pengganti auth/rate limiting. Request valid ke endpoint publik tetap bisa dikirim tanpa melewati landing page.

#### B12.2 Perubahan kode yang wajib dikerjakan

1. Autentikasi seluruh endpoint admin sebelum query DB, termasuk patch kontak dan summary. Jangan membuat pengecualian berdasarkan Origin/Referer/User-Agent.
2. Batas request body aplikasi 16 KiB untuk POST /orders dan PATCH admin, configurable. Periksa Content-Length lebih awal tetapi juga hitung byte stream aktual ketika header hilang/tidak akurat; jangan membaca body tak terbatas terlebih dahulu. Tolak berlebih dengan 413 sebelum JSON parsing/DB. Uji stream tanpa Content-Length. Pastikan CORSMiddleware tetap menyertakan header untuk error dari origin terdaftar.
3. Pertahankan batas existing: customer_name 1–100 karakter, items 1–30, qty 1–99. Batasi product_id dan topping misalnya 64 karakter setelah memastikan semua nilai katalog existing muat. Pastikan harga/total selalu dihitung server. Jangan mengubah perilaku kompatibilitas endpoint publik terhadap extra price/total: nilai client tetap tidak dipercaya.
4. Terapkan timeout akses Supabase yang cocok dengan SDK terpasang. Target awal timeout operasi DB 5 detik dan anggaran aplikasi di bawah timeout request frontend 15 detik untuk admin. Perhatikan landing page existing memakai timeout 8 detik; beberapa query berurutan bisa melampauinya. Ukur waktu total dan dokumentasikan batas nyata, bukan sekadar satu timeout per query. Timeout mutation bisa terjadi setelah commit: jangan retry POST order/PATCH secara otomatis.
5. Batas kerja summary configurable: maksimal 10.000 baris dan deadline total 5 detik sebagai default awal. Baca satu baris ekstra untuk mendeteksi overflow; jika melebihi batas/deadline, kembalikan 503 generik, tidak mengembalikan statistik parsial. Dataset lebih besar perlu agregasi DB sebagai pekerjaan lanjutan. Jangan cache respons admin secara publik. Hindari polling summary otomatis.
6. Tambahkan NEW_ORDERS_ENABLED default true sebagai kill switch aplikasi. Saat false, POST /orders mengembalikan 503 sebelum akses DB; GET produk/admin tetap dapat bekerja. Ini mengurangi penulisan DB, bukan menghentikan invocation/biaya edge. Aturan firewall sementara pada POST /orders lebih efektif untuk menghentikan request sebelum function. Perubahan env hosting mungkin perlu redeploy.
7. Respons error generik. Sanitasi credential, header X-Admin-Secret, nomor pelanggan, dan payload request dari log. Catat request ID, route template (bukan query input mentah), status, durasi, dan tipe error. Untuk perubahan admin log Order ID tanpa nomor lengkap.
8. Verifikasi dari schema bahwa RLS aktif dan RPC create_order dibatasi ke service_role. Jangan menambahkan policy publik pada orders/order_items. Akses dengan service_role tetap wajib dibatasi oleh kode API karena role ini dapat melewati RLS.
9. Dashboard: CSP sesuai origin API yang konkret, frame-ancestors 'none', X-Content-Type-Options nosniff, Referrer-Policy no-referrer, serta escaping data pelanggan. Jangan menambahkan unsafe-eval atau script eksternal baru. Tes header/CSP tidak memutus koneksi API; loopback HTTP hanya untuk lokal, HTTPS untuk publik.
10. Dokumentasikan pengaturan akun: MFA pada akun pengelola GitHub/Vercel/Supabase, scope environment secret preview/production, serta rotasi jika secret pernah bocor. Jangan menampilkan secret saat memeriksa file/repo.

#### B12.3 Rate limiting sebelum publikasi

Pilihan utama: Vercel WAF pada project backend, membatasi request sebelum masuk FastAPI/Supabase. Ketersediaan dan jumlah rule bergantung paket aktual; jangan mengasumsikan unlimited atau gratis. Dokumentasi yang diperiksa 19 Oktober 2026 menyatakan fixed-window tersedia semua paket, Hobby memiliki satu rate-limit rule per project, counter per region. Verifikasi ulang saat implementasi/deploy.

Profil usulan untuk traffic jualan kecil; ini nilai awal untuk observasi, bukan jaminan kapasitas:

| Path/method | Batas awal jika rule terpisah tersedia |
|---|---|
| POST /orders | 10 request/menit/IP |
| Semua /admin/* | 60 request/menit/IP |
| GET /admin/me | Opsional lebih ketat, 10/menit/IP jika rule tersedia |

Jika hanya satu rule: siapkan satu rule gabungan yang mencocokkan POST /orders ATAU /admin/* dengan 30 request/menit/IP. Dokumentasikan bucket bersama dan tradeoff: spam order bisa memakan kuota admin jika memakai IP bersama. Utamakan desain yang benar-benar tersedia di akun; jangan mengklaim ketiga rule aktif pada paket yang hanya mendukung satu.

- Awali observasi lalu enforce setelah menguji alur normal; pada tahap log-only belum ada proteksi rate limit yang memblokir.
- API fetch sebaiknya mendapat 429, bukan challenge HTML yang tidak dapat diselesaikan fetch. Edge error bisa tidak berbentuk JSON/tidak menyertakan CORS; dashboard perlu pesan gangguan jaringan yang jelas. Jangan menjanjikan Retry-After dari WAF sebelum diverifikasi.
- Jangan memasukkan OPTIONS preflight ke bucket mutation. Uji semua domain/alias deployment yang mengekspos backend, bukan hanya custom domain.
- IP harus berasal dari fasilitas edge/metadata proxy terpercaya yang didokumentasikan, bukan X-Forwarded-For sembarang yang dikirim klien.
- IP bersama Wi-Fi kampus/seluler bisa membatasi banyak pelanggan sekaligus. Uji dan sesuaikan batas berdasarkan traffic nyata. Per-region counter dan rotasi IP membuat limit ini bukan kuota global mutlak.
- Jika WAF tidak tersedia, jangan diam-diam menggantinya dengan dictionary Python. Buat rancangan limiter shared-store atomik dengan TTL sebagai alternatif terpisah; jangan menambah layanan berbayar, tabel, atau secret tanpa keputusan pengguna. Status publikasi tetap “rate limiting belum aktif” sampai solusi benar-benar tersedia.
- Jangan menerapkan lockout global admin berdasarkan satu penyerang: itu dapat membuat admin sah ikut terkunci.

DDoS mitigation Vercel merupakan perlindungan platform. Abuse aplikasi yang tampak valid tetap perlu batas request dan observasi. Vercel menyatakan traffic yang lolos sebelum mitigasi atau tidak dikenali sebagai serangan tetap dapat menimbulkan usage.

#### B12.4 Monitoring dan prosedur saat gangguan

Dokumentasikan pemeriksaan manual dashboard Vercel/Supabase: jumlah POST order, 401/429/5xx, durasi function, pemakaian database/traffic, dan pertumbuhan PENDING yang tidak wajar. Aktifkan notifikasi usage/biaya yang tersedia pada paket; jangan menganggap alert biaya adalah hard cap.

Jika terindikasi spam: periksa log tersanitasi, ketatkan rule path yang terdampak, blokir sumber yang jelas jika relevan, atau hentikan sementara POST /orders di edge. Hindari Attack Mode untuk semua API tanpa pengujian karena challenge bisa merusak fetch yang sah. Jangan menonaktifkan auth/RLS untuk mengatasi gangguan.

Landing page existing fallback ke WA saat order API gagal: pelanggan masih bisa mengirim pesan, tetapi order tersebut mungkin tidak tercatat di database. Komunikasikan fallback ini kepada admin. Dokumen ini belum mencakup form create-order manual; itu perlu task terpisah jika dibutuhkan.

#### B12.5 Tes dan bukti

Tambahkan tes body limit (header ada/tidak ada), query/summary bounded, timeout DB, kill switch, no DB query saat auth gagal/body ditolak, sanitasi error/log, no-store, RLS/privilege sebagai verifikasi manual non-mutating, serta input XSS.

Tes unit boleh menggunakan limiter fake untuk perilaku 429, tetapi tidak membuktikan WAF aktif. Uji rate limit nyata hanya pada deployment milik pengguna dengan traffic kecil/terkendali dan izin yang sesuai; tidak melakukan stress/DDoS test pada hosting publik. Catat secara terpisah: diterapkan di kode, diuji lokal, perlu pengaturan hosting, dan terverifikasi di deployment.

Artefak tambahan Codex: docs/security.md (ancaman/kontrol/batasan), docs/vercel-firewall-setup.md (rule tepat sesuai paket, checklist verifikasi), serta hasil tes. Akhiri dengan blocker publikasi yang konkret bila WAF/secret/monitoring belum dikonfigurasi.

Referensi resmi untuk diverifikasi ulang saat deploy:
- https://vercel.com/docs/vercel-firewall/ddos-mitigation
- https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting
- https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing
- https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/

## C. Prompt utama untuk Codex — backend

Salin blok ini ke Codex dengan folder cheesecake-api terbuka dan dokumen ini tersedia dalam workspace.

```text
Kerjakan implementasi pada backend cheesecake-api existing berdasarkan bagian A (PRD) dan B (SRS) di dokumen PRD-SRS-Admin-Cheesecake-Revisi-2.md.

Target: satu admin berbasis ADMIN_SECRET + header X-Admin-Secret; GET /admin/me, GET /admin/orders, GET /admin/orders/{order_id}, PATCH /admin/orders/{order_id}/status, PATCH /admin/orders/{order_id}/contact, GET /admin/summary; serta CORS dan hardening sesuai B11–B12.

Baca AGENTS.md yang berlaku, main.py, config.py, db.py, schemas.py, orders.py, pricing.py, sql/schema.sql, tests/, requirements.txt, dan docs existing terlebih dahulu. Jangan tampilkan isi .env atau secret. Periksa source aktual karena arsip yang dianalisis bisa berbeda dari workspace ini.

Mulai dengan ringkasan singkat kondisi aktual dan rencana, lalu langsung implementasi sampai tes selesai. Gunakan SRS bagian B sebagai kontrak endpoint yang mengikat. Baca detail autentikasi, status, atomic compare-and-set, mapping field, summary, CORS, kontak manual B11, keamanan B12, dan matriks tes, bukan hanya daftar endpoint.

Batas wajib:
- Gunakan backend dan Supabase existing. Tidak membuat backend/database/tabel akun baru dan tidak mengubah schema atau RPC create_order.
- Jangan mengubah MKWU-WEB, pricing, kontrak GET /products, atau POST /orders.
- Implementasikan satu admin, tanpa email, FINANCE, registrasi, JWT, atau refresh token.
- Status tujuan hanya PENDING/COMPLETED/CANCELLED; NEEDS_REVIEW lama tetap bisa dibaca dan dikoreksi.
- Tidak ada hard delete, edit harga/item, atau requirement QRIS.
- Jangan menulis secret asli, memodifikasi .env asli, melakukan deploy, push, atau menjalankan mutation ke Supabase nyata.
- Tidak perlu endpoint export atau auth/logout. Logout hanya menghapus credential lokal.

Tahapan:
1. Jalankan tes baseline dengan fake DB dan env test; catat kegagalan existing.
2. Tambahkan config ADMIN_SECRET dan dependency autentikasi bersama, serta sanitasi log/error.
3. Implementasikan router/schema/query admin sesuai kontrak. Gunakan perubahan modular dan kecil.
4. Sesuaikan CORS tanpa merusak origin landing page. Implementasikan kontak manual B11 dan proteksi kode B12 (body limit, timeout/bounded work, kill switch, sanitasi). Siapkan panduan WAF sesuai keterbatasan paket; jangan mengklaim setting eksternal sudah aktif.
5. Tambahkan tes sesuai matriks backend dan jalankan seluruh tes regresi.
6. Tambahkan docs/admin-prd.md dan docs/admin-srs.md dari bagian relevan dokumen ini tanpa menimpa docs/prd.md atau docs/srs.md existing. Tambahkan docs/admin-local-test.md, docs/security.md, docs/vercel-firewall-setup.md, dan perbarui .env.example dengan placeholder, bukan secret.
7. Laporkan file yang berubah, endpoint final, hasil tes aktual, cara mengisi ADMIN_SECRET sendiri dan menjalankan lokal, serta batas verifikasi yang belum dilakukan.

Jika perlu menambah dependency, gunakan seminimal mungkin dan cocokkan dengan versi runtime existing. Jangan mengubah skema demi memudahkan implementasi. Jika source aktual memiliki konflik arsitektur besar atau kebutuhan migration, jelaskan blocker spesifik; jangan diam-diam memperluas scope.

Kerjakan backend terlebih dahulu. Dashboard akan disesuaikan dalam tahap berikutnya dengan kontrak yang sama. Jangan mengklaim dashboard sudah terhubung hanya karena tes backend lulus.
```

## D. Prompt lanjutan untuk Codex — dashboard

Gunakan setelah backend tahap C selesai; buka cheesecake-admin dan sediakan kontrak backend final.

```text
Hubungkan cheesecake-admin existing ke cheesecake-api yang sudah mengimplementasikan SRS dalam PRD-SRS-Admin-Cheesecake-Revisi-2.md. Fokus pada bagian B9–B12 dan tes frontend. Kontrak baru mencakup PATCH /admin/orders/{order_id}/contact untuk nomor WA manual.

Periksa index.html, js/api.js, js/auth.js, js/config.js, js/dashboard.js, js/utils.js, tests, dan kontrak backend aktual terlebih dahulu. Pertahankan desain existing dan Vanilla JS.

Ganti login email/password + bearer + ADMIN/FINANCE menjadi satu input password, secret hanya di memori modul, header X-Admin-Secret pada setiap request admin, dan verifikasi GET /admin/me. Logout/reload menghapus credential dan data sensitif; jangan membuat sesi/token palsu.

Hubungkan list/detail/summary sesuai kontrak. Ubah detail dari confirm-payment khusus QRIS menjadi dropdown PENDING/COMPLETED/CANCELLED dan PATCH /admin/orders/{order_id}/status dengan status + expected_status. NEEDS_REVIEW lama tetap terbaca. Tambahkan konfirmasi untuk setiap perubahan; dukung koreksi status; kunci double-submit dan wajib refresh setelah timeout/409.

Tambahkan input nomor WA dan aksi simpan/edit/kosongkan sesuai B11, dengan expected_wa_number, konfirmasi pengosongan, penanganan konflik, dan link chat yang aman. Jangan menambah bot/webhook atau mengubah landing page.

Sembunyikan export dan fitur role FINANCE, hilangkan syarat payment_method=QRIS. Label COMPLETED adalah Sudah dibayar; total_transaction_value adalah Nilai semua pesanan, bukan omzet. Set konfigurasi lokal ke URL backend yang benar, ADMIN_API_ENABLED=true dan DEMO_ENABLED=false setelah verifikasi; jangan fallback ke fixture demo saat API gagal.

Jangan menaruh secret dalam config.js/.env frontend atau storage browser. Jangan menambahkan framework/bundler atau mengubah MKWU-WEB dan schema database. VITE_API_URL adalah konstanta publik existing.

Jalankan tes frontend yang sesuai dan perbarui test fixture agar mencerminkan kontrak baru. Pisahkan hasil tes mock dari pengujian backend nyata. Jika backend lokal tidak tersedia, sediakan langkah tes manual yang tepat dan nyatakan batas verifikasi. Dokumentasikan perintah menjalankan HTTP server dashboard pada port terpisah dari landing page, serta origin yang perlu ditambahkan pengguna ke ALLOWED_ORIGINS. Jangan mengedit .env backend asli, deploy, atau mengubah transaksi asli tanpa instruksi.

Tangani 429/413/503 dan error non-JSON dari edge tanpa retry otomatis berulang. Sesuaikan security headers/CSP sesuai B12 tanpa merusak asset dan API.

Selesaikan implementasi dan laporkan perubahan serta hasil tes aktual, termasuk konfigurasi keamanan hosting yang belum diterapkan.
```
