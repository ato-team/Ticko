
# Ticko Conventions

*Konvensi pengembangan, dibaca saat menulis kode — versi 2.0*

| | |
|---|---|
| **Versi** | 2.0 |
| **Tanggal** | 13 September 2026 |
| **Berlaku untuk** | Seluruh package di workspace |
| **Dokumen terkait** | PRD v1.2, Backlog v2.0 |
| **Perubahan v2.0** | Bahasa implementasi berubah dari Rust ke TypeScript (runtime Bun). Bagian 3, 5, dan 9 ditulis ulang; bagian 9.5 dilebur ke badan utama |

Dokumen ini dibaca saat **menulis kode**, bukan saat planning. Panjangnya sengaja dijaga agar bisa dibaca ulang dalam lima menit.

Aturan di sini bukan selera. Masing-masing lahir dari satu kelas bug yang ingin dicegah, dan alasannya ditulis supaya kalian bisa memutuskan sendiri kapan pengecualian masuk akal.

**Catatan khusus versi ini.** Sebagian aturan di bawah dulu ditegakkan compiler Rust dan sekarang tidak lagi. Bagian-bagian itu ditandai dengan ▲. Aturan bertanda ▲ **wajib masuk checklist reviewer**, karena tidak ada yang akan menangkapnya secara otomatis.

---

## 1. Kepemilikan Kode

### Per file, bukan per package

Package `domain` dipakai semua orang, jadi kepemilikannya dipecah lebih halus:

| Path | Pemilik | Aturan |
|---|---|---|
| `domain/src/state.ts` | Dev A | B tidak menyentuh |
| `domain/src/time/` | Dev A | B tidak menyentuh |
| `domain/src/conversation.ts` | Dev A | B tidak menyentuh |
| `domain/src/channel.ts` | Dev B | A tidak menyentuh |
| `domain/src/event.ts` | Dev B | A tidak menyentuh |
| `domain/src/message.ts` | **Bersama** | Perubahan butuh approval keduanya |
| `domain/src/ids.ts` | **Bersama** | Perubahan butuh approval keduanya |
| `storage/`, `agent/`, `worker/` | Dev A | B memakai lewat interface |
| `channels/`, `api/` | Dev B | — |
| `rag/` | Dev B | — |
| `apps/desk/` | Dev B | — |

### Migrasi database punya satu penulis

**Hanya Dev A yang boleh menambah file di `migrations/`,** dan hanya Dev A yang menjalankan `drizzle-kit generate`. Dev B mengajukan kebutuhan skema lewat issue dengan format: tabel apa, kolom apa, index apa, dipakai untuk apa.

Terdengar kaku, tapi skema database adalah satu-satunya hal di proyek ini yang benar-benar tidak boleh punya dua penulis. Penamaan migrasi berbasis timestamp akan bentrok kalau dua orang membuatnya di hari yang sama, dan menyelesaikan konflik migrasi jauh lebih mahal daripada menunggu satu hari.

### Konfigurasi dipecah per domain

```
config/
├── app.toml        ← B: server, database, redis, logging
├── channels.toml   ← B: telegram, whatsapp
├── time.toml       ← A: schedule, holiday, policy
├── timer.toml      ← A: durasi timer
└── agent.toml      ← A: model, batas biaya, batas langkah
```

Bun mengimpor TOML secara native, jadi tidak ada loader khusus. Setiap file punya skema Zod-nya sendiri, dan struct config dipecah per modul — jangan satu objek raksasa.

---

## 2. Aturan Test Double

**Ini aturan terpenting di dokumen ini.**

> Siapa pun yang memiliki sebuah interface, wajib merilis interface itu **beserta implementasi palsunya** dalam PR yang sama, di hari pertama sprint. Implementasi asli menyusul kapan saja.

Tanpa ini, dua orang saling menunggu sepanjang proyek. Dengan ini, hampir semua waktu tunggu hilang.

### Test double yang wajib ada

| Palsu | Menggantikan | Pemilik | Dipakai oleh |
|---|---|---|---|
| `InMemoryConversationRepo` | PostgreSQL | A | B, untuk menguji handler API |
| `InMemoryContactRepo` | PostgreSQL | A | B |
| `FakeLlm` | API LLM berbayar | A | A, untuk menguji loop agent |
| `MockChannelAdapter` | Telegram / WhatsApp | B | A, untuk menguji outbound worker |
| Server `hono` palsu | HTTP eksternal | B | B, untuk menguji adapter |

### Penempatan

Test double bukan kode test — ia kode produksi yang dipakai test, jadi diletakkan di `src/`, bukan di folder test, dan diekspor sebagai subpath terpisah:

```jsonc
// packages/storage/package.json
{
  "exports": {
    ".":      "./src/index.ts",
    "./fake": "./src/fake/index.ts"
  }
}
```

```ts
import { InMemoryConversationRepo } from '@ticko/storage/fake';
```

Subpath terpisah membuatnya sengaja terlihat: kalau ada `/fake` muncul di kode produksi, itu langsung kelihatan saat review.

### FakeLlm harus deterministik

```ts
export class FakeLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];        // untuk diperiksa test

  static withText(...texts: string[]): FakeLlm;
  static withToolCall(name: string, args: unknown): FakeLlm;
  static withError(err: LlmError): FakeLlm;
}
```

Test yang memanggil API sungguhan membakar token, lambat, dan hasilnya berbeda tiap kali dijalankan. Test seperti itu tidak akan pernah dipercaya, dan test yang tidak dipercaya akan diabaikan.

---

## 3. Penanganan Error

### Error harus menjelaskan keputusan, bukan sekadar kegagalan ▲

Ini prinsip yang paling banyak kehilangan dukungan compiler saat pindah dari Rust. Di Rust, `Result<T, InsertError>` memaksa pemanggil menangani setiap varian. Di TypeScript tidak ada yang memaksa — jadi bentuknya harus dibuat sedemikian rupa sehingga mengabaikannya terasa janggal.

Pakai discriminated union untuk error yang pemanggilnya perlu membedakan:

```ts
// BENAR — pemanggil bisa mengambil tindakan berbeda per varian
export type InsertError =
  | { kind: 'duplicate';             externalId: string }      // → abaikan, retry webhook, normal
  | { kind: 'conversation_not_found'; id: ConversationId }     // → 404
  | { kind: 'database';               cause: unknown };        // → 500, perlu alert

export type InsertResult =
  | { ok: true;  id: MessageId }
  | { ok: false; error: InsertError };

// SALAH — semua kegagalan terlihat sama
async function insert(m: Message): Promise<MessageId>   // melempar Error generik
```

**Kapan memakai union, kapan melempar:**

| Situasi | Cara |
|---|---|
| Pemanggil perlu bercabang berdasarkan jenis kegagalan | Discriminated union seperti di atas |
| Kegagalan berarti bug atau kondisi yang tidak bisa dipulihkan | `throw` dengan class error bernama |
| Batas sistem (handler HTTP, konsumen job) | `try/catch` yang memetakan ke respons atau retry |

Jangan memaksakan union di mana-mana. Aturannya: **kalau ada dua pemanggil yang akan bereaksi berbeda terhadap dua kegagalan berbeda, pakai union.** Kalau tidak, `throw` sudah cukup.

`neverthrow` dan pustaka `Result` sejenis **tidak dipakai**. Ia menular ke seluruh call stack dan biayanya lebih besar daripada manfaatnya untuk proyek seukuran ini. Keputusan ini bisa ditinjau ulang, tapi tidak di tengah sprint.

### Mencocokkan string pesan error dilarang

Baik di backend maupun di desk. Cabang keputusan hanya boleh berdasarkan `kind` atau `code`, tidak pernah berdasarkan kalimat — kalimat akan diperbaiki suatu hari dan kodenya rusak diam-diam.

### Pemetaan ke HTTP hanya di satu tempat

Satu error handler di package `api`. Jangan menyebar status code ke dalam package domain — domain tidak tahu-menahu soal HTTP.

```ts
// packages/api/src/error.ts — satu-satunya tempat error jadi respons
export function toResponse(e: AppError): Response {
  switch (e.kind) {
    case 'not_found':     return json(404, 'NOT_FOUND', 'Tidak ditemukan');
    case 'conflict':      return json(409, 'ALREADY_CLAIMED', 'Sudah diambil agent lain');
    case 'unauthorized':  return json(401, 'UNAUTHORIZED', 'Silakan login');
    case 'internal':
      logger.error({ err: e.cause }, 'internal error');
      return json(500, 'INTERNAL', 'Terjadi kesalahan');
    default: return assertNever(e);
  }
}
```

Detail error internal **tidak pernah** dikirim ke klien. Format respons error seragam:

```json
{ "error": { "code": "ALREADY_CLAIMED", "message": "Sudah diambil agent lain" } }
```

### Larangan yang setara dengan `unwrap` ▲

| Dilarang | Padanan di Rust | Kenapa |
|---|---|---|
| `any` | — | `strict` dan `noImplicitAny` wajib aktif |
| `as` untuk memaksa tipe | `unwrap` | Pakai type guard atau Zod |
| `!` non-null assertion | `unwrap` | Tangani `null` secara eksplisit |
| `@ts-ignore` | `#[allow]` tanpa alasan | Kalau benar-benar perlu, pakai `@ts-expect-error` dengan komentar alasannya |
| `JSON.parse` tanpa validasi | `unwrap` pada data eksternal | Semua data dari luar lewat Zod |

**Diperbolehkan hanya di tiga tempat:**

1. Di dalam file test
2. Saat inisialisasi aplikasi, di mana kegagalan memang harus menghentikan proses — dan wajib disertai pesan yang menjelaskan apa yang salah
3. Pada invarian yang benar-benar dijamin, disertai komentar `// SAFETY: ...` yang menjelaskan kenapa

```ts
// BENAR
const cfg = timeConfigSchema.parse(raw);   // melempar saat start dengan pesan Zod yang jelas

// SALAH
const conv = (await repo.get(id))!;        // percakapan bisa saja sudah dihapus
```

### Setiap `await` pada jaringan punya timeout ▲

Tanpa pengecualian. Di Rust ini sebagian ditangani konfigurasi klien; di sini harus eksplisit:

```ts
const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
```

Panggilan tanpa timeout akan menggantung sampai socket mati, dan job yang menggantung tidak menghasilkan error — ia hanya berhenti bergerak.

---

## 4. Database & SQL

### Query lewat query builder, bukan string

```ts
// BENAR — terketik dari deklarasi skema
const conv = await db.query.conversations.findFirst({
  where: eq(conversations.id, id),
});

// SALAH — kesalahan baru ketahuan saat runtime, dan rawan injeksi
await db.execute(`SELECT * FROM conversations WHERE id = '${id}'`);
```

Penggabungan string untuk menyusun SQL **dilarang mutlak**, bahkan untuk nilai yang "pasti aman". Template `sql` milik Drizzle sudah melakukan parameterisasi — pakai itu, jangan interpolasi biasa.

### Kapan SQL mentah boleh ▲

Hanya untuk yang tidak bisa diekspresikan query builder — praktisnya dua hal: `FOR UPDATE SKIP LOCKED` di job queue dan operator jarak pgvector. Setiap kemunculan wajib disertai komentar yang menjelaskan kenapa.

### Menambal yang hilang dari `sqlx` ▲

Drizzle memberi tipe dari deklarasi skema, bukan dari verifikasi terhadap database nyata. Artinya skema di kode bisa melenceng dari database tanpa terdeteksi. Tiga penambal, semuanya wajib:

1. CI menjalankan `drizzle-kit check`
2. Ada satu test integrasi yang memanggil **setiap** fungsi repository sekali terhadap database hasil migrasi
3. Migrasi dijalankan di CI dari database kosong setiap PR

Tanpa ketiganya, kelas bug yang dulu ditangkap `cargo sqlx prepare --check` akan lolos ke produksi.

### Batas transaksi ada di pemanggil, bukan repository

Ini kesepakatan yang paling sering jadi sumber bug kalau tidak eksplisit.

```ts
// Repository menerima executor, tidak membuka transaksi sendiri
async function updateStatus(tx: Executor, id: ConversationId, s: Status): Promise<void>

// Pemanggil yang menentukan batas transaksi
await db.transaction(async (tx) => {
  await convRepo.updateStatus(tx, id, 'handoff_requested');
  await handoffRepo.insert(tx, event);
  await jobRepo.cancelPending(tx, id);
});
```

Alasannya terlihat jelas di A-3.1: handoff butuh tiga operasi dalam satu transaksi. Kalau repository membuka transaksinya sendiri, ketiganya jadi tiga transaksi terpisah dan atomisitasnya hilang tanpa satu pun error muncul.

### Aturan skema

- Semua timestamp `TIMESTAMPTZ`, tidak pernah `TIMESTAMP`
- Enum memakai tipe enum PostgreSQL, bukan `text`
- **CHECK constraint untuk setiap invarian state** — ini menjadi lebih penting daripada di rencana Rust, karena tipe TypeScript hilang saat runtime sementara constraint tidak
- Setiap foreign key punya index — PostgreSQL tidak membuatnya otomatis
- Tabel yang bisa diubah bersamaan punya kolom `version INT` untuk optimistic locking
- Nama tabel jamak (`conversations`), nama kolom tunggal (`conversation_id`)

### Terbitkan event setelah commit, bukan sebelum

```ts
await db.transaction(async (tx) => { /* ... */ });
await redis.publish('desk:events', JSON.stringify(event));   // setelah
```

Menerbitkan sebelum commit berarti agent desk bisa menerima notifikasi untuk transaksi yang ternyata batal.

---

## 5. Pola Async & Konkurensi

### Runtime satu thread mengubah perhitungan

Di Rust, pekerjaan berat bisa dipindah ke thread lain. Di sini tidak. Konsekuensinya sederhana dan harus diingat terus: **apa pun yang menahan event loop menahan seluruh proses.**

Karena itu `api` dan `worker` adalah dua proses terpisah, bukan dua task di satu proses. Satu loop agent yang lambat tidak boleh menahan webhook ingress yang harus membalas 200 di bawah dua detik.

### Pekerjaan CPU-berat

```ts
// AMAN — Bun.password menjalankan argon2id di luar thread utama
const hash = await Bun.password.hash(plain, { algorithm: 'argon2id' });

// BERBAHAYA — loop sinkron panjang di atas ribuan baris
for (const row of rows) { expensiveSync(row); }
```

Kalau muncul kebutuhan pekerjaan CPU-berat lain (misalnya pemrosesan dokumen besar), pindahkan ke proses worker terpisah, bukan ke `api`.

### Timer tidak pernah di memori ▲▲

```ts
// SALAH — lenyap saat restart, tanpa error apa pun
setTimeout(() => markResolved(id), 30 * 60 * 1000);

// BENAR
await jobs.enqueueWithDedupe({
  type: 'bot_idle_timeout',
  conversationId,
  runAfter: DateTime.utc().plus({ minutes: 30 }),
});
```

Ini aturan yang paling mudah dilanggar, dan di TypeScript versi salahnya bahkan lebih pendek dan lebih menggoda daripada di Rust. Kegagalannya baru muncul saat deploy, dan tidak menghasilkan error — timer hanya lenyap.

**Karena itu aturan ini ditegakkan lint, bukan disiplin.** `setTimeout` dan `setInterval` dilarang di seluruh workspace kecuali di satu file: `packages/worker/src/poller.ts`.

### Penjadwalan dengan dedupe

```ts
await db.insert(jobs)
  .values({ dedupeKey, jobType, conversationId, runAfter, payload })
  .onConflictDoUpdate({ target: jobs.dedupeKey, set: { runAfter } });
```

`dedupeKey` berformat `{conversationId}:{timerType}` dengan unique index. Tanpa ini, satu percakapan bisa punya dua timer sejenis yang saling bertabrakan.

### Jangan menjalankan pekerjaan setelah respons terkirim

Godaan yang khas di JavaScript: membalas 200 lalu meneruskan pekerjaan di promise yang tidak di-`await`. Pekerjaan itu bisa terbunuh saat proses dimatikan, dan kehilangannya tidak menghasilkan error. Balas 200, **lalu masukkan pekerjaan ke tabel `jobs`** — bukan ke promise yang menggantung.

---

## 6. Konvensi Test

### Penempatan

| Jenis | Lokasi | Butuh apa |
|---|---|---|
| Unit test | `*.test.ts` di sebelah file yang diuji | Tidak ada |
| Test integrasi | `tests/` di package terkait | Database, Redis |
| Test lintas package | `tests/` di package `api` | Semuanya |

Dijalankan dengan `bun test`.

### Penamaan

Format `fungsi_kondisi_harapan`:

```ts
test('transition_human_active_to_new_rejected', () => { /* ... */ });
test('insert_inbound_duplicate_external_id_returns_duplicate', async () => { /* ... */ });
```

Nama test adalah dokumentasi perilaku. `test('works')` tidak memberi tahu apa pun saat ia gagal di CI enam minggu dari sekarang.

### Yang wajib punya test

- Seluruh fungsi di `domain` — murni, tanpa IO, tidak ada alasan untuk tidak diuji
- Setiap fungsi repository, minimal jalur sukses dan satu jalur error
- Setiap transisi state machine
- Setiap kasus tepi `businessElapsed` — minimal 15 kasus
- Setiap alur yang melibatkan transaksi atau pengambilan kunci
- **Setiap batas data eksternal** — payload webhook, respons LLM, respons API internal. Di Rust deserialisasi yang gagal menghasilkan error; di sini JSON yang bentuknya berubah akan lolos diam-diam kalau tidak divalidasi Zod

### Yang tidak wajib

- Komponen presentasi murni
- Konfigurasi router
- Kode yang hanya meneruskan panggilan tanpa logika

### Isolasi antar test

Pengganti `sqlx::test` adalah satu helper yang dibuat di Sprint 0:

```ts
export async function withTestDb(fn: (db: Db) => Promise<void>) {
  const tx = await pool.begin();
  try { await fn(drizzle(tx)); } finally { await tx.rollback(); }
}
```

**Batasannya harus diketahui:** test yang menguji perilaku transaksi bersarang atau `SKIP LOCKED` tidak bisa memakai pola ini, karena keduanya butuh commit sungguhan. Test seperti itu memakai skema terpisah per file. Test race condition A-3.3 termasuk kategori ini.

### Menguji kondisi balapan

Pakai `Promise.all` dan ulangi minimal 50 kali:

```ts
test('handoff_race_no_bot_reply', async () => {
  for (let i = 0; i < 50; i++) {
    await Promise.all([send(1), send(2), send(3) /* ... */]);
    expect(await countBotMessages()).toBe(0);
  }
});
```

---

## 7. Logging & Tracing

### Level

| Level | Kapan | Contoh |
|---|---|---|
| `error` | Butuh perhatian manusia sekarang | Database mati, kredensial channel ditolak |
| `warn` | Tidak normal tapi tertangani | Retry ke-2, jendela WhatsApp tertutup |
| `info` | Peristiwa bisnis penting | Handoff terjadi, percakapan selesai, aplikasi start |
| `debug` | Untuk menelusuri masalah | Isi prompt, hasil tool |
| `trace` | Sangat detail, mati di produksi | Setiap query SQL |

### Field terstruktur, bukan format string

```ts
// BENAR — bisa difilter dan diagregasi
logger.info({ conversationId, reason, urgency }, 'handoff diminta');

// SALAH — hanya bisa dicari dengan grep
logger.info(`handoff diminta untuk ${conversationId} karena ${reason}`);
```

### Yang tidak pernah masuk log

- Kunci API, token, password, session cookie
- Isi pesan customer pada level `info` atau di atasnya — hanya `debug`, dan hanya di development
- Data pribadi: nomor telepon utuh, NIK, nomor kartu

Nomor telepon ditulis tersamar: `+6281****5678`. Pasang redaction bawaan `pino` untuk field yang sudah diketahui sensitif, tapi jangan bergantung padanya — objek yang di-log secara utuh bisa membawa field yang belum terdaftar.

### Setiap job membawa trace_id

`trace_id` dari request HTTP disimpan di payload job, lalu dipasang kembali sebagai konteks logger saat worker mengambilnya. Tanpa ini, satu percakapan akan terpecah jadi jejak-jejak terpisah yang tidak bisa disambungkan.

Tracing LLM diekspor ke Langfuse lewat SDK-nya langsung, bukan OTLP. Alasannya ada di AC-10.3.

---

## 8. Git & Pull Request

### Branch

```
a/3.1-handoff-transaksional
b/5.3-jendela-24-jam
```

Format: `{dev}/{id-tugas}-{deskripsi-singkat}`.

### Commit

Conventional commits, ditulis dalam bahasa Inggris agar konsisten dengan ekosistem:

```
feat(storage): add conversation repository with optimistic locking
fix(agent): cancel pending jobs on handoff
test(domain): add businessElapsed edge cases across holidays
refactor(channels): extract capability flags from adapter interface
docs(backlog): update sprint 4 ordering
```

Satu commit satu perubahan logis. Commit berjudul "fix stuff" atau "wip" di-squash sebelum PR dibuka.

### Pull request

- Satu PR satu tugas backlog
- Judul: `[A-3.1] Handoff transaksional`
- Deskripsi menyalin bagian "Selesai bila" dari backlog sebagai checklist
- PR di atas 400 baris perubahan dipecah, kecuali memang tidak bisa
- Draft PR dibuka lebih awal kalau ingin umpan balik arah sebelum selesai

### Checklist reviewer

Reviewer memeriksa hal-hal ini, bukan sekadar memberi stempel. Poin bertanda ▲ adalah yang **tidak ada compiler-nya** — kalau reviewer melewatkannya, tidak ada lapis kedua.

- [ ] Seluruh checkbox "Selesai bila" benar-benar terpenuhi, bukan hanya diklaim
- [ ] ▲ Tidak ada `any`, `as` paksa, `!`, atau `@ts-ignore` di luar pengecualian Bagian 3
- [ ] ▲ Setiap `switch` atas tipe union ditutup `assertNever`, tanpa cabang `default` yang mengembalikan nilai
- [ ] ▲ Setiap `await` pada operasi jaringan punya timeout
- [ ] ▲ Tidak ada `setTimeout` atau `setInterval` di luar `worker/src/poller.ts`
- [ ] ▲ Data dari luar sistem divalidasi Zod sebelum dipakai, bukan di-`as`
- [ ] Transaksi database ditutup di jalur error, bukan hanya di jalur sukses
- [ ] Tidak ada penggabungan string untuk menyusun SQL
- [ ] Tidak ada kredensial atau data pribadi yang bisa masuk log
- [ ] Test ada untuk jalur utama dan minimal satu jalur error
- [ ] Tidak menyentuh file milik orang lain tanpa kesepakatan
- [ ] Kalau menambah interface, test double-nya ikut dalam PR yang sama

**Batas waktu review: 1 hari kerja.** Review yang menumpuk lebih merugikan daripada review yang kurang teliti, karena penulisnya sudah pindah konteks dan harus kembali lagi.

---

## 9. Kualitas Kode

### Yang ditegakkan CI

```bash
bun run lint         # biome check, tanpa warning
bun run typecheck    # tsc --noEmit, strict
bun test             # seluruh workspace
bunx drizzle-kit check
bun run check:domain-deps   # domain tidak boleh punya dependensi IO
```

Kelimanya wajib hijau sebelum merge. Warning diperlakukan sebagai error, tanpa pengecualian — kalau satu warning dibiarkan, dalam dua minggu akan ada lima puluh.

Baris terakhir mengecek `packages/domain/package.json` tidak punya dependensi runtime selain Luxon dan Zod. Ini menggantikan jaminan yang dulu diberikan pemisahan crate.

### Konfigurasi TypeScript minimum

```jsonc
{
  "strict": true,
  "noImplicitAny": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noFallthroughCasesInSwitch": true,
  "verbatimModuleSyntax": true
}
```

`noUncheckedIndexedAccess` adalah yang paling sering diprotes dan yang paling banyak menangkap bug. Jangan dimatikan.

### Exhaustive matching ▲

Setiap `switch` atas discriminated union ditutup begitu:

```ts
export function assertNever(x: never): never {
  throw new Error(`nilai tidak tertangani: ${JSON.stringify(x)}`);
}

switch (state) {
  case 'new':               return 'none';
  case 'bot_active':        return 'bot';
  case 'handoff_requested': return 'none';
  case 'human_active':      return 'human';
  case 'resolved':          return 'none';
  case 'closed':            return 'none';
  default: return assertNever(state);   // state baru → error kompilasi
}
```

Ini pengganti langsung `match` exhaustive di Rust, dan memenuhi AC-2.5 — **tetapi hanya kalau tidak ada cabang `default` yang mengembalikan nilai biasa.** Satu `default: return 'none'` menghapus seluruh jaminan ini tanpa memicu error apa pun.

### Penamaan

- Tipe: `PascalCase` · fungsi dan variabel: `camelCase` · konstanta: `SCREAMING_SNAKE_CASE`
- Kolom database dan field TOML tetap `snake_case`; konversi terjadi di lapisan repository dan config, bukan tersebar
- Fungsi boolean berawalan `is`, `has`, `can`, atau `supports`
- Branded type untuk setiap ID:

```ts
// BENAR — compiler mencegah ConversationId dipakai di tempat ContactId
declare const brand: unique symbol;
export type ConversationId = string & { readonly [brand]: 'ConversationId' };
export const ConversationId = z.string().uuid().brand<'ConversationId'>();

// SALAH — alias biasa tidak mencegah apa pun
export type ConversationId = string;
```

Branded type hanya berlaku saat kompilasi dan hilang saat runtime. Untuk data yang datang dari luar, konversinya lewat parser Zod di atas — jangan `as`.

### Komentar menjelaskan kenapa, bukan apa

```ts
// SALAH — mengulang apa yang sudah terbaca dari kode
// tambah attempts
job.attempts += 1;

// BENAR — menjelaskan keputusan yang tidak terlihat dari kode
// Balas 200 meski normalisasi gagal. Kalau kita balas 500, Meta akan
// terus retry dan akhirnya menonaktifkan webhook kita.
return c.body(null, 200);
```

### Batas ukuran

Ini pemicu untuk berhenti dan memeriksa, bukan aturan mati:

- Fungsi di atas 50 baris — apakah ada yang bisa dipisahkan?
- File di atas 500 baris — apakah ada modul yang tersembunyi di dalamnya?
- Fungsi dengan lebih dari 5 parameter — apakah sebagian layak jadi satu objek?

### Larangan pustaka

Sudah diputuskan di PRD, diulang di sini supaya tidak perlu mencari:

| Jangan pakai | Pakai | Alasan |
|---|---|---|
| `telegraf`, `grammy`, `node-telegram-bot-api` | `fetch` langsung ke Bot API | Dispatcher bawaannya bentrok dengan job queue kita |
| Vercel AI SDK `generateText` dengan `maxSteps`, LangChain, Mastra | Loop sendiri | Loop tool-calling adalah produk inti, bukan yang diserahkan |
| BullMQ, Agenda, `node-cron`, `setTimeout` | Tabel `jobs` + `run_after` | Scheduler in-memory hilang saat restart; BullMQ memindahkan sumber kebenaran ke Redis |
| Prisma | Drizzle | Query engine terpisah, kontrol SQL lebih tipis, `SKIP LOCKED` jadi canggung |
| `moment` | Luxon | Tidak lagi dikembangkan, API-nya mutable |
| `neverthrow` | Discriminated union | Menular ke seluruh call stack |
| Token di `localStorage` | Cookie `httpOnly` | Menghapus seluruh kategori kerentanan XSS |
| `fetch` langsung di komponen desk | `lib/api.ts` | Satu tempat, supaya perubahan kontrak menyentuh satu file |

Menambah dependensi baru dibahas dulu berdua, dan wajib diverifikasi jalan di Bun. Untuk tim dua orang, satu dependensi yang salah pilih bisa memakan berhari-hari.

### API khas Bun dibungkus

Empat hal ini adalah satu-satunya yang mengikat proyek ke Bun. Semuanya ditaruh di balik pembungkus tipis sejak Sprint 0:

| API Bun | Pembungkus |
|---|---|
| `Bun.password` | `packages/api/src/lib/password.ts` |
| Impor `.toml` | `packages/domain/src/config/load.ts` |
| `Bun.file` | `packages/rag/src/lib/fs.ts` |
| `bun:test` | Sintaksnya Jest-compatible, sudah portabel |

Jangan memanggil keempatnya langsung dari tempat lain. Ini asuransi yang harganya hampir nol sekarang dan mahal kalau dipasang belakangan.

---

## 9.5 Konvensi Agent Desk

Berlaku untuk `apps/desk/`. Sisanya mengikuti bagian 1–9, yang sekarang berlaku untuk seluruh workspace.

### Stack

| Kebutuhan | Pilihan |
|---|---|
| Bundler & dev server | Vite |
| Routing | TanStack Router |
| Styling | Tailwind + shadcn/ui |
| Data fetching | TanStack Query |
| Realtime | `EventSource` bawaan browser, bukan pustaka pihak ketiga |
| Form | react-hook-form + zod |
| Testing | `bun test` + Testing Library |

### Tipe tidak pernah ditulis ulang

Tipe yang melintasi batas backend–desk **diimpor langsung** dari package `domain` dan `api`. Tidak ada pembangkitan kode, tidak ada folder `types/` hasil generate, tidak ada pemeriksaan `git diff` di CI. Seluruh mekanisme itu gugur bersama keputusan pindah bahasa.

```ts
// BENAR
import type { ConversationSummary } from '@ticko/domain';

// SALAH — akan tidak sinkron diam-diam
interface ConversationSummary { id: string; status: string }
```

### Waktu

Backend selalu mengirim ISO 8601 dalam UTC. Konversi ke zona lokal **hanya** saat render, dan hanya lewat satu helper:

```ts
// apps/desk/src/lib/time.ts — satu-satunya tempat konversi waktu terjadi
export function toLocal(iso: string): DateTime;
export function formatWaiting(since: string): string;
```

Jangan pernah mengirim waktu lokal ke backend. Ini sumber bug zona waktu yang paling sering, dan gejalanya baru muncul saat ada pengguna di zona berbeda.

### Struktur folder

```
apps/desk/src/
├── routes/         ← route TanStack Router
├── components/     ← komponen yang dipakai ulang
└── lib/
    ├── api.ts      ← satu-satunya tempat fetch terjadi
    ├── sse.ts      ← langganan EventSource
    └── time.ts     ← satu-satunya tempat konversi waktu
```

### Same-origin

Backend dan desk berada di satu origin lewat reverse proxy Caddy. Konsekuensinya: tidak ada konfigurasi CORS di mana pun, dan tidak boleh ada. Kalau suatu saat muncul kebutuhan header CORS, itu tanda ada yang salah di konfigurasi proxy, bukan tanda perlu menambah header.

---

## 10. Cara Memperbarui Dokumen Ini

Konvensi yang tidak pernah berubah biasanya konvensi yang tidak dibaca.

- Usul perubahan lewat PR ke file ini, dibahas di ritual "review kontrak" awal sprint
- Aturan yang terbukti menghambat tanpa mencegah bug apa pun **dihapus**, bukan dibiarkan jadi beban
- Setiap aturan baru harus menyebut kelas bug apa yang dicegahnya — kalau tidak bisa disebutkan, aturannya belum layak masuk
- Aturan bertanda ▲ tidak dihapus tanpa penggantinya yang bisa ditegakkan otomatis. Aturan itu ada justru karena tidak ada compiler yang menjaganya
