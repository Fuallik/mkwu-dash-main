# Keamanan dashboard dan batas verifikasi

## Diterapkan pada source

- Password hanya di memori modul; GET /admin/me untuk verifikasi, X-Admin-Secret pada semua request admin, credentials omit, no-store, redirect error, timeout 15 detik. Tidak ada storage browser/credential config atau token/sesi buatan. Logout/navigasi menghapus data dan membatalkan fetch aktif.
- Escaping/textContent untuk data server, validasi envelope/snapshot/mutation, konfirmasi semua simpan dan kosongkan, penguncian submit, nilai expected untuk CAS. Tidak ada retry otomatis mutation, polling summary, atau fallback demo. Setelah error mutation, GET detail yang berhasil wajib mendahului simpan berikutnya. Draft kontak dipertahankan dengan pemberitahuan.
- Nomor baru mengikuti format B11. Link hanya dari canonical exact, bukan URL bebas/draft/legacy, dengan noopener noreferrer dan no-referrer. Nomor tersimpan dibaca apa adanya untuk koreksi legacy. Tidak ada bot/webhook.
- `vercel.json`: CSP, frame-ancestors none, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, Permissions-Policy dan Cache-Control no-store. Meta CSP membatasi script/style/asset/connect pada server statis biasa; frame-ancestors memerlukan header HTTP. `tools/serve.py` menerapkan header ini untuk verifikasi lokal.
- CSP connect-src konkret untuk lokal `http://127.0.0.1:8000`, tanpa wildcard HTTPS/unsafe script. Sebelum publikasi, ganti VITE_API_URL dan kedua CSP (index.html + vercel.json) ke origin API HTTPS yang sebenarnya. HTTP hanya untuk loopback.

## Bukti lokal dan batasnya

Browser menguji asset lokal, fetch lintas origin, preflight, header/CSP, escaping dan link aman terhadap mock. Adapter menguji request payload, error edge non-JSON, abort/logout dan login terlambat. Ini tidak membuktikan security headers deployment, WAF aktif, CORS environment asli, privilege/RLS Supabase, atau konkurensi DB live. Backend lokal tidak tersedia saat pengecekan port 8000. Tidak ada `.env` asli yang dibaca/diubah, deploy, mutation data nyata, atau perubahan MKWU-WEB/schema.

## Belum diterapkan pada hosting

Pengguna perlu memilih origin HTTPS konkret dan mengizinkannya pada ALLOWED_ORIGINS tanpa menghapus origin landing page, lalu memverifikasi header aktual setelah deploy. Metadata noindex bukan autentikasi; source frontend/URL API tetap publik.

B12 meminta rate limit di edge pada project backend, mencakup **seluruh /admin/** serta POST /orders publik. Profil usulan SRS: admin 60 request/menit/IP dan POST order 10/menit/IP jika rule terpisah tersedia; opsional /admin/me lebih ketat. Jika paket hanya menyediakan satu rule, evaluasi rule gabungan 30/menit/IP dan tradeoff bucket bersama. Sesuaikan dengan kemampuan paket/account aktual; tidak ada klaim rule ini sudah aktif. Jangan memasukkan OPTIONS ke bucket mutation atau mengandalkan dictionary proses Python. Fetch perlu 429 yang terbaca; challenge HTML/CORS yang hilang dapat tampil sebagai gangguan koneksi generik. Observasi lalu enforce dan uji traffic kecil terkontrol pada lingkungan yang disetujui. Tidak melakukan stress test.

Belum diverifikasi: WAF/rate limiting dan domain alias, HTTPS/HSTS hosting, scope secret preview/production dan rotasinya, MFA GitHub/Vercel/Supabase, privilege/RLS/RPC, monitoring 401/429/5xx/latensi/usage/pertumbuhan PENDING, serta notifikasi biaya sesuai paket. Alert biaya bukan hard cap. Saat spam, operator mengikuti panduan backend untuk pengetatan rule atau penghentian POST /orders di edge/NEW_ORDERS_ENABLED; dashboard tidak mengubah kill switch. Jangan menonaktifkan auth/RLS untuk mengatasi gangguan.

Publikasi belum dilakukan. Pengaturan di atas dan tes backend nyata tetap menjadi pekerjaan operator sebelum penggunaan publik.

## Tambahan 22 Oktober 2026 — bukti pembayaran

- Foto bukti pembayaran berisi data finansial pembeli. Dashboard membacanya hanya lewat `GET /admin/orders/{id}/payment-proofs/{proof_id}` dengan `X-Admin-Secret`, lalu menampilkannya dari `blob:` URL yang dicabut saat detail ditutup, dimuat ulang, atau logout. Tidak ada URL storage publik/signed URL di browser.
- CSP `img-src 'self' blob:`; respons foto selain image/jpeg/png/webp (misalnya SVG) ditolak adapter.
- Foto dikompres ulang di browser menjadi JPEG sehingga metadata EXIF (termasuk lokasi GPS) tidak ikut terunggah. Backend tetap wajib memvalidasi magic bytes, ukuran, dan jumlah foto.
- Katalog `/products` dipanggil tanpa secret admin.
