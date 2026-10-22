# Kontrak admin final

Diperbarui 20 Oktober 2026 berdasarkan pemeriksaan read-only source aktual `E:/cheesecake-api/admin.py`, `admin_schemas.py`, serta `docs/delete-order.md`. Source kini memuat metode pembayaran QRIS/CASH/null dan endpoint DELETE dengan expected_status pada query. Catatan sebelumnya bahwa source lokal belum memuat metode pembayaran sudah tidak berlaku. Backend tidak diubah pada task penyelesaian dashboard ini. `.env` asli tidak dibaca/ditulis dan endpoint backend/DB asli tidak diakses.

Semua endpoint admin memakai `X-Admin-Secret`, `credentials: "omit"`, no-store. Identitas tetap `{"id":"admin","name":"Admin","role":"ADMIN"}`. Tidak ada login/logout endpoint atau token.

| Method/path | Input dan hasil |
| --- | --- |
| GET `/admin/me` | Identitas tetap setelah verifikasi password |
| GET `/admin/orders` | search trim max 64; status empat nilai; page >=1; page_size 1–100; `{items,total,page,page_size}` |
| GET `/admin/orders/{order_id}` | Detail lengkap termasuk nullable wa_number, subtotal, discount, items snapshot |
| PATCH `/admin/orders/{order_id}/status` | `{status,expected_status}`; `{order,changed}` |
| PATCH `/admin/orders/{order_id}/contact` | `{wa_number,expected_wa_number}` keduanya wajib nullable; `{order,changed}` |
| PATCH `/admin/orders/{order_id}/payment-method` | `{payment_method,expected_payment_method}` kedua field wajib; masing-masing `"QRIS"`, `"CASH"`, atau `null`; `{order,changed}` |
| DELETE `/admin/orders/{order_id}?expected_status=PENDING` | expected_status wajib dari detail terakhir; tanpa body; sukses **204 No Content** tanpa JSON |
| GET `/admin/summary` | total_orders, total_transaction_value, confirmed_payments, pending_payments |

Row: order_id (mapping orders.id), customer_name, status, total integer rupiah, payment_method QRIS/CASH/null, created_at ISO timezone. Urutan backend created_at DESC lalu id DESC. Kontak hanya di detail. Detail items memakai product_name/topping/qty/unit_price/subtotal snapshot; order subtotal/discount/total tidak dihitung ulang browser. Adapter memvalidasi metode pada list, detail, dan seluruh respons mutation; nilai lain atau field hilang ditolak.

Metode ditampilkan QRIS → QRIS, CASH → Tunai, null → Belum ditentukan. Contoh payload: `{"payment_method":"QRIS","expected_payment_method":null}`. Kedua field harus hadir, termasuk ketika null; nilai invalid, missing, atau extra ditolak backend dengan 422 sesuai kontrak. Expected dikirim persis dari detail terakhir, bukan pilihan draft. Respons `{"order":OBJEK_DETAIL_LENGKAP,"changed":true}` memuat metode terbaru pada semua mutation, termasuk status/kontak.

CAS pembayaran atomik hanya mengubah payment_method, memfilter id dan expected (IS NULL untuk null). Order hilang → 404; nilai terbaru berbeda dari expected dan tujuan → 409; nilai terbaru sudah sama tujuan → 200 changed=false; update berhasil → 200 changed=true. Tidak ada update tanpa kondisi atau retry mutation otomatis. Status, kontak, harga, item, subtotal, diskon, dan total tetap; memilih QRIS bukan konfirmasi penerimaan dana. COMPLETED tetap manual. Tidak ada perubahan pemesanan customer/create_order, default, atau backfill. Database tidak diperiksa atau diubah dalam pekerjaan dashboard ini.

Status baca: PENDING, COMPLETED, CANCELLED, NEEDS_REVIEW. Target PATCH hanya tiga pertama. expected_status menerima keempatnya. Koreksi dua arah dan no-op sah, tanpa syarat QRIS. Backend melakukan compare-and-set; jika stale tetapi nilai terkini sudah sama tujuan, respons changed=false; konflik lain 409. UI selalu konfirmasi, lalu GET ulang sesudah sukses.

Kontak baru: string maksimum 32 karakter, ASCII digit, plus awal opsional, spasi/kurung/minus. Hilangkan pemisah, ubah 08 menjadi 628 dan +62 menjadi 62; canonical `^628[0-9]{7,12}$`. Input kosong ditolak; aksi Kosongkan mengirim null setelah konfirmasi. expected_wa_number harus persis dari GET terakhir, termasuk separator/whitespace legacy, tidak dinormalisasi. Backend CAS null menggunakan IS NULL. Link chat hanya dari canonical exact, tanpa URL bebas. Validasi format bukan verifikasi akun aktif/pemilik.

Summary seluruh data: total_orders semua status; total_transaction_value jumlah semua total termasuk CANCELLED (label Nilai semua pesanan); confirmed_payments hanya COMPLETED (Sudah dibayar); pending_payments hanya PENDING, tanpa NEEDS_REVIEW. Angka tidak mengikuti filter/pagination. Backend menolak pekerjaan summary yang melampaui batas/deadline dengan 503, bukan angka parsial. Dashboard memuat summary dan list secara independen. Error summary non-autentikasi hanya mengosongkan statistik dengan label Tidak tersedia dan pesan terpisah; list tetap terlihat saat sukses. Error list tidak menghapus summary yang sukses. Error autentikasi dari salah satunya mengunci dan membersihkan seluruh dashboard.

Ketiga PATCH hanya mengirim dua field kontrak, tanpa harga/items/identitas. changed=false berarti idempotent/no-op. 401 membersihkan akses; 403 ditangani dengan keluar lokal; 404 tidak ada; 409 wajib refresh; 413 input berlebih; 422 invalid; 429 tunggu manual; 503 gangguan sementara/deadline. HTML edge dan kegagalan CORS tidak diasumsikan JSON. Tidak mengulang mutation otomatis, karena timeout dapat terjadi sesudah commit.

## Hapus satu pesanan

Tombol **Hapus pesanan** tersedia di detail hanya untuk PENDING, NEEDS_REVIEW, atau CANCELLED. Guard handler memeriksa status detail tersimpan juga; draft dropdown status tidak mengubah izin hapus. COMPLETED tidak dapat dihapus. Tidak ada bulk delete atau perubahan status otomatis.

Dialog menjelaskan bahwa pesanan dan rincian item dihapus permanen. Konfirmasi baru aktif bila admin mengetik Order ID persis, tanpa trim atau pengabaian kapitalisasi. Batal/Escape tidak mengirim DELETE. Penghapusan memakai lock mutation yang sama dengan ketiga editor, sehingga double-submit dan penyimpanan editor lain tidak mengirim mutation tambahan.

Contoh request: `DELETE /admin/orders/ORD-K7MPQ?expected_status=CANCELLED`. Adapter mengirim status persis dari detail terakhir sebagai query parameter, tanpa body maupun Content-Type JSON. `X-Admin-Secret`, credentials omit, cache no-store, timeout dan sanitasi error tetap digunakan. Respons 204 diterima tanpa pemeriksaan Content-Type atau parsing JSON. Sukses dengan status selain 204 dianggap hasil tidak pasti.

Kontrak backend: conditional DELETE memfilter id dan expected_status. PENDING/NEEDS_REVIEW/CANCELLED dapat dihapus jika cocok; status berubah atau COMPLETED menghasilkan 409; order hilang menghasilkan 404; ID/query hilang atau invalid menghasilkan 422. Expected COMPLETED valid secara tipe backend tetapi tidak mengizinkan penghapusan. Rincian item bergantung pada FK ON DELETE CASCADE existing; mock frontend tidak membuktikan perilaku database tersebut.

Setelah 204, detail ditutup dan dibersihkan, daftar dan summary dimuat ulang. Bila halaman terakhir kosong, dashboard menghitung halaman valid dari total terbaru dan memuatnya. Setelah 409, seluruh mutation terkunci hingga GET detail berhasil; GET gagal tidak membuka tombol. Timeout, hasil tidak pasti, error server atau DELETE 404 memicu pemeriksaan GET detail tanpa retry DELETE. GET 404 menutup detail dan memperbarui daftar; GET sukses menampilkan data terbaru serta mempertahankan draft kontak. GET gagal menyediakan retry baca manual dan tetap mengunci mutation. Tindakan hapus berikutnya memerlukan konfirmasi baru.

Logout/401 membersihkan credential, baris daftar, detail, draft, input konfirmasi Order ID dan dialog. CORS source backend menerima GET/POST/PATCH/DELETE, Content-Type/X-Admin-Secret, credentials false. Origin aktual adalah konfigurasi pengguna yang belum diverifikasi. [Panduan lokal dan pengujian nyata](MANUAL-TEST.md).

## Kontrak tambahan — tambah pesanan, edit data, dan bukti pembayaran

Ditambahkan 22 Oktober 2026 atas permintaan tim: CRUD per pesanan (tambah pesanan manual, edit nama pelanggan, edit item, catatan admin) dan foto bukti pembayaran (beberapa foto per pesanan, bisa diganti/dihapus). Ini menggantikan batas lama di PRD Revisi 2 ("tidak ada edit item / pembuatan order admin"). **Dashboard sudah mengimplementasikan sisi klien; backend `cheesecake-api` belum.** Sampai backend mengikuti bagian ini, dashboard tetap berjalan seperti sebelumnya dan detail menampilkan pemberitahuan bahwa fitur menunggu backend.

### Penanda dukungan

Backend yang mengikuti kontrak ini **wajib** menyertakan `note` dan `payment_proofs` pada setiap detail (`GET /admin/orders/{id}` dan semua respons mutation). Dashboard memakai keberadaan kedua field itu sebagai penanda; tanpa keduanya editor nama/item/catatan/bukti tidak ditampilkan.

Tambahan pada objek detail:

| Field | Tipe | Keterangan |
| --- | --- | --- |
| `note` | string ≤500 atau null | Catatan internal admin, tidak pernah dikirim ke endpoint publik |
| `payment_proofs` | array ≤5 | `{proof_id, content_type, size, created_at}`; `proof_id` `^[A-Za-z0-9_-]{1,64}$`, `content_type` `image/jpeg`/`image/png`/`image/webp`, `size` byte, `created_at` ISO + timezone. Urutan stabil (created_at ASC) |
| `items[].product_id` | string atau null (opsional) | ID katalog dari order_items; membantu prefill editor item. Jika tidak ada, dashboard mencocokkan `product_name` ke nama katalog |

Opsional pada baris daftar: `proof_count` (integer ≥0) untuk ikon foto di tabel.

### Endpoint baru

Semua `/admin/*` memakai `X-Admin-Secret`, `Cache-Control: no-store`, error generik, dan tanpa retry otomatis dari dashboard. Mutation PATCH/PUT/POST mengembalikan `{"order": OBJEK_DETAIL_LENGKAP, "changed": bool}` kecuali disebut lain.

| Method/path | Body | Hasil dan aturan |
| --- | --- | --- |
| GET `/products` (publik, sudah ada) | — | Katalog untuk editor item. Dashboard **tidak** mengirim secret ke endpoint ini |
| POST `/admin/orders` | `{customer_name, items, wa_number, payment_method, note}` — kelima field wajib hadir; `wa_number`/`payment_method`/`note` boleh null | **201** `{"order": DETAIL}`. Status awal PENDING. Header `Idempotency-Key` (UUID): request ulang dengan kunci sama dalam ±24 jam mengembalikan order yang sama, bukan membuat order baru. Harga/diskon/total dihitung server seperti POST /orders publik (RPC create_order existing boleh dipakai). `wa_number` dinormalisasi seperti endpoint contact |
| PATCH `/admin/orders/{id}/customer` | `{customer_name, expected_customer_name}` | Nama 1–100 karakter setelah trim, tanpa karakter kontrol. CAS seperti contact: nilai terkini ≠ expected dan ≠ target → 409; sudah sama target → changed=false |
| PATCH `/admin/orders/{id}/note` | `{note, expected_note}` | `note` string 1–500 setelah trim, atau null untuk mengosongkan. CAS null memakai IS NULL |
| PATCH `/admin/orders/{id}/items` | `{items: [{product_id, topping, qty}], expected_items: [{product_name, topping, qty, unit_price}]}` | Mengganti seluruh item. Validasi sama dengan POST /orders (1–30 item, qty 1–99, product_id & topping dari katalog). `expected_items` = snapshot persis dari detail terakhir (urutan item sama); berbeda → 409. Status COMPLETED → 409 (item pesanan lunas dikunci). Server menghitung ulang subtotal, diskon Paket Bestie, dan total, lalu mengganti order_items dalam **satu transaksi/RPC** |
| GET `/admin/orders/{id}/payment-proofs/{proof_id}` | — | Byte gambar dengan `Content-Type` image/jpeg/png/webp dan `no-store`. Dashboard menampilkannya lewat `blob:` URL |
| POST `/admin/orders/{id}/payment-proofs` | Byte gambar mentah; `Content-Type: image/jpeg` (dashboard selalu mengirim JPEG hasil kompresi) | **201/200** `{order, changed:true}`. Tolak >5 foto → 409, tipe/isi bukan gambar (cek magic bytes) → 415/422, >1,5 MiB → 413 |
| PUT `/admin/orders/{id}/payment-proofs/{proof_id}` | Byte gambar mentah | Mengganti foto; boleh memberi `proof_id` baru. Foto lama dihapus dari storage. Proof tidak ada → 404 |
| DELETE `/admin/orders/{id}/payment-proofs/{proof_id}` | — | **204** tanpa body. Status pesanan tidak berubah |

Bukti pembayaran **tidak** mengubah status atau metode pembayaran; COMPLETED tetap keputusan manual admin.

### Penyimpanan foto (rekomendasi backend)

- Supabase Storage bucket **private** (misalnya `payment-proofs`), path `{order_id}/{proof_id}.jpg`, diakses hanya dengan service role dari backend. Jangan membuat bucket publik atau signed URL yang dikirim ke browser.
- Tabel baru `payment_proofs(id text pk, order_id fk on delete cascade, storage_path, content_type, size_bytes, created_at)`, atau kolom jsonb di orders. Kolom baru `orders.note text null`. Ini perubahan schema yang perlu migration.
- DELETE pesanan juga harus menghapus file di storage (FK cascade hanya menghapus baris).
- Batas body Vercel Function ±4,5 MB; dashboard mengompres foto ke JPEG ≤1,5 MiB (sisi terpanjang ≤2000 px, metadata EXIF/lokasi terbuang) sehingga aman di bawah batas itu. Batas body 16 KiB B12 tetap untuk JSON; endpoint upload perlu batas sendiri 1,5 MiB.
- Rate limit B12 `/admin/*` juga mencakup upload.

### CORS dan header

Tambahkan ke backend: `allow_methods` **POST, PUT** (selain GET, PATCH, DELETE) dan `allow_headers` **Idempotency-Key** (selain Content-Type, X-Admin-Secret). Dashboard: CSP `img-src 'self' blob:` (index.html + vercel.json) untuk menampilkan foto dari blob URL; `connect-src` tidak berubah.

### Perilaku dashboard

- Tombol **Tambah pesanan** membuka form: nama, baris item (produk/topping/jumlah dari katalog), nomor WA opsional, metode pembayaran, catatan. Perkiraan subtotal hanya informasi; total final dari server. Error tidak pasti (timeout/5xx) meminta admin mengecek daftar dulu; simpan ulang tanpa mengubah form memakai `Idempotency-Key` yang sama, mengubah form membuat kunci baru.
- Detail: editor **Nama pelanggan**, **Item pesanan** (Ubah item → baris editable → Simpan item; dikunci untuk COMPLETED), **Catatan admin** (Simpan/Kosongkan), dan **Bukti pembayaran** (thumbnail, lihat besar, unduh, Ganti, Hapus, Tambah foto multi-pilih). Semua perubahan memakai dialog konfirmasi + checkbox, kecuali tambah foto (tidak destruktif).
- Setiap editor disimpan terpisah dengan `expected_*` dari GET terakhir. Setelah sukses: GET ulang detail, daftar, ringkasan. Setelah error/timeout: semua editor terkunci sampai detail dimuat ulang. Upload beberapa foto dikirim berurutan dan berhenti pada kegagalan pertama tanpa retry.
- Logout/401 menutup dialog, membersihkan form tambah pesanan, dan mencabut semua blob URL foto.
