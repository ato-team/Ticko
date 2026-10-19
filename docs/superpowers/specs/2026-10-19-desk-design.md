# Desk Ticko — Desain

- **Tanggal:** 2026-10-19
- **Status:** approved (2026-10-19) — penempatan per tugas di vault `Ticko Backlog` v2.2 §0
- **Produk (kenapa):** vault `Projects/Ticko/Ticko Desk PRD`
- **Ruang lingkup:** `apps/desk/` + permukaan API, skema, dan worker yang dibutuhkannya
- **Mockup:** `docs/superpowers/specs/2026-10-19-desk-mockups/`

Dokumen ini menjelaskan **bagaimana** desk dibangun. Alasan produk, persona, dan KPI ada
di PRD desk. Kalau keduanya berbeda, dokumen yang lebih baru menang dan yang lain
diperbarui di turn yang sama.

---

## 1. Maksud

Ticko dipakai **umum**: setiap perusahaan memasang satu instalasi Ticko sendiri
(single-tenant), dan yang mengoperasikannya sehari-hari adalah **orang non-IT** — agent CS
dan supervisor/pemilik usaha. Developer hanya memasang instalasinya.

Sampai sekarang perilaku bot diatur lewat file di repo (FR-9). Itu cocok untuk developer,
tapi membuat supervisor tidak bisa mengubah apa pun tanpa developer. Desk menggantikan
peran itu: **satu website untuk bekerja, memantau, dan mengatur** Ticko, dengan bahasa
sehari-hari.

Dua hal yang paling ditakuti (anti-goal utama, dari user):

1. **Terlalu banyak istilah teknis.**
2. **Setup yang ribet.**

Setiap keputusan di bawah diuji terhadap dua hal itu.

## 2. Peran

Skema sudah punya `user_role = admin | agent` (`packages/storage/src/schema.ts:31`). Tidak
ada peran baru.

| Peran di DB | Nama di layar | Bisa |
|---|---|---|
| `agent` | **Agent CS** | Inbox, percakapan yang ia tangani, ambil alih / kembalikan ke bot, balas, template balasan, status online/sibuk/istirahat miliknya |
| `admin` | **Supervisor** | Semua milik Agent CS + Beranda, semua percakapan, Laporan, Pengaturan (termasuk "Lanjutan"), Tim, Jeda bot |

- Menu Pengaturan **tidak dirender** untuk Agent CS, **dan** setiap route `/api/settings*`,
  `/api/team*`, `/api/bot*`, `/api/plugins*`, `/api/mcp*`, `/api/audit*` menolak `agent`
  dengan `403 FORBIDDEN`. UI menyembunyikan, API yang menegakkan.
- Pemilik usaha = Supervisor. Peran ketiga tidak dibuat sampai ada kebutuhan nyata.

## 3. Tujuan, bukan-tujuan, anti-goal

**Tujuan**

- Agent CS menyelesaikan seluruh kerja harian (FR-5, FR-6) dari desk.
- Supervisor non-IT menyiapkan instalasi baru sampai bot menjawab pelanggan pertama
  **tanpa membuka terminal atau file**.
- Supervisor bisa menghentikan bot kapan saja (Jeda bot) dan melihat apa yang dilakukan
  bot beserta alasannya.
- Semua yang sekarang diatur file dan sifatnya **bisnis** bisa diubah dari desk.

**Bukan tujuan (fase ini)**

- Multi-tenant. Tapi desain tidak boleh menutup jalannya (§5.6).
- Plugin buatan pihak ketiga, marketplace, sandbox kode plugin.
- Aplikasi mobile native, SSO, chat internal antar agent, transfer antar agent
  (tetap mengikuti PRD §5.3).
- Workflow builder visual. SOP ditulis sebagai teks berlangkah, bukan diagram.
- Mengubah pengaturan **instalasi** dari desk (URL database, Redis, kunci enkripsi,
  domain publik, kunci API LLM). Itu tetap file/env milik developer yang memasang.

**Anti-goal — gagal walau secara teknis berfungsi**

- Ada istilah teknis di layar Agent CS atau di bagian utama Pengaturan (aturannya §8).
- Setup butuh bantuan developer setelah instalasi.
- Pengaturan bisa membuat bot **berhenti eskalasi** pada pemicu wajib (melanggar guardrail #7).
- Satu klik di desk bisa membuat bot mengambil alih percakapan yang sedang dipegang manusia
  (melanggar guardrail #1/#2).
- Kredensial (token, API key) bisa dibaca kembali dari browser.

## 4. Batasan

- **Guardrail AGENTS.md berlaku penuh.** Khususnya: `control_owner` tetap diperiksa di
  dispatcher sebelum LLM; tidak ada `setTimeout`/`setInterval` di luar
  `worker/src/poller.ts` dan `apps/desk/src/lib/tick.ts` (keputusan 2026-09-17); semua waktu
  UTC di API; tanpa framework agent.
- **Kontrak 7 tetap:** same-origin di belakang Caddy, cookie `httpOnly`, tipe diimpor dari
  `@ticko/domain`, error `{ error: { code, message } }`, frontend hanya bercabang pada `code`.
- **Stack desk (sudah diputuskan di PRD §6.5 / B-0.8):** Vite + React + TypeScript strict +
  TanStack Router + TanStack Query + Tailwind + shadcn/ui. Realtime lewat SSE
  `/api/stream` yang sudah ada.
- **Pub/sub at-most-once** (keputusan 2026-09-27): desk wajib refetch setiap kali
  `EventSource` tersambung ulang. Event hanya pemicu refresh; sumber kebenaran DB.
- PR ≤ 400 baris bila memungkinkan; test double ikut di PR yang sama dengan interface-nya.

## 5. Struktur desk

### 5.1 Navigasi

```
Agent CS     : Inbox · Template balasan                      [status: Online ▾]
Supervisor   : Beranda · Inbox · Percakapan · Laporan · Pengaturan   [Jeda bot] [status ▾]
```

Agent CS yang membuka `/` diarahkan ke `/inbox`. Supervisor ke `/beranda`.

### 5.2 Beranda (Supervisor) — arah A yang dipilih

Dua mode, ditentukan otomatis:

1. **Selama setup belum lengkap:** kartu "Siapkan bot Anda — X dari N selesai" berisi
   langkah-langkah, masing-masing tombol ke halaman pengaturannya.
2. **Setelah lengkap:** checklist menyusut jadi satu baris ("Setup lengkap ✓ — lihat"),
   beranda menampilkan ringkasan hari ini: menunggu manusia, ditangani bot, melewati SLA,
   status bot (aktif / dijeda / di luar jam kerja), dan peringatan yang butuh tindakan
   (mis. "Telegram terputus").

**Checklist dihitung dari kondisi nyata, bukan dari klik.** Endpoint
`GET /api/setup/status` menghitung setiap langkah saat dipanggil:

| Langkah | Wajib | Ada sejak | Selesai bila (dicek saat endpoint dipanggil) |
|---|---|---|---|
| Sambungkan Telegram | ✔ | A | kredensial ada (env di Fase A, DB sejak Fase B) **dan** `getWebhookInfo` mengembalikan URL webhook instalasi ini tanpa `last_error_message` baru |
| Tim siap menerima pelanggan | ✔ | A | ada ≥ 1 user aktif. Jalur handoff tidak dicek saat runtime: Fase A dirilis bersama Sprint 3, jadi kodenya pasti ada |
| Kenalkan bot (persona) | ✔ | B | `settings.persona` pernah disimpan oleh manusia (`updated_by` tidak NULL — default hasil impor tidak cukup, supervisor harus melihat dan menekan Simpan sekali) |
| Informasi usaha | ✔ | B | `settings.company.name` terisi |
| Dokumen untuk bot | – | B | ≥ 1 dokumen berstatus `ready` |
| Jam kerja | – | B | `settings.time_policy.updated_by` tidak NULL |
| Coba ngobrol dengan bot | – | B | `settings.setup_marks.playgroundAt` terisi (§7.8) |
| SOP | – | C | ≥ 1 SOP aktif |

`getWebhookInfo` dipanggil **saat endpoint dipanggil** (dengan `AbortSignal.timeout`), bukan
oleh timer. Kalau Telegram tidak menjawab, langkah ditampilkan "Tidak bisa dicek sekarang"
— bukan ✅ dan bukan ❌.

**Bot tidak menjawab pelanggan sebelum semua langkah wajib ✔ dan supervisor menekan
"Aktifkan bot".** Lihat §6.3.

### 5.3 Pengaturan — bertingkat

Halaman utama Pengaturan, urutan tetap:

| Grup (label di layar) | Isi | Fase |
|---|---|---|
| Kenalkan bot | Nama bot, gaya bicara (template), salam pembuka, topik yang tidak boleh dibahas | B |
| Saluran | Telegram (sambungkan / putuskan / status) | B |
| Informasi usaha | Nama, alamat, kontak, jam buka singkat, kebijakan inti (teks bebas) | B |
| Dokumen untuk bot | Upload / tempel teks FAQ, status baca | B |
| Jam kerja & hari libur | Jadwal mingguan, hari libur, pesan di luar jam kerja | B |
| Kapan bot memanggil manusia | Pemicu yang bisa diatur (§7.6) | B |
| Template balasan | Canned response untuk Agent CS | A |
| Tim | Undang, nonaktifkan, ubah peran | B |
| SOP | Panduan langkah demi langkah untuk bot | C |
| Aplikasi terhubung | Katalog plugin resmi | C |
| **▸ Lanjutan** (tertutup default) | Sambungan MCP, batas biaya, pemakaian model (baca saja), varian persona per jadwal, terapkan jam kerja ke jadwal yang sudah ada, riwayat perubahan | B/C |

Setiap halaman punya nilai awal yang sudah bisa dipakai. Tombol Simpan per halaman, bukan
autosave (supervisor non-IT perlu tahu kapan perubahan berlaku).

### 5.4 Inbox & detail percakapan (Fase A)

Mengikuti FR-6 dan Backlog B-2.6, B-3.1, B-3.3–B-3.6 tanpa perubahan perilaku. Tambahan
desk ini hanya:

- Label status dalam bahasa sehari-hari (§8).
- Supervisor melihat semua percakapan; Agent CS melihat miliknya + antrian umum (AC-6.1).
- Panel "Apa yang dilakukan bot" di detail: ringkasan dari `agent_runs` / `tool_calls`
  dalam kalimat ("Bot mencari di dokumen *Kebijakan Retur*", "Bot mengecek pesanan #123 —
  gagal"). Detail mentah (JSON, token, biaya) hanya untuk Supervisor, dalam lipatan
  "Detail teknis". Di Fase A panel ini hanya membaca `agent_runs` ("Bot menjawab", "Bot
  memanggil manusia — alasan: …"), karena `tool_calls` baru ada di A-4.6. Baris tool menyusul
  di tugas itu.

### 5.5 Laporan (Fase A, P1)

FR-12 apa adanya. Tidak ada perubahan di dokumen ini.

### 5.6 Siap multi-tenant, tanpa membangunnya

- Semua tabel baru punya primary key yang bisa diperluas dengan `tenant_id` tanpa mengubah
  arti baris. Tidak ada tabel "satu baris dengan `id = 1`".
- Kode server mengakses pengaturan hanya lewat `SettingsRepo` — tidak ada nilai bisnis yang
  dibaca langsung dari file atau ditanam di kode di luar default.
- Nama route tidak mengandung asumsi tenant (`/api/settings/persona`, bukan
  `/api/company/settings`).

## 6. Fase A — Desk inti

### 6.1 Isi

Backlog yang sudah ada, dikerjakan bersama Sprint 3:

- **B-0.8** scaffold desk + Caddy (keputusan 2026-09-27 bahwa user mengerjakan sendiri
  **dibatalkan**: user meminta desk dibangun, 2026-10-19).
- **B-2.2, B-2.5, B-2.6** login, klien API terketik, inbox.
- **A-3.1–A-3.3, A-3.6** handoff transaksional, penegakan dispatcher, test race, claim.
- **B-3.1–B-3.6** detail, presence, ambil alih & balas, handback, canned response, status UI.

Tambahan di luar Backlog lama:

1. **Penjaga peran di API** (`requireRole('admin')` middleware) + test 403 per route.
2. **Bahasa layar** (§8) diterapkan sejak komponen pertama.
3. **Jeda bot / Aktifkan bot** (§6.3).
4. **Audit log** dimulai di Fase A untuk aksi manusia (AC-6.8), diperluas di Fase B untuk
   perubahan pengaturan.

**Urutan kerja (keputusan 2026-10-19).** PR backend Sprint 2 di-merge ke `development` lebih
dulu. Sesudah itu setiap grup memakai branch baru dari `development` (tidak bertumpuk):

| Grup | Tugas Backlog | Mulai sesudah |
|---|---|---|
| G1 Kerangka desk | B-0.8, B-2.2, B-2.5, B-2.6, B-3.7 (`requireRole`), B-3.8 (`copy/`) | merge Sprint 2 |
| G2 Handoff Integrity | A-3.1, A-3.2, A-3.3, A-3.6, apa adanya | merge Sprint 2 (paralel G1) |
| G3 Kendali bot | A-3.7 (`settings`, `audit_log`, `users.active`), A-3.8 (mode bot), A-3.9 (audit + `GET /api/audit`) | G2 |
| G4 Desk kerja harian | B-3.1 … B-3.6, B-3.9 (Jeda/Aktifkan bot) | G1 + G3 |
| G5 Jam kerja | A-3.4, A-3.5 dari `settings.time_policy`, `PUT /api/settings/:section`, B-3.10 | G3 |

G2 tidak menulis audit. G3 menambahkan penulisan `audit_log` ke transaksi `claim`, lalu test
race A-3.3 diulang 50×. Akun Supervisor pertama di Fase A dibuat lewat
`packages/api/src/create-admin.ts`; sejak Fase B CLI itu mencetak tautan undangan (§7.7).
Teks pemberitahuan ke pelanggan saat bot tidak aktif adalah default di kode server di Fase A.

### 6.2 API baru di Fase A

```
GET    /api/bot/state                → { mode: 'setup' | 'active' | 'paused', pausedBy?, pausedAt? }
POST   /api/bot/activate             (admin) → 409 SETUP_INCOMPLETE bila langkah wajib belum ✔
POST   /api/bot/pause    body: { reason }   (admin)
POST   /api/bot/resume               (admin)
GET    /api/canned-responses
POST   /api/canned-responses         (admin)   PUT/DELETE /:id (admin)
GET    /api/audit        ?from&to&actor&page   (admin)
```

Ditambah permukaan Kontrak 7 yang sudah direncanakan (`claim`, `messages`, `handback`,
`presence`, `metrics`).

### 6.3 Mode bot

`bot_state` adalah satu baris di `settings` (§7.1). **Tabel `settings` dan migrasinya
masuk Fase A**, dengan `bot_state` sebagai satu-satunya section yang dipakai di fase itu.
Section lain menyusul di Fase B. `mode`-nya:

- `setup` — instalasi baru. Bot tidak memanggil LLM.
- `active` — normal.
- `paused` — Supervisor menekan Jeda bot. Bot tidak memanggil LLM.

Penegakan **di dispatcher**, di tempat yang sama dengan pemeriksaan `control_owner`,
sebelum job `agent_run` dibuat — bukan di prompt dan bukan di worker saja. Saat `mode ≠
active`, pesan masuk:

1. tetap disimpan (AC-5.2 tidak berubah),
2. **dieskalasi** lewat jalur handoff Sprint 3 dengan `reason = 'bot_inactive'`,
   `urgency = 'normal'` (guardrail #7: lebih baik ke manusia),
3. pelanggan menerima pesan pemberitahuan AC-15.16.

`mode` **menggantikan** rencana flag `bot_enabled` di AC-15.16, yang belum pernah dibangun.
Percakapan yang sedang `human_active` tidak tersentuh sama sekali. Resume **tidak**
mengembalikan percakapan yang sudah dieskalasi ke bot; itu tetap lewat handback manual.
Transisi status (mis. dari `new` atau `resolved` lewat `bot_active` ke `handoff_requested`)
mengikuti state machine dan jalur handoff Sprint 3 apa adanya. Desk tidak menambah transisi.

**Nol pemanggilan LLM saat dijeda** dijamin di tiga lapis:

1. Transaksi `pause` menyetel `mode = paused` **dan** membatalkan semua job `agent_run`
   yang masih `pending`, persis seperti AC-5.1 membatalkan job saat handoff.
2. Dispatcher membaca `bot_state` dengan `SELECT` biasa di dalam transaksi inbound, tanpa
   lock tambahan, lalu tidak membuat job bila `mode ≠ active`.
3. Worker memeriksa ulang `mode` di awal `agent_run`, di tempat yang sama dengan
   pemeriksaan ulang `control_owner`, lalu membuang job bila `mode ≠ active`. Lapis ini
   menutup celah job yang sudah diambil worker tepat saat pause.

Pemberitahuan AC-15.16 dikirim **sekali per percakapan per periode jeda**, bukan di setiap
pesan.

**Mode awal setelah upgrade:** migrasi mengisi `bot_state.mode = active` bila instalasi
sudah punya kredensial Telegram di env (instalasi yang sudah jalan tidak boleh tiba-tiba
diam), dan `setup` bila belum.

`activate` di Fase A hanya memeriksa langkah wajib yang "Ada sejak A" di tabel §5.2. Di Fase
B, persona dan informasi usaha ikut diperiksa. Karena Fase A dirilis bersama jalur handoff
Sprint 3, bot tidak bisa aktif tanpa eskalasi yang berfungsi. Ini menutup risiko R33.

## 7. Fase B — Setup tanpa IT

### 7.0 Penempatan di sprint (keputusan user 2026-10-19)

Subsistem yang di Backlog direncanakan **berbasis file** dibangun **langsung berbasis
database**, dan halaman desk-nya dibangun di tugas yang sama. Tidak ada versi file yang
nanti dimigrasi. Karena itu Fase B tidak menjadi blok tersendiri sesudah Sprint 5; tiap
bagiannya ikut ke tugas backend yang ada. Prioritas A → B → C tetap.

| Bagian desk | Ditempel ke | Perubahan pada tugas Backlog |
|---|---|---|
| Infrastruktur `settings` + `audit_log` | Fase A (Sprint 3) | baru |
| Jam kerja & hari libur | **A-3.4 / A-3.5** (Sprint 3) | time policy dibaca dari `settings.time_policy`, bukan `config/time.toml` |
| Kenalkan bot, Informasi usaha, Sambungkan Telegram, Tim | tugas baru, Sprint 3–4, **sesudah** A-3.1–A-3.3 | baru |
| Kapan bot memanggil manusia | **A-4.6 / A-4.7** (Sprint 4) | ambang dibaca dari `settings.escalation` |
| Terapkan jam kerja ke jadwal yang sudah ada | **A-4.1** (Sprint 4) | logika AC-16.11 dibangun sebagai fungsi; skrip CLI opsional |
| Dokumen untuk bot | **B-4.4–B-4.6** (Sprint 4) | sumber dari `kb_documents` (upload); **B-4.7 (CLI indexing & file watcher) gugur** |
| Coba ngobrol dengan bot | sesudah **A-4.6** | baru |
| Batas biaya | tugas yang menegakkan batas biaya (US-D4) | dibaca dari `settings.limits` |
| Varian persona per jadwal | **A-5.6** (Sprint 5) | varian dari `settings.persona`, bukan `prompts/agent.{variant}.md` |
| SOP, plugin, MCP (Fase C) | sesudah Sprint 5 | A-4.8 (tool bisnis) kandidat plugin pertama |

Sprint 3 tetap tidak dipercepat (guardrail #2). Tugas desk baru di Sprint 3–4 dikerjakan
**sesudah** jalur Handoff Integrity A-3.1–A-3.3 hijau, bukan paralel di branch yang sama.

### 7.1 Pengaturan pindah ke database

Satu tabel, satu baris per bagian:

```sql
CREATE TABLE settings (
  section     text PRIMARY KEY,         -- 'persona' | 'company' | 'time_policy' | 'escalation'
                                        -- | 'limits' | 'bot_state' | 'channel_telegram' | ...
  value       jsonb NOT NULL,           -- divalidasi Zod per section, tidak pernah di-`as`
  version     integer NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

- Skema Zod per `section` tinggal di `packages/domain/src/settings/`. Time policy
  (FR-15.1) **belum punya loader** dan dibuat langsung untuk DB di A-3.4. Validasi AC-9.2
  (jadwal tumpang tindih, zona tak dikenal) tetap berlaku, hanya waktunya berbeda:
  pelanggaran ditolak **saat simpan** (422 `INVALID_SETTINGS` dengan path field), bukan
  saat start.
- Simpan memakai optimistic locking (`version` dikirim balik; 409 `STALE_SETTINGS` bila
  berubah), supaya dua supervisor tidak saling menimpa diam-diam.
- Setiap simpan menulis `audit_log` (sebelum/sesudah, kredensial disamarkan) dalam
  transaksi yang sama.
- Kredensial tidak pernah ada di `value` — lihat §7.9.

**Apa yang pindah, apa yang tetap**

| Tetap file/env (instalasi) | Pindah ke `settings` (bisnis) |
|---|---|
| `TICKO_DATABASE_URL`, `TICKO_REDIS_URL` | persona (ganti `prompts/agent.md` bagian persona) |
| `TICKO_ENCRYPTION_KEY` (baru) | info usaha |
| `public_url` di `app.toml` (baru, dibutuhkan webhook) | time policy (FR-15.1 → JSON) |
| `TICKO_LLM_API_KEY`, `agent.toml` provider/model/tarif | pemicu eskalasi yang bisa diatur |
| port, logging, `max_connections` | batas biaya per percakapan & harian |
| | token Telegram + webhook secret (terenkripsi, §7.9) |
| | mode bot |

Kunci API LLM tetap env: yang memasang Docker adalah developer, dan memindahkan kunci ke UI
menambah satu kredensial bernilai tinggi yang bisa dibaca dari DB. Desk menampilkan
provider & model **baca saja** di Lanjutan.

**Migrasi dari file:** saat worker/api start dan sebuah `section` belum ada di DB, isinya
diisi sekali lalu ditulis dengan `updated_by = NULL`. Hanya sumber yang memang ada hari ini
yang diimpor: bagian persona dari `prompts/agent.md`, kredensial Telegram dari env. Semua
section lain diisi dari default di kode. Sesudahnya DB yang menang, dan file persona
diabaikan dengan satu warning di log saat start. `prompts/agent.md` dipecah: **inti sistem** (aturan handoff,
pemisah instruksi vs data, larangan mengarang) pindah ke kode dan **tidak bisa diubah dari
desk**; hanya bagian persona yang jadi `settings.persona`.

**Membaca pengaturan di worker:** dibaca dari DB **di awal setiap `agent_run`** (satu query
berindeks, data kecil). Tidak ada cache, tidak ada invalidasi lewat pub/sub, tidak ada
timer. Perubahan berlaku untuk giliran bot berikutnya. Kalau nanti terukur lambat, cache
dengan kunci `version` bisa ditambah — bukan sekarang.

**Timer yang sudah terjadwal (AC-16.10):** perubahan jam kerja berlaku untuk timer baru;
timer pending memakai nilai lama. Lanjutan → "Terapkan ke jadwal yang sudah ada" memanggil
fungsi reschedule AC-16.11 yang dibangun di A-4.1 (belum ada hari ini), lalu ditulis ke
audit.

### 7.2 Sambungkan Telegram

Alur di layar (tanpa kata "token" dan "webhook" di label utama):

1. "Buka @BotFather di Telegram, kirim `/newbot`, ikuti langkahnya" — dengan 3 gambar
   panduan di tempat, bukan tautan ke dokumentasi.
2. "Tempel kode yang diberikan BotFather" → `POST /api/channels/telegram/connect { botToken }`.
3. Server, dalam satu request:
   1. `getMe` → gagal: 422 `TELEGRAM_TOKEN_INVALID` ("Kode bot salah — salin ulang dari
      BotFather").
   2. Buat webhook secret acak (32 byte, base64url).
   3. `setWebhook` ke `{public_url}/webhook/telegram/{secret}` dengan
      `secret_token` header.
   4. `getWebhookInfo` → pastikan URL cocok.
   5. Simpan token + secret terenkripsi; `settings.channel_telegram = { botUsername,
      connectedAt }`.
4. Layar menampilkan "Tersambung ke **@namabot**" + tombol "Buka chat bot".

Kalau `public_url` belum diisi developer: 409 `PUBLIC_URL_MISSING` dengan pesan "Instalasi
belum punya alamat publik — minta orang yang memasang Ticko mengisinya." Langkah ini
satu-satunya titik di mana setup boleh menunjuk ke developer.

**Dampak ke kode yang ada:** `TelegramAdapter` sekarang dibangun dari env saat start
(`packages/domain/src/config/load.ts:104`). Diubah: registry membangun adapter **per
pemakaian** dari kredensial di DB (adapter hanya pembungkus `fetch`, murah dibuat). Route
webhook memverifikasi `:secret` terhadap secret di DB. Env lama tetap dibaca sekali saat
impor awal (§7.1) supaya instalasi yang sudah jalan tidak putus.

"Putuskan" memanggil `deleteWebhook`, menghapus kredensial, dan membuat langkah checklist
kembali ❌; bot otomatis masuk `setup` bila sedang `active`.

### 7.3 Kenalkan bot (persona)

Form, bukan editor prompt:

| Field | Bentuk | Default |
|---|---|---|
| Nama bot | teks | "Asisten {nama usaha}" |
| Gaya bicara | pilihan: Ramah & singkat · Formal · Santai | Ramah & singkat |
| Salam pembuka | teks | dari template gaya |
| Yang tidak boleh dibahas | daftar teks | kosong |
| Bahasa | Indonesia (satu-satunya pilihan di MVP, PRD §5.2) | Indonesia |

Server menyusun bagian persona prompt dari field ini dengan template di kode. Teks persona
masuk **di bawah** inti sistem; inti sistem selalu menang. Varian persona per jadwal
(AC-15.17) ada di Lanjutan sebagai daftar "di jadwal X pakai gaya Y".

### 7.4 Informasi usaha

Field terstruktur (nama, alamat, telepon/WA, email, jam buka ringkas, link toko) + satu
teks bebas "Hal penting yang harus selalu diketahui bot" (kebijakan inti).

Field ringkas disuntikkan ke prompt. **Seluruh isinya juga diindeks otomatis sebagai satu
dokumen pengetahuan bernama "Informasi usaha"**, supaya AC-8.3 (klaim harga/kebijakan wajib
didukung potongan KB) tetap bekerja tanpa pengecualian khusus.

### 7.5 Dokumen untuk bot (FAQ)

Mengubah rencana B-4.4–B-4.6: sumber dokumen **dari upload di desk**, bukan folder
`knowledge/`. B-4.7 (CLI indexing & file watcher) gugur. Dokumen contoh yang direncanakan
untuk `knowledge/` (keputusan 2026-09-17) menjadi fixture test.

- Format: **teks yang ditempel, `.txt`, `.md`, `.pdf`, `.docx`**. Batas 10 MB per file.
  Ekstraksi di server; file asli disimpan (`kb_documents.original` bytea) supaya bisa
  diunduh dan diindeks ulang.
- Tabel `kb_documents (id, title, source_kind, original, extracted_text, content_hash,
  status: 'queued'|'indexing'|'ready'|'failed', error, uploaded_by, created_at,
  updated_at)`. `kb_chunks` (B-4.5) mendapat FK `document_id`.
- Indexing adalah job `kb_index` di tabel `jobs` (bukan timer, bukan proses terpisah).
  AC-7.2 (hanya potongan berubah yang diproses ulang) tetap.
- Layar: daftar dokumen dengan status dalam bahasa biasa — "Sedang dibaca bot…", "Siap",
  "Gagal dibaca: file PDF ini berupa gambar hasil scan" — dan tombol Hapus / Ganti.
- Fitur "Tanya dokumen": kotak uji di halaman ini yang menjalankan `search_knowledge_base`
  dan menampilkan potongan yang ditemukan, supaya supervisor bisa melihat apakah bot
  "menemukan" jawabannya tanpa membuka percakapan uji.

Ekstraksi PDF/DOCX butuh dependensi baru. Pemilihan pustakanya diserahkan ke builder dengan
syarat: pure JS/TS atau WASM (tanpa binary sistem), jalan di Bun, lisensi permisif.

### 7.6 Kapan bot memanggil manusia

Memetakan FR-5.1. Dua kelompok di layar:

**Selalu aktif — tidak bisa dimatikan** (ditampilkan sebagai daftar terkunci 🔒 supaya
supervisor tahu ini ada):

- Pelanggan minta bicara dengan manusia
- Bot menilai pertanyaan di luar kemampuannya
- Bot tidak yakin (confidence rendah, FR-5.1). Ambang angkanya bisa diubah di Lanjutan,
  tapi pemicunya tidak bisa dimatikan
- Batas teknis (langkah maksimum, batas biaya, tool gagal berulang)
- Klaim harga/kebijakan tanpa dukungan dokumen (AC-8.3)

**Bisa diatur:**

| Pemicu | Kontrol di layar | Default |
|---|---|---|
| Pelanggan terlihat kesal | aktif/nonaktif | aktif (2 pesan berturut-turut) |
| Bot berputar-putar | jumlah giliran tanpa kemajuan: 2–5 | 3 |
| Kata kunci | daftar kata ("pengacara", "viral", "polisi") | daftar awal di kode |
| Refund di atas nominal | angka Rp | kosong (nonaktif) |

Skema Zod `escalation` **tidak punya field** untuk mematikan pemicu wajib. Bukan sekadar
divalidasi `true`; field-nya memang tidak ada, jadi mustahil dilonggarkan lewat API.

**Di mana pemicu ditegakkan:** di kode, di sekitar loop agent, bukan di prompt (guardrail
#1/#7). Desk hanya menyimpan *parameter*: on/off, jumlah giliran, daftar kata, nominal.
*Deteksinya* dibangun oleh tugas pemicu FR-5.1 di Backlog (A-4.6/A-4.7):

- **Kata kunci** dan **nominal refund** dicocokkan secara deterministik pada pesan
  pelanggan.
- **Kesal**, **berputar-putar**, dan **confidence** dibaca dari metadata terstruktur yang
  dikembalikan giliran LLM yang sama (mis. `sentiment`, `progress`, `confidence`). Tidak
  ada pemanggilan classifier terpisah. Kode yang membandingkannya dengan ambang di
  `settings`.

Desk tidak boleh menampilkan pemicu yang deteksinya belum dibangun. Item yang belum siap
tampil abu-abu dengan label "segera hadir".

### 7.7 Tim

- Supervisor mengundang: isi nama + email + peran → server membuat `user_invites (id,
  email, role, token_hash, expires_at, created_by, used_at)` dan menampilkan **tautan
  undangan** untuk disalin (tidak ada layanan email di MVP). Kedaluwarsa 7 hari, dicek saat
  tautan dipakai — tidak ada timer.
- Penerima membuka tautan, membuat password (argon2id, B-1.7), lalu login.
- Nonaktifkan user: `users.active = false` + hapus semua sesinya dalam satu transaksi.
  Percakapan `human_active` milik user itu **tidak dipindah otomatis** — supervisor melihat
  peringatan "3 percakapan masih dipegang Sari" dengan tombol untuk mengembalikannya ke
  antrian (lewat jalur handback/requeue Sprint 3, dicatat audit).
- Supervisor terakhir tidak bisa menonaktifkan diri sendiri atau menurunkan perannya
  (409 `LAST_ADMIN`).

### 7.8 Coba ngobrol dengan bot

Halaman uji dengan jendela chat. Halaman ini memanggil **fungsi loop agent yang sama**
(`packages/agent`) dengan pengaturan saat ini, tetapi **tidak lewat dispatcher, state
machine, maupun tabel `conversations`**. Akibatnya percakapan uji tidak menyentuh jalur
Handoff Integrity dan tidak butuh pengecualian di sana.

- **Tanpa state di server:** `POST /api/playground/turn { history }`. Desk mengirim riwayat
  uji di setiap giliran; server menjalankan satu giliran loop dan mengembalikan
  `{ reply, trace }`. Tidak ada channel `test`, tidak ada baris `conversations`, jadi tidak
  ada yang perlu dikecualikan dari metrik atau inbox.
- **Berjalan di mode `setup` maupun `paused`.** Larangan LLM di §6.3 berlaku untuk pesan
  pelanggan di dispatcher, bukan untuk halaman uji milik supervisor.
- Tool bertipe `write` tidak dieksekusi. Hasilnya tampil sebagai "Bot akan menjalankan:
  *Batalkan pesanan #123* (tidak dijalankan karena ini percobaan)".
- `request_human_handoff` **disimulasikan**: tool versi uji mengembalikan sukses tanpa
  transisi status. Layar menampilkan "Di sini bot akan memanggil manusia (alasan: …)".
- Di samping tiap balasan bot tampil "Bot memakai: SOP Retur · Dokumen *Kebijakan
  Retur*", diambil dari `trace` respons.
- Biaya LLM uji tetap dihitung ke batas biaya harian, dan dicatat di `agent_runs` dengan
  `conversation_id = NULL` serta `source = 'playground'`.
- Giliran pertama yang berhasil menyetel `settings.setup_marks.playgroundAt`.

### 7.9 Kredensial

- Tabel `secrets (owner_kind, owner_id, name, ciphertext, nonce, created_at, updated_at)`,
  PK `(owner_kind, owner_id, name)`.
- AES-256-GCM via WebCrypto (`crypto.subtle`, bawaan Bun — tanpa dependensi), kunci dari
  `TICKO_ENCRYPTION_KEY` (32 byte base64). Start **gagal** bila variabel tidak ada atau
  panjangnya salah (fail fast, AC-9.2).
- API **tidak pernah** mengembalikan nilai rahasia. Respons hanya `{ set: true, hint:
  "…a1b2" }` (4 karakter terakhir). Field di UI write-only: "Tersimpan ••••a1b2 · Ganti".
- Redaction logger yang ada diperluas ke nama-nama field ini.
- Rotasi kunci enkripsi: bukan fase ini. `ponytail:` satu kunci, rotasi butuh re-enkripsi
  semua baris — tambahkan saat ada instalasi produksi pertama.

## 8. Bahasa layar

Aturan yang bisa dicek di review (bukan niat):

1. Kata-kata berikut **dilarang** di string UI di luar halaman Lanjutan dan lipatan
   "Detail teknis": `webhook, token, prompt, RAG, embedding, LLM, MCP, API, JSON, job,
   queue, SSE, handoff, control_owner, dispatcher, tenant, model`.
2. Semua string UI ada di satu modul `apps/desk/src/copy/` (bukan tersebar di komponen),
   supaya aturan 1 bisa dicek dengan satu test yang memindai modul itu untuk daftar kata
   terlarang, dengan pengecualian untuk namespace `copy.advanced.*` / `copy.technical.*`.
3. Setiap `code` error API punya pesan desk sendiri di `copy.errors[code]`. Desk tidak
   menampilkan `message` mentah dari server kecuali sebagai fallback untuk `code` yang belum
   dikenal (dan fallback itu tercatat di console sebagai warning).

Glosarium (label di layar ← istilah sistem):

| Layar | Sistem |
|---|---|
| Menunggu manusia | `handoff_requested` |
| Sedang ditangani {nama} | `human_active` |
| Ditangani bot | `bot_active` / `control_owner = bot` |
| Ambil alih | claim |
| Kembalikan ke bot | handback |
| Jeda bot | `bot_state.mode = paused` |
| Dokumen untuk bot | knowledge base / `kb_documents` |
| Kapan bot memanggil manusia | escalation triggers |
| Aplikasi terhubung | plugin |
| Sambungan sistem perusahaan (Lanjutan) | MCP server |
| SOP | skill |

## 9. Fase C — Ekstensi

### 9.1 Jenis tool dan kebijakan tulis

Setiap tool (bawaan, plugin, MCP) wajib menyatakan `kind: 'read' | 'write' | 'control'`.

- `read` dari plugin/MCP: nonaktif sampai supervisor menyalakannya per tool.
- `write`: nonaktif sampai supervisor menyalakannya per tool, dengan peringatan "Bot akan
  bisa *mengubah data* di {aplikasi}". Saat aktif, AC-4.3 berlaku: bot wajib meminta
  konfirmasi eksplisit pelanggan sebelum menjalankannya.
- `control` hanya untuk tool bawaan (`request_human_handoff`, `mark_resolved`, `load_sop`).
  Plugin dan MCP tidak bisa mendaftarkan `control`.
- Semua panggilan tercatat di `tool_calls` (AC-4.5) dengan sumber (`builtin` / `plugin:<id>`
  / `mcp:<id>`), timeout 10 detik (AC-4.2), dan output diperlakukan sebagai **data**
  di dalam pemisah yang sama dengan pesan pelanggan (AC-8.1) — output tool pihak luar bisa
  berisi prompt injection.
- Nama tool di-namespace: `plugin_<id>__<nama>`, `mcp_<id>__<nama>`, supaya dua sumber
  tidak bisa saling menimpa atau menyamar sebagai tool bawaan.

### 9.2 SOP (skill)

SOP = prosedur yang ditulis supervisor. Contoh: "Retur: tanya nomor pesanan → cek status →
kalau lebih dari 7 hari, panggil manusia".

- Tabel `sops (id, title, when_to_use, steps_markdown, escalate_when, enabled, version,
  updated_by, updated_at)`.
- Editor di desk: judul, "Dipakai saat…" (satu kalimat), langkah-langkah bernomor,
  "Panggil manusia bila…" (daftar). Tidak ada sintaks khusus.
- Cara dipakai bot (progressive disclosure, tanpa framework):
  - System prompt memuat **daftar** SOP aktif: `judul — dipakai saat …`.
  - Tool bawaan `load_sop({ id })` (`kind: control`) mengembalikan langkah lengkap.
  - Inti sistem menyatakan: SOP **menambah** kapan harus eskalasi; SOP tidak bisa
    menghapus pemicu wajib §7.6.
- `agent_runs` mencatat SOP yang dimuat, ditampilkan di panel "Apa yang dilakukan bot".

### 9.3 Plugin resmi

Hanya tim Ticko yang menulis plugin di fase ini. Kontraknya dirancang sama dengan yang nanti
dipakai pihak ketiga, supaya membuka ke pihak lain cukup menambah isolasi, bukan mengubah
kontrak.

```ts
// packages/plugins/src/types.ts
interface PluginManifest {
  id: string;                       // 'shopify', stabil selamanya
  name: string;                     // label layar
  description: string;              // satu kalimat bahasa biasa
  permissions: PluginPermission[];  // mis. 'orders:read', 'orders:write' — ditampilkan sebelum pasang
  config: z.ZodObject;              // field yang diisi supervisor; field rahasia ditandai .meta({ secret: true })
  tools: Tool[];                    // Tool dari packages/agent/src/tools.ts + kind
  check(config): Promise<Result<void, PluginError>>;   // "Tes koneksi"
}
```

- Plugin tinggal di `packages/plugins/<id>/`, didaftarkan statis di
  `packages/plugins/src/catalog.ts`. Tidak ada pemuatan kode dinamis.
- `plugin_installs (plugin_id PK, enabled, config jsonb non-rahasia, tool_settings jsonb,
  installed_by, updated_at)`; field rahasia ke `secrets`.
- Alur pasang di desk: kartu katalog → lihat izin ("Aplikasi ini akan bisa: membaca data
  pesanan") → isi form dari `config` → Tes koneksi → Pasang → atur tool per tool (§9.1).
- `permissions` di fase ini **deklaratif** (ditampilkan dan dicatat), belum ditegakkan oleh
  sandbox. `ponytail:` saat plugin pihak ketiga dibuka, izin harus ditegakkan oleh isolasi
  proses — kontrak sudah siap, penegakannya belum.
- Plugin pertama: lihat §11 pertanyaan terbuka. Kandidat alami adalah memindahkan
  `get_order_status` / `check_product_stock` (A-4.8) menjadi plugin "API pesanan (HTTP)".

### 9.4 Sambungan MCP (Lanjutan)

Ticko sebagai **MCP client** ke server MCP milik perusahaan.

- Transport: **Streamable HTTP saja**. Transport `stdio` tidak didukung dari desk — itu
  berarti menjalankan perintah sembarang di server dari form web.
- Pustaka: SDK resmi `@modelcontextprotocol/sdk`, bagian client saja. Ini klien protokol,
  bukan framework agent — loop tool-calling tetap milik `packages/agent` (guardrail #5).
- `mcp_servers (id, name, url, enabled, tool_settings jsonb, last_checked_at, last_error,
  created_by, updated_at)`; header auth ke `secrets`.
- Tambah server: isi nama + URL + (opsional) header auth → server memanggil `tools/list` →
  desk menampilkan daftar tool. **Semua tool mulai nonaktif.** Supervisor memilih `kind`
  per tool; `annotations.readOnlyHint` / `destructiveHint` dari server dipakai sebagai
  saran awal pilihan, bukan kebenaran (server MCP tidak dipercaya).
- Daftar tool di-refresh saat supervisor menekan "Muat ulang" atau saat worker memulai
  `agent_run` dan versi `tool_settings` berubah — bukan dengan polling.
- Tool yang hilang dari server tetapi masih aktif di `tool_settings` dilewati dengan
  warning di log dan tanda ⚠ di desk.

## 10. Data, API, dan event

### 10.1 Tabel baru (ringkas)

`settings`, `secrets`, `audit_log`, `user_invites`, `canned_responses`, `kb_documents`,
`sops`, `plugin_installs`, `mcp_servers`. Kolom baru: `users.active`, `agent_runs.source`
(`conversation` | `playground`, plus `conversation_id` nullable untuk playground).
`tool_calls` belum ada. Saat tabel itu dibuat (AC-4.5), kolom `source` (`builtin` /
`plugin:<id>` / `mcp:<id>`) ikut sejak awal.

`audit_log (id, at, actor_user_id, action, target_kind, target_id, before jsonb, after
jsonb, trace_id)` — append-only, `UPDATE`/`DELETE` ditolak oleh trigger database (AC-6.8
"tidak bisa diubah").

Migrasi tetap satu penulis (Backlog §2) dan mengikuti CONVENTIONS untuk CHECK constraint.

### 10.2 Permukaan API baru (di luar §6.2)

```
GET    /api/setup/status
GET    /api/settings/:section                   (admin)
PUT    /api/settings/:section  body: { value, version }   (admin)
POST   /api/settings/time_policy/reschedule     (admin)
POST   /api/channels/telegram/connect  body: { botToken }   (admin)
POST   /api/channels/telegram/disconnect                  (admin)
GET    /api/team                         POST /api/team/invites    PATCH /api/team/:id   (admin)
POST   /api/invites/:token/accept   body: { name, password }   (publik, rate-limited)
GET    /api/kb/documents   POST (multipart)   DELETE /:id   POST /:id/reindex   (admin)
POST   /api/kb/search      body: { query }    (admin, "Tanya dokumen")
POST   /api/playground/turn   body: { history }   (admin)
GET    /api/sops   POST   PUT /:id   DELETE /:id   (admin)
GET    /api/plugins                      (katalog + status pasang)          (admin)
PUT    /api/plugins/:id   body: { enabled, config, secrets?, toolSettings }   (admin)
POST   /api/plugins/:id/check                                              (admin)
GET    /api/mcp   POST   PUT /:id   DELETE /:id   POST /:id/refresh        (admin)
```

Kode error baru: `FORBIDDEN`, `SETUP_INCOMPLETE`, `INVALID_SETTINGS`, `STALE_SETTINGS`,
`TELEGRAM_TOKEN_INVALID`, `PUBLIC_URL_MISSING`, `LAST_ADMIN`, `INVITE_EXPIRED`,
`INVITE_USED`, `FILE_TOO_LARGE`, `UNSUPPORTED_FILE`, `PLUGIN_CHECK_FAILED`,
`MCP_UNREACHABLE`.

### 10.3 DeskEvent baru

`settings_changed { section }`, `bot_state_changed { mode }`, `kb_document_updated { id,
status }`, `setup_status_changed`. Semuanya pemicu refetch, tidak membawa data.

## 11. Pertanyaan terbuka dan keputusan yang diambil

**Keputusan user (2026-10-19)**

- Desk untuk orang non-IT: Agent CS dan Supervisor/pemilik.
- Ticko dipakai umum; single-tenant per instalasi; multi-tenant nanti.
- Agent CS hanya inbox; pengaturan hanya Supervisor.
- Plugin hanya dibuat tim Ticko dulu, nanti dibuka untuk pihak lain.
- Skill = SOP/panduan; plugin = integrasi ke aplikasi tambahan.
- Arah tampilan: panduan setup + pengaturan bertingkat (opsi A).
- Urutan: A desk inti → B setup tanpa IT → C ekstensi.
- Subsistem berbasis file di Backlog dibangun langsung berbasis DB; Fase B ditempel ke
  tugas Sprint 3–5 (§7.0).

**Keputusan perancang (bisa dikoreksi)** — ditandai di teks di atas; ringkasnya:
pengaturan instalasi tetap env/file termasuk kunci LLM; inti sistem prompt tidak bisa
diubah; pemicu wajib tidak punya field di skema dan ditegakkan di kode; bot tidak menjawab
sebelum diaktifkan, kecuali instalasi lama yang otomatis `active`; tabel `settings` masuk
Fase A; jeda dijaga tiga lapis; playground tanpa state dan tidak lewat dispatcher;
informasi usaha diindeks sebagai dokumen; undangan lewat tautan tanpa email; format dokumen
TXT/MD/PDF/DOCX + teks tempel; MCP hanya Streamable HTTP; semua tool plugin/MCP mulai
nonaktif; pengaturan dibaca per `agent_run` tanpa cache.

**Belum diputuskan (milik user, tidak memblokir Fase A/B):** apakah tool yang mengubah
data juga butuh persetujuan agent CS selain konfirmasi pelanggan; plugin resmi pertama.

## 12. Diserahkan ke builder

- Pustaka ekstraksi PDF/DOCX (syarat §7.5).
- Desain visual rinci (warna, tipografi) di atas shadcn/ui; mockup di folder mockup adalah
  wireframe struktur, bukan desain akhir.
- Pembagian PR per fase (≤ 400 baris bila memungkinkan).
- Bentuk tepat template persona per gaya bicara.

## 13. Kriteria selesai per fase

**Fase A**
- [ ] Agent CS login → hanya melihat Inbox & Template; setiap route admin mengembalikan 403
      untuk `agent` (test per route).
- [ ] Seluruh "Selesai bila" B-0.8, B-2.2, B-2.5, B-2.6, A-3.1–A-3.3, A-3.6, B-3.1–B-3.6.
- [ ] Jeda bot: pesan masuk saat `paused` tersimpan, tereskalasi, nol pemanggilan LLM —
      test integrasi di level dispatcher, **plus** test job `agent_run` yang sudah diambil
      worker sebelum pause dibuang tanpa memanggil `FakeLlm`.
- [ ] Instalasi yang sudah punya Telegram di env tetap menjawab setelah upgrade
      (`mode = active` hasil migrasi).
- [ ] `activate` ditolak `SETUP_INCOMPLETE` selama jalur handoff belum aktif.
- [ ] Test pemindai kata terlarang di `apps/desk/src/copy/` hijau.

**Fase B**
- [ ] Dari DB kosong + env instalasi saja, supervisor menyelesaikan semua langkah wajib dan
      bot menjawab pesan Telegram pertama **tanpa terminal** — diverifikasi manual dengan bot
      sungguhan (tidak dicentang tanpa verifikasi nyata, keputusan 2026-09-17).
- [ ] Instalasi lama (env + TOML) tetap jalan setelah upgrade; isi diimpor sekali.
- [ ] `PUT /api/settings/escalation` yang mencoba mematikan pemicu wajib ditolak 422.
- [ ] Respons API mana pun tidak pernah berisi nilai dari `secrets` (test memindai respons
      semua route admin untuk nilai rahasia fixture).
- [ ] Perubahan pengaturan tercatat di `audit_log`; `UPDATE audit_log` ditolak DB.
- [ ] Upload PDF teks → status "Siap" → "Tanya dokumen" menemukan potongannya.

**Fase C**
- [ ] SOP aktif muncul di daftar prompt; `load_sop` tercatat di `agent_runs`.
- [ ] Plugin dan MCP tidak bisa mendaftarkan tool `control` atau nama yang bertabrakan.
- [ ] Tool `write` yang belum dinyalakan tidak pernah dipanggil; yang dinyalakan meminta
      konfirmasi pelanggan (AC-4.3).
- [ ] Tool `write` tidak dieksekusi di playground; `request_human_handoff` di playground
      tidak mengubah status percakapan mana pun.
- [ ] Server MCP mati → tool-nya gagal dengan timeout 10 detik, bot eskalasi (AC-4.2).
