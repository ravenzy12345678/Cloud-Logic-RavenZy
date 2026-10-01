# RAVEN — Large Flutter Build (Telegram → GitHub Actions → APK)

## Target flow

`BUILD FLUTTER → pilih DEBUG/RELEASE → kirim Base Project Flutter ZIP langsung ke bot → GitHub Actions mengambil file melalui Telegram MTProto → validasi project → backup source ke private GitHub release asset → Flutter stable + Java 17 + Android SDK → flutter pub get → flutter build apk → APK dikirim kembali langsung ke chat user.`

## User tidak perlu memasukkan

- URL GitHub
- URL repository
- URL ZIP / HTTPS source
- `TELEGRAM_API_ROOT`
- Telegram Local Bot API

Alur Flutter large-file berjalan dari GitHub Actions dengan Telethon/Telegram MTProto. `TELEGRAM_API_ROOT` hanya dipertahankan sebagai konfigurasi opsional untuk fitur lama yang memang menggunakannya.

## Batas source

Flow direct-build menggunakan batas `2,147,483,647` bytes (sekitar 2 GiB minus 1 byte). Batas ini dipilih agar tetap berada di bawah batas per-file GitHub Release Asset yang berlaku untuk storage source.

GitHub juga tidak dipakai untuk menyimpan ZIP besar di Git tree repository; source disimpan sebagai **release asset** pada repository private `raven-build-storage`.

## Secrets GitHub Actions

Tambahkan pada repository builder utama:

- `TOKEN_BOT` — token bot Telegram yang sama dengan Vercel.
- `TOKEN_GITHUB` — PAT/token GitHub dengan akses ke repository builder dan repository private `raven-build-storage`; token harus dapat menjalankan repository dispatch dan release API yang dipakai workflow.
- `TELEGRAM_API_ID` — API ID Telegram.
- `TELEGRAM_API_HASH` — API hash Telegram.

Tidak perlu menambahkan `TELEGRAM_API_ROOT` untuk direct Flutter build.

## Storage repository

Workflow memakai repository private:

`<akun-GitHub-token> / raven-build-storage`

Jika repository belum ada, workflow mencoba membuatnya sebagai private repository dan melakukan bootstrap commit apabila repository kosong sehingga release dapat dibuat dengan aman.

## Isi Base Project Flutter

Project minimal yang dibutuhkan:

- `pubspec.yaml`
- `android/`
- `lib/`
- `assets/` dan file project lain yang memang digunakan aplikasi

Flutter SDK, Android SDK, `.dart_tool`, `build`, Gradle cache, `.git`, IDE metadata, `node_modules`, dan folder generated tidak perlu dimasukkan ke ZIP.

## Validasi ZIP

Workflow memeriksa:

- ukuran ZIP maksimum;
- jumlah entry ZIP;
- path traversal / absolute path;
- total uncompressed size;
- keberadaan `pubspec.yaml`, `android/`, dan `lib/`;
- root folder project Flutter tunggal bila ZIP dibungkus satu folder.

## Progress build

Progress dibuat monoton agar status tidak turun karena callback terlambat:

`2 → 4 → 22 → 38 → 54 → 60 → 68 → 78 → 90 → 95 → 100`

Download/upload byte-progress tidak boleh menurunkan progress tahap utama.

## Channel / chat UI

Status build memakai format premium yang berisi informasi User, User ID, Project, Mode, Source, Source size, APK size, Server, Developer, Build ID, Stage, Status, Progress, Durasi, dan waktu selesai.

Asset yang dipakai hanya asset existing project:

- `assets/raven-welcome.jpg`
- `assets/raven-goodbye.jpg`
- `assets/raven-response.jpg`
- `assets/raven-build-success.jpg`

Tidak ada gambar/icon baru yang diperlukan.

## Persistence session Vercel

Karena Vercel bersifat serverless, pilihan DEBUG/RELEASE sementara disimpan pada:

`devtools-raven-pending-sessions.json`

File ini dikelola otomatis dan mempunyai TTL 30 menit agar user tetap dapat mengirim ZIP setelah instance Vercel berganti.

## Workflow files

### Direct Flutter build

`.github/workflows/raven-flutter-telegram-2gb.yml`

Menerima:

- `repository_dispatch` event type `raven_flutter_build` untuk alur bot otomatis;
- `workflow_dispatch` untuk pengujian/manual run.

Job build tidak menggunakan conditional gate yang dapat membuat run menjadi `No jobs were run` setelah dispatch valid.

### Source transfer / GET ZIP BUILD

`.github/workflows/raven-telegram-source-transfer.yml`

Menerima:

- `repository_dispatch` event type `raven_source_transfer`;
- `workflow_dispatch` untuk manual transfer.

## Vercel

Vercel tetap menjadi webhook/API backend bot. Vercel **tidak** mengunduh ZIP 2 GB ke filesystem serverless. Ia hanya mencatat build, mengirim `repository_dispatch` ke GitHub, menerima callback, dan mengelola UI/fitur bot.

## File baru / tambahan

- `.github/workflows/raven-flutter-telegram-2gb.yml`
- `.github/workflows/raven-telegram-source-transfer.yml`
- `scripts/raven-telegram-mtproto.py`
- `devtools-raven-pending-sessions.json`
- `RAVEN-LARGE-FLUTTER-SETUP.md`
