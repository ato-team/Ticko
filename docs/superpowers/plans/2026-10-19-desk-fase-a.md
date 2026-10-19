# Desk Fase A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Model subagent (keputusan 2026-10-19): implementer & reviewer `sonnet`, eksplorasi `haiku`.
> Grup **G2** dan **G3** (jalur Handoff Integrity) tidak di-merge sebelum review manual user.

**Goal:** Agent CS dan Supervisor menyelesaikan kerja harian dari desk web, Supervisor bisa
menjeda bot dengan jaminan nol panggilan LLM, dan jam kerja diatur dari desk — Sprint 3 selesai utuh.

**Architecture:** Lima grup PR, masing-masing branch baru dari `development` (tidak bertumpuk).
Backend tetap Hono + Drizzle + job queue Postgres; keputusan "bot boleh bekerja" tetap di
dispatcher (`receiveInbound`) dan dicek ulang di worker. Desk adalah SPA Vite di belakang Caddy
same-origin; semua string layar di `apps/desk/src/copy/`.

**Tech Stack:** Bun 1.4, TypeScript strict, Hono, Drizzle (Postgres 16), ioredis, Zod, Luxon
(baru, G5); desk: Vite, React, TanStack Router, TanStack Query, Tailwind, shadcn/ui,
react-hook-form, `bun test` + Testing Library + happy-dom; Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-19-desk-design.md` (§2, §4, §5.1–5.4, §6, §8, §10, §13
Fase A). Tugas Backlog: vault `Ticko Backlog` v2.2 — setiap task di bawah menyebut ID-nya;
checklist "Selesai bila" di Backlog tetap berlaku dan disalin ke deskripsi PR.

## Prasyarat

- PR `[Sprint 2] Backend: events, outbound, tool registry, desk API & SSE` sudah di-merge ke
  `development`. Setiap grup: `git switch development && git pull && git switch -c <branch>`.
- G1 ∥ G2 boleh paralel. G3 sesudah G2 merge. G4 sesudah G1 + G3 merge. G5 sesudah G3 merge.
- Migrasi: ubah `packages/storage/src/schema.ts` lalu `bun run --cwd packages/storage generate`
  (hanya `@rizaldiabyannata`). Trigger/fungsi SQL: `drizzle-kit generate --custom --name <nama>`
  lalu isi SQL-nya, mengikuti `0004_status_transition_trigger.sql`.

## Global Constraints

- `control_owner` dan `bot_state.mode` diperiksa di dispatcher sebelum job `agent_run` dibuat, dan dicek ulang di worker. Bukan di prompt.
- `setTimeout`/`setInterval` hanya di `packages/worker/src/poller.ts` dan `apps/desk/src/lib/tick.ts` (lint `biome-plugins/no-timers.grit`).
- Semua waktu di API string ISO 8601 UTC; konversi zona hanya di `apps/desk/src/lib/time.ts`.
- Tanpa framework agent, `telegraf`/`grammy`, BullMQ, node-cron, Prisma, neverthrow, moment.
- Error API: `{ error: { code, message } }`; desk hanya bercabang pada `code`. Kode baru di Fase A: `FORBIDDEN` (403), `ALREADY_CLAIMED` (409), `NOT_ASSIGNED` (409), `SETUP_INCOMPLETE` (409), `INVALID_SETTINGS` (422), `STALE_SETTINGS` (409), `VALIDATION` (422).
- Tipe yang melintasi backend–desk diimpor dari `@ticko/domain`, tidak ditulis ulang di `apps/desk`.
- Tanpa CORS; cookie `httpOnly`, tanpa token di `localStorage`.
- Kata terlarang di `copy/` di luar `copy.advanced.*` / `copy.technical.*`: `webhook, token, prompt, RAG, embedding, LLM, MCP, API, JSON, job, queue, SSE, handoff, control_owner, dispatcher, tenant, model`.
- Setiap `switch` atas union ditutup `assertNever`; data luar divalidasi Zod, tidak di-`as`.
- Setiap publish `DeskEvent` terjadi **setelah** commit lewat `publishDeskEvent` (tidak melempar).
- Interface baru membawa test double di PR yang sama.

## Review Focus

1. **Pause tepat saat LLM sedang berpikir** — job sudah lewat cek awal lalu Supervisor menekan Jeda: jawaban harus dibuang di bawah row lock, tidak terkirim. Test di Task G3.3.
2. **Percakapan `new` (pelanggan baru) masuk saat bot `setup`/`paused`** — harus tereskalasi dan menerima satu pemberitahuan; pesan lanjutan di periode jeda yang sama tidak memicu pemberitahuan kedua. Test di Task G3.2.
3. **User dinonaktifkan sementara sesinya masih hidup** — request berikutnya 401, login ditolak. Test di Task G3.1.
4. **SSE putus lalu tersambung ulang** — event di celah hilang (at-most-once); desk wajib refetch saat `open` sesudah `error`. Test di Task G1.4.
5. **Dua Supervisor menekan Jeda bersamaan / Jeda saat sudah dijeda** — idempoten: satu transisi, satu baris audit, tidak error. Test di Task G3.3.

---

## G1 — Kerangka desk · branch `b/0.8-desk-scaffold`

### Task G1.1: Scaffold desk + Caddy same-origin (B-0.8)

**Files:**
- Create: `apps/desk/{index.html,vite.config.ts,tsconfig.json,bunfig.toml,components.json}`, `apps/desk/src/{main.tsx,router.tsx,index.css}`, `apps/desk/src/routes/__root.tsx`, `apps/desk/tests/setup.ts`
- Modify: `apps/desk/package.json`, `apps/desk/src/index.ts` (hapus), `docker-compose.yml`, `README.md` (bagian menjalankan lokal)
- Create: `docker/Caddyfile`

**Interfaces:**
- Produces: dev server desk di port `3001`; route tree TanStack Router file-based di `apps/desk/src/routes/`; alias `@/` → `apps/desk/src/`; preload test `apps/desk/tests/setup.ts` (happy-dom `GlobalRegistrator.register()`).

- [ ] **Step 1:** Pasang dependensi desk: `react`, `react-dom`, `@tanstack/react-router`, `@tanstack/router-plugin`, `@tanstack/react-query`, `tailwindcss`, `@tailwindcss/vite`, `vite`, `@vitejs/plugin-react`, `react-hook-form`, `@hookform/resolvers`, `zod`, `@ticko/domain` (workspace); dev: `@testing-library/react`, `@testing-library/user-event`, `@happy-dom/global-registrator`, `@types/react`, `@types/react-dom`. Inisialisasi shadcn/ui (tema default) dengan komponen `button`, `input`, `card`, `badge`, `dialog`, `textarea`, `dropdown-menu`.
- [ ] **Step 2:** `docker/Caddyfile` persis seperti Backlog B-0.8 (`localhost:8080`, `handle /api/*` dan `/webhook/*` → `api:3000`, sisanya → `desk:3001`). Tambah service `api`, `worker`, `desk` (image `oven/bun:1.4`, volume repo, perintah `bun run api` / `bun run worker` / `bun run --cwd apps/desk dev --host 0.0.0.0 --port 3001`) dan `caddy` (`caddy:2`, port `127.0.0.1:8080:8080`) di `docker-compose.yml`.
- [ ] **Step 3:** Verifikasi:
  - `docker compose up -d` → `curl -s localhost:8080/api/health` → `{"status":"ok",...}`
  - `curl -s localhost:8080/ | grep '<div id="root">'` → cocok
  - `grep -ri 'access-control' docker/ apps/desk/ packages/api/src/` → kosong
  - `bun run typecheck && bun run lint` → hijau (desk termasuk `apps/*/src`)
- [ ] **Step 4:** Commit `feat(desk): scaffold Vite desk behind Caddy same-origin (B-0.8)`.

### Task G1.2: Modul bahasa layar `copy/` + test kata terlarang (B-3.8)

**Files:**
- Create: `apps/desk/src/copy/index.ts`, `apps/desk/src/copy/copy.test.ts`

**Interfaces:**
- Produces: `copy` (objek bersarang `as const`, namespace minimal: `nav`, `auth`, `status`, `inbox`, `conversation`, `bot`, `errors`, `advanced`, `technical`); `errorMessage(code: string, serverMessage: string): string` — mengembalikan `copy.errors[code]`, atau `serverMessage` + `console.warn` untuk `code` tak dikenal; `statusLabel(status: ConversationStatus, assigneeName: string | null): string` memakai glosarium spec §8 (`handoff_requested` → "Menunggu manusia", `human_active` → "Sedang ditangani {nama}", `bot_active` → "Ditangani bot").

- [ ] **Step 1: Write the failing test** `copy.test.ts`:
  - `test("tidak ada kata terlarang di luar advanced/technical")` — telusuri semua string daun kecuali di bawah `advanced`/`technical`, cocokkan regex `\b<kata>\b` case-insensitive dengan daftar Global Constraints; harapkan daftar pelanggaran `[]`.
  - `test("pemindai menangkap pelanggaran")` — panggil fungsi pemindai yang sama pada `{ x: "Cek webhook" }` → panjang 1.
  - `test("errorMessage memakai copy.errors lalu fallback")` — `errorMessage("UNAUTHORIZED", "x")` === `copy.errors.UNAUTHORIZED`; `errorMessage("TIDAK_ADA", "pesan server")` === `"pesan server"` dan `console.warn` dipanggil sekali.
  - `test("statusLabel")` — tiga nilai glosarium di atas.
- [ ] **Step 2:** `bun test apps/desk/src/copy` → FAIL (modul belum ada).
- [ ] **Step 3:** Implementasikan `copy/index.ts`; ekspor pemindai sebagai `findForbidden(tree: unknown, path?: string): string[]`. `copy.errors` memuat semua kode di Global Constraints + `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `NOT_FOUND`, `BAD_REQUEST`, `INTERNAL`.
- [ ] **Step 4:** `bun test apps/desk/src/copy` → PASS.
- [ ] **Step 5:** Commit `feat(desk): screen copy module with forbidden-word scan (B-3.8)`.

### Task G1.3: Penjaga peran di API (B-3.7)

**Files:**
- Modify: `packages/api/src/auth.ts`, `packages/api/src/error.ts`
- Create: `packages/api/tests/roles.test.ts`

**Interfaces:**
- Produces: `requireRole(role: UserRole): MiddlewareHandler<Env>` (dipasang **sesudah** `requireAuth`); `AppError` baru `{ kind: "forbidden" }` → 403 `FORBIDDEN` "Anda tidak punya akses ke halaman ini"; di `roles.test.ts` array `ADMIN_ROUTES: Array<[method: string, path: string]>` yang **ditambah oleh setiap task berikutnya** yang membuat route admin; tes diparameterisasi atas array itu.

- [ ] **Step 1: Write the failing test** `roles.test.ts`: app uji dengan satu route `GET /api/_admin-probe` di belakang `requireAuth` + `requireRole("admin")`; `ADMIN_ROUTES = [["GET", "/api/_admin-probe"]]` (probe hanya di file test). Untuk setiap entri: sesi `agent` → status 403 dan body `{ error: { code: "FORBIDDEN" } }`; sesi `admin` → bukan 403; tanpa sesi → 401.
- [ ] **Step 2:** `bun test packages/api/tests/roles.test.ts` → FAIL.
- [ ] **Step 3:** Implementasikan `requireRole` dan cabang `forbidden` di `toResponse`.
- [ ] **Step 4:** Test → PASS; `bun test packages/api` → hijau.
- [ ] **Step 5:** Commit `feat(api): requireRole middleware with per-route 403 test (B-3.7)`.

### Task G1.4: Klien API terketik, login, dan langganan realtime (B-2.5, B-2.2)

**Files:**
- Create: `apps/desk/src/lib/api.ts`, `apps/desk/src/lib/sse.ts`, `apps/desk/src/lib/time.ts`, `apps/desk/src/routes/login.tsx`, `apps/desk/src/routes/_auth.tsx` (layout terlindungi), `apps/desk/src/routes/index.tsx`
- Test: `apps/desk/tests/api.test.ts`, `apps/desk/tests/sse.test.ts`

**Interfaces:**
- Consumes: `errorMessage` (G1.2); `User`-shape dari `GET /api/me` (`{ id, email, displayName, role }`).
- Produces: `class ApiError extends Error { status: number; code: string }`; `api.get<T>(path: string): Promise<T>`, `api.post<T>(path: string, body?: unknown): Promise<T>`, `api.put<T>(path, body)`, `api.del(path)` — semuanya `credentials: "include"`, 401 → `onUnauthorized()` (diset router ke `navigate({ to: "/login" })`) lalu melempar `ApiError`; `subscribeDesk(handlers: { onEvent(e: DeskEvent): void; onReconnect(): void }): () => void` — `EventSource("/api/stream")`, validasi `DeskEvent.safeParse`, `onReconnect` dipanggil pada `open` yang terjadi **sesudah** `error`; `toLocal(iso: string): DateTime`, `formatWaiting(since: string): string` (Luxon). Route `/` → `/inbox` untuk `agent`, `/beranda` untuk `admin` (halaman beranda kosong dulu, diisi G4.5).

- [ ] **Step 1: Write the failing tests**
  - `api.test.ts`: fetch di-stub; respons 409 `{error:{code:"ALREADY_CLAIMED",message:"m"}}` → `ApiError` dengan `code === "ALREADY_CLAIMED"`; respons 401 → `onUnauthorized` dipanggil sekali; setiap request membawa `credentials: "include"`.
  - `sse.test.ts`: `EventSource` palsu; `open` pertama tidak memanggil `onReconnect`; urutan `error` → `open` memanggilnya sekali; data bukan `DeskEvent` sah tidak sampai ke `onEvent`.
- [ ] **Step 2:** `bun test apps/desk/tests` → FAIL.
- [ ] **Step 3:** Implementasikan modul, halaman login (react-hook-form + zod, pesan dari `copy.auth`/`errorMessage`), layout `_auth` yang memanggil `GET /api/me` dan logout.
- [ ] **Step 4:** Test → PASS. Manual di `localhost:8080`: login sukses → `/inbox`; buka `/inbox` tanpa sesi → `/login`; `grep -rn localStorage apps/desk/src` → kosong.
- [ ] **Step 5:** Commit `feat(desk): typed api client, login and SSE subscription (B-2.5, B-2.2)`.

### Task G1.5: Halaman inbox (B-2.6, bagian yang tidak butuh Sprint 3)

**Files:**
- Create: `apps/desk/src/routes/_auth/inbox.tsx`, `apps/desk/src/components/conversation-row.tsx`
- Test: `apps/desk/tests/inbox.test.tsx`

**Interfaces:**
- Consumes: `api.get<Page<ConversationSummary>>("/api/conversations?...")`, `subscribeDesk`, `statusLabel`, `formatWaiting`.
- Produces: query key `["conversations", filter]` dipakai ulang G4; `handleDeskEvent(qc: QueryClient, e: DeskEvent): void` ditutup `assertNever` (invalidate `["conversations"]` dan `["conversation", id]`).

Filter peran (AC-6.1) dan urutan urgensi butuh `assigned_user_id`/`handoff_events` dari G2 → dikerjakan di Task G4.1.

- [ ] **Step 1: Write the failing test** `inbox.test.tsx` (Testing Library): `onReconnect` dari `subscribeDesk` palsu → `queryClient.invalidateQueries` dipanggil dengan `["conversations"]`; event `message_received` juga meng-invalidate.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Implementasikan halaman (kolom kontak, channel, label status, pesan terakhir, lama menunggu).
- [ ] **Step 4:** Test → PASS. Manual: `bun run db:seed`, inbox menampilkan 30 percakapan; pesan Telegram baru muncul tanpa refresh; `docker compose restart redis` lalu kirim pesan → tetap muncul (refetch).
- [ ] **Step 5:** Commit `feat(desk): realtime inbox with refetch on reconnect (B-2.6)`.

---

## G2 — Handoff Integrity · branch `a/3.1-handoff-transaksional`

Dikerjakan **apa adanya** (Backlog A-3.1, A-3.2, A-3.3, A-3.6). Tanpa audit, tanpa `bot_state`.

### Task G2.1: Test race handoff lebih dulu (A-3.3, A-3.2)

**Files:**
- Create: `packages/worker/tests/handoff-race.test.ts`, `packages/worker/tests/dispatch.test.ts`

**Interfaces:**
- Consumes: `receiveInbound(db, msg, traceId)`; `requestHandoff` dari Task G2.2 (belum ada → test merah); `agentRunHandler` + `FakeLlm`; `createTestDb()` (commit sungguhan, bukan `withTestDb`).

- [ ] **Step 1: Write the failing tests**
  - `dispatch.test.ts`: percakapan `human_active` menerima pesan → `botScheduled === false` dan nol baris `jobs` `agent_run` pending (AC-5.2); `handoff_requested` sama.
  - `handoff-race.test.ts`: percakapan `bot_active`; `Promise.all` 10 `receiveInbound` + 1 `requestHandoff`; lalu jalankan `agentRunHandler` untuk setiap job `agent_run` yang masih pending/ada. Assert: 10 pesan `contact` tersimpan; nol pesan `sender_type='bot'` setelah handoff tercatat; nol baris `outbound_queue` untuk balasan bot.
- [ ] **Step 2:** `bun test packages/worker/tests/handoff-race.test.ts` → FAIL (`requestHandoff` belum ada).
- [ ] **Step 3:** Commit test merah di branch: `test(worker): handoff race and dispatcher enforcement (A-3.3, A-3.2)`.

### Task G2.2: Handoff transaksional (A-3.1)

**Files:**
- Modify: `packages/storage/src/schema.ts` (+ migrasi), `packages/domain/src/event.ts`
- Create: `packages/worker/src/handoff.ts`
- Test: `packages/worker/tests/handoff.test.ts`

**Interfaces:**
- Produces:
  - Tabel `handoff_events (id uuid PK, conversation_id FK, reason text NOT NULL, urgency urgency enum NOT NULL, summary text NULL, trigger_source text CHECK IN ('bot','rule','agent','system'), created_at)` + index `(conversation_id, created_at)`; kolom `conversations.assigned_user_id uuid NULL REFERENCES users` + index.
  - `HandoffInput = { conversationId: ConversationId; reason: string; urgency: Urgency; summary: string | null; triggerSource: "bot" | "rule" | "agent" | "system" }`
  - `handoffInTx(tx: Tx, input: HandoffInput): Promise<{ ok: true; event: DeskEvent } | { ok: false; reason: "invalid_transition" }>` — dalam transaksi pemanggil: `changeStatus(tx, { id, event: "handoff_requested" })`, insert `handoff_events`, `UPDATE jobs SET status='cancelled', last_error='handoff' WHERE conversation_id=$1 AND job_type='agent_run' AND status='pending'`. Mengembalikan event `handoff_requested` untuk diterbitkan pemanggil **setelah** commit.
  - `requestHandoff(db: Db, input: HandoffInput, notify: (e: DeskEvent) => Promise<void>): Promise<{ ok: boolean }>` — membuka transaksi, memanggil `handoffInTx`, publish setelah commit.
  - Catatan: Backlog menulis `DELETE FROM jobs`; dipakai `status='cancelled'` supaya jejak tetap ada — poller hanya mengambil `pending`, efeknya sama.

- [ ] **Step 1: Write the failing test** `handoff.test.ts`: (a) sukses → status `handoff_requested`, satu baris `handoff_events`, job `agent_run` pending jadi `cancelled`, job `send_message` tidak tersentuh; (b) insert `handoff_events` dipaksa gagal (urgency tak valid lewat SQL mentah) → status percakapan dan job **tidak** berubah; (c) `notify` dipanggil setelah commit — stub `notify` membaca status dari koneksi lain dan melihat `handoff_requested`; (d) dari `human_active` → `{ ok: false, reason: "invalid_transition" }`.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Ubah schema, `generate`, implementasikan `handoff.ts`.
- [ ] **Step 4:** `bun test packages/worker` → `handoff.test.ts` dan Task G2.1 PASS. Ulang 50×: `for i in $(seq 50); do bun test packages/worker/tests/handoff-race.test.ts || break; done` → 50 lulus.
- [ ] **Step 5:** Commit `feat(worker): transactional handoff cancelling pending agent runs (A-3.1)`.

### Task G2.3: Claim dengan optimistic locking (A-3.6)

**Files:**
- Modify: `packages/storage/src/repo/index.ts`, `packages/storage/src/repo/types.ts` (bila perlu), `packages/storage/src/fake/index.ts`, `packages/storage/tests/repo-contract.test.ts`, `packages/api/src/conversations.ts`, `packages/api/src/error.ts`, `packages/api/src/main.ts`
- Test: `packages/storage/tests/claim-race.test.ts`, `packages/api/tests/conversations.test.ts`

**Interfaces:**
- Produces: `claimConversation(tx: Tx, id: ConversationId, userId: UserId, version: number): Promise<ClaimResult>` — `UPDATE conversations SET status='human_active', control_owner='human', assigned_user_id=$u, version=version+1 WHERE id=$1 AND version=$2 AND status IN ('bot_active','handoff_requested') RETURNING *`, satu baris `conversation_events` (`agent_claimed`, `triggered_by_user_id`), pembatalan job `agent_run` pending; nol baris → `already_claimed` (atau `not_found` bila id tidak ada). Fake ikut mengubah `status`/`controlOwner`. `ConversationDeps.claim(id, userId, version)`; route `POST /api/conversations/:id/claim` body `{ version: number }` → 200 `ConversationDetail` | 409 `ALREADY_CLAIMED` | 404. `AppError` `{ kind: "already_claimed" }`.

- [ ] **Step 1: Write the failing tests**: kontrak (fake + Drizzle): dua claim versi sama → satu `ok`, satu `already_claimed`; `claim-race.test.ts`: 20 claim bersamaan via `createTestDb` → tepat 1 sukses, `assigned_user_id` = pemenang; API: claim versi lama → 409 `ALREADY_CLAIMED`.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Implementasi.
- [ ] **Step 4:** Test → PASS; race G2.1 50× tetap lulus.
- [ ] **Step 5:** Commit `feat: claim with optimistic locking and 409 ALREADY_CLAIMED (A-3.6)`.

PR G2 → judul `[A-3.1] Handoff transaksional, penegakan, race test, claim`. **Review manual user sebelum merge.**

---

## G3 — Kendali bot · branch `a/3.7-bot-state`

### Task G3.1: `settings`, `audit_log`, `users.active` (A-3.7)

**Files:**
- Modify: `packages/storage/src/schema.ts` (+ migrasi + migrasi custom trigger), `packages/storage/src/repo/index.ts`
- Create: `packages/domain/src/settings/index.ts`, `packages/storage/src/settings.ts`
- Test: `packages/storage/tests/settings.test.ts`, `packages/storage/tests/audit.test.ts`, `packages/api/tests/auth.test.ts` (tambahan)

**Interfaces:**
- Produces:
  - SQL: `settings (section text PK, value jsonb NOT NULL, version int NOT NULL DEFAULT 1, updated_by uuid NULL REFERENCES users, updated_at timestamptz)`; `audit_log (id uuid PK, at timestamptz DEFAULT now(), actor_user_id uuid NULL REFERENCES users, action text NOT NULL, target_kind text NOT NULL, target_id text NULL, before jsonb NULL, after jsonb NULL, trace_id text NULL)` + trigger yang `RAISE EXCEPTION` pada `UPDATE`/`DELETE`; `users.active boolean NOT NULL DEFAULT true`.
  - Domain: `BotMode = z.enum(["setup","active","paused"])`; `BotState = z.object({ mode: BotMode, since: z.iso.datetime(), by: UserId.nullable(), reason: z.string().nullable() })`; `SETTINGS = { bot_state: BotState }` (G5 menambah `time_policy`); `type SectionName = keyof typeof SETTINGS`; `type SectionValue<S>`.
  - Storage (`settings.ts` — satu-satunya jalan ke tabel `settings`, "SettingsRepo" di spec §5.6; fungsi ber-`Executor` seperti repo lain, jadi tidak ada interface baru yang butuh fake):
    - `getSetting<S extends SectionName>(ex, section: S): Promise<{ value: SectionValue<S>; version: number; updatedBy: UserId | null } | null>` — `SETTINGS[section].parse`; gagal parse → lempar (tidak ada default diam-diam).
    - `saveSetting<S>(tx: Tx, input: { section: S; value: SectionValue<S>; version: number; userId: UserId | null; traceId: string | null }): Promise<{ ok: true; version: number } | { ok: false; reason: "stale" }>` — `UPDATE … WHERE section=$1 AND version=$2`, menulis `audit_log` (`action: "settings.update"`, `target_kind: "settings"`, `target_id: section`, before/after) di transaksi yang sama.
    - `insertSettingIfMissing<S>(ex, section: S, value: SectionValue<S>): Promise<void>` — `ON CONFLICT DO NOTHING`, `updated_by NULL`.
    - `appendAudit(ex, row: { actorUserId: UserId | null; action: string; targetKind: string; targetId: string | null; before?: unknown; after?: unknown; traceId: string | null }): Promise<void>`.
  - `findUserByEmail` dan `findSessionUser` mengabaikan user `active = false`.

- [ ] **Step 1: Write the failing tests**: `audit.test.ts` — insert lalu `UPDATE audit_log` dan `DELETE FROM audit_log` → `pgErrorCode` `P0001`; `settings.test.ts` — `saveSetting` versi 1 → `{ ok:true, version:2 }` + satu baris audit; simpan lagi versi 1 → `stale` tanpa baris audit baru; `value` korup di DB (SQL mentah `{"mode":"x"}`) → `getSetting` melempar; `insertSettingIfMissing` dua kali → satu baris, nilai pertama; `auth.test.ts` — user `active=false`: login → 401 `INVALID_CREDENTIALS`, sesi lama → 401.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Implementasi + migrasi.
- [ ] **Step 4:** `bun test packages/storage packages/api` → PASS.
- [ ] **Step 5:** Commit `feat(storage): settings, append-only audit_log and users.active (A-3.7)`.

### Task G3.2: Mode bot di dispatcher + pemberitahuan (A-3.8, lapis 2)

**Files:**
- Modify: `packages/worker/src/dispatch.ts`, `packages/api/src/main.ts`, `packages/worker/src/main.ts`, `packages/domain/src/event.ts`
- Create: `packages/worker/src/bot-state.ts`, `packages/worker/src/notices.ts`
- Test: `packages/worker/tests/bot-state-dispatch.test.ts`

**Interfaces:**
- Consumes: `getSetting`, `insertSettingIfMissing` (G3.1); `handoffInTx` (G2.2).
- Produces:
  - `ensureBotState(db: Db, opts: { telegramConfigured: boolean }): Promise<void>` — dipanggil di `main.ts` api dan worker saat start: bila section belum ada, isi `mode: telegramConfigured ? "active" : "setup"`, `since: now UTC`, `by: null`, `reason: null`. (Pengganti "mode awal hasil migrasi" — SQL tidak bisa membaca env.)
  - `getBotState(ex): Promise<BotState>` — section tidak ada → `{ mode: "setup", … }` (guardrail #7).
  - `BOT_INACTIVE_NOTICE = "Terima kasih, pesan Anda sudah kami terima. Tim kami akan membalas secepatnya."` di `notices.ts`.
  - `ReceiveResult` `stored` mendapat `deskEvents: DeskEvent[]` (diterbitkan pemanggil setelah commit; `main.ts` api menerbitkan semuanya bersama `message_received`).
  - Di `receiveInbound`, sesudah `changeStatus`: bila `next.controlOwner === "bot"` dan `mode !== "active"` → `handoffInTx(tx, { reason: "bot_inactive", urgency: "normal", summary: null, triggerSource: "system" })`, `botScheduled = false`, dan kirim `BOT_INACTIVE_NOTICE` (lewat `insertOutbound` `senderType: "system"` + `insertOutboundQueue` + `enqueue send_message`) **hanya bila** belum ada `handoff_events` `reason='bot_inactive'` untuk percakapan ini dengan `created_at >= bot_state.since`.
  - DeskEvent baru `{ type: "bot_state_changed"; mode: BotMode }`.

- [ ] **Step 1: Write the failing tests** (`createTestDb`, `FakeLlm` dengan penghitung panggilan): mode `paused` + percakapan `new` → pesan tersimpan, status `handoff_requested`, satu pesan `system` berisi `BOT_INACTIVE_NOTICE`, nol job `agent_run`; pesan kedua di periode yang sama → nol pemberitahuan baru; percakapan `human_active` saat `paused` → status tetap, nol pemberitahuan, nol eskalasi; mode `active` → perilaku lama (`botScheduled` true); `ensureBotState` dengan `telegramConfigured: true` pada DB kosong → `active`, dipanggil ulang tidak mengubah nilai.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Implementasi.
- [ ] **Step 4:** Test → PASS; race G2.1 50× lulus.
- [ ] **Step 5:** Commit `feat(worker): enforce bot mode in dispatcher with one-time notice (A-3.8)`.

### Task G3.3: Jeda/aktifkan — lapis 1 dan 3 + API (A-3.8)

**Files:**
- Modify: `packages/worker/src/bot-state.ts`, `packages/worker/src/handlers/agent.ts`, `packages/channels/src/telegram/adapter.ts`, `packages/api/src/app.ts`, `packages/api/src/main.ts`, `packages/api/src/error.ts`, `packages/api/tests/roles.test.ts`
- Create: `packages/api/src/bot.ts`
- Test: `packages/worker/tests/bot-state.test.ts`, `packages/api/tests/bot.test.ts`

**Interfaces:**
- Produces:
  - `setBotMode(db: Db, input: { mode: BotMode; userId: UserId; reason: string | null; traceId: string }): Promise<{ changed: boolean; state: BotState }>` — satu transaksi dengan `SELECT … FOR UPDATE` pada baris `settings` `bot_state`; mode sama → `{ changed: false }` tanpa audit; ke `paused` → juga `UPDATE jobs SET status='cancelled', last_error='bot_paused' WHERE job_type='agent_run' AND status='pending'`; tulis audit `action: "bot.pause" | "bot.resume" | "bot.activate"`.
  - `agentRunHandler`: `getBotState` dicek di awal (di samping cek `control_owner`) **dan** di bawah row lock sebelum menyimpan jawaban → `cancelled("bot tidak aktif")`, run dicatat `discarded`.
  - `TelegramAdapter.getWebhookInfo(signal: AbortSignal): Promise<{ url: string; lastErrorDate: number | null }>`; mock server B-1.6 ikut mendukung method ini.
  - `BotDeps = { getState(): Promise<BotState>; setMode(input): Promise<{ changed: boolean; state: BotState }>; checkSetup(): Promise<{ telegram: "ok" | "missing" | "unknown"; activeUsers: number }>; notify(e: DeskEvent): Promise<void> }`; `botRoutes(deps: BotDeps): Hono<Env>`: `GET /state` (semua peran) → `{ mode, since, by }`; `POST /pause` body `{ reason: string }` (min 1), `POST /resume`, `POST /activate` — ketiganya `requireRole("admin")`; `activate` dari `setup` butuh `telegram === "ok"` dan `activeUsers >= 1`, selain itu 409 `SETUP_INCOMPLETE`; `checkSetup` memakai `getWebhookInfo(AbortSignal.timeout(5000))`, URL harus sama dengan URL webhook instalasi (dari config). Setiap `changed: true` → `notify({ type: "bot_state_changed", mode })` setelah commit. Tambah keempat route admin ke `ADMIN_ROUTES`.

- [ ] **Step 1: Write the failing tests**:
  - `bot-state.test.ts`: (a) job `agent_run` pending lalu `setBotMode(paused)` → job `cancelled`; (b) job sudah di-`claim` poller, lalu pause, lalu handler dijalankan → `FakeLlm` dipanggil 0 kali; (c) LLM palsu yang memanggil `setBotMode(paused)` di tengah `complete()` → jawaban `discarded`, nol `outbound_queue`; (d) dua `setBotMode(paused)` bersamaan → tepat satu `changed: true`, satu baris audit.
  - `bot.test.ts`: `agent` → 403 di pause/resume/activate, 200 di `GET /state`; activate dengan `telegram: "unknown"` → 409 `SETUP_INCOMPLETE`; pause → `notify` dipanggil dengan `bot_state_changed`.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Implementasi.
- [ ] **Step 4:** `bun test` → PASS; race G2.1 50× lulus.
- [ ] **Step 5:** Commit `feat: pause/resume/activate bot with three-layer zero-LLM guarantee (A-3.8)`.

### Task G3.4: Audit aksi manusia + `GET /api/audit` (A-3.9)

**Files:**
- Modify: `packages/storage/src/repo/index.ts` (`claimConversation`), `packages/api/src/app.ts`, `packages/api/src/main.ts`, `packages/api/tests/roles.test.ts`
- Create: `packages/api/src/audit.ts`
- Test: `packages/storage/tests/claim-audit.test.ts`, `packages/api/tests/audit.test.ts`

**Interfaces:**
- Produces: `claimConversation` memanggil `appendAudit` (`action: "conversation.claim"`, `target_kind: "conversation"`) di transaksi yang sama, hanya pada jalur sukses; `listAudit(ex, q: { from?: string; to?: string; actorUserId?: UserId; page: number; pageSize: number }): Promise<Page<AuditEntry>>`; `AuditEntry` di `@ticko/domain/desk.ts` (`{ id, at, actorUserId, actorName, action, targetKind, targetId, before, after }`); `GET /api/audit` (admin). Tambah ke `ADMIN_ROUTES`.

- [ ] **Step 1: Write the failing tests**: claim sukses → satu baris audit; `already_claimed` → nol baris; `GET /api/audit?from=…` mengembalikan halaman terurut `at` menurun; `agent` → 403.
- [ ] **Step 2:** Test → FAIL.
- [ ] **Step 3:** Implementasi.
- [ ] **Step 4:** Test → PASS. **Ulang race 50×** (G2.1) dan claim race (G2.3) 50× → semua lulus.
- [ ] **Step 5:** Commit `feat: audit human actions and GET /api/audit (A-3.9)`.

PR G3 → `[A-3.8] Mode bot, settings, audit`. **Review manual user sebelum merge.**

---

## G4 — Desk kerja harian · branch `b/3.1-detail-percakapan`

### Task G4.1: API kerja agent — inbox per peran, balas, kembalikan, ringkasan bot (B-2.6 sisa, B-3.3, B-3.4, B-3.1)

**Files:**
- Modify: `packages/storage/src/repo/index.ts` (`listInbox`, handback), `packages/storage/src/fake/index.ts`, `packages/api/src/conversations.ts`, `packages/api/src/main.ts`, `packages/domain/src/desk.ts`
- Create: `packages/domain/src/handback.ts`
- Test: `packages/storage/tests/repo-contract.test.ts`, `packages/api/tests/conversations.test.ts`

**Interfaces:**
- Produces:
  - `listInbox(ex, filter & { scope: { kind: "all" } | { kind: "mine_and_queue"; userId: UserId } })` — `mine_and_queue` = `assigned_user_id = userId` ∪ `status = 'handoff_requested'`; urutan: rank urgensi `handoff_events` terakhir (`URGENCY_RANK`) menurun, lalu `last_inbound_at` menaik. Route memilih scope dari `c.get("user").role`.
  - `ConversationSummary` + `assignee: { id: UserId; displayName: string } | null`.
  - `HandbackNote = z.string().trim().min(20)` di domain (dipakai desk dan api).
  - `POST /api/conversations/:id/messages` body `{ content: string }` — hanya `assigned_user_id = user` dan status `human_active`, selain itu 409 `NOT_ASSIGNED`; `insertOutbound` `senderType: "human"` + `senderUserId` + `outbound_queue` + `enqueue send_message` + audit `conversation.reply`.
  - `POST /api/conversations/:id/handback` body `{ note }` — `HandbackNote` gagal → 422 `VALIDATION`; `changeStatus(handed_back)`, `assigned_user_id = NULL`, catatan di `conversation_events`/audit `conversation.handback`; bukan pemilik → 409 `NOT_ASSIGNED`.
  - `GET /api/conversations/:id/runs` → `BotActivity[]` = `{ at; kind: "replied" | "escalated" | "discarded" | "failed"; reason: string | null; technical: { model; promptTokens; completionTokens; costEstimate } | null }` dari `agent_runs` + `handoff_events`; `technical` hanya untuk `admin`.

- [ ] **Step 1: Write the failing tests**: agent melihat miliknya + antrian, tidak melihat milik agent lain; supervisor melihat semua; urgensi `critical` di atas `normal`; balas oleh bukan pemilik → 409 `NOT_ASSIGNED`; catatan 19 karakter → 422; handback sukses → `bot_active`, `assigned_user_id` NULL, satu audit; `/runs` sebagai `agent` → `technical: null`.
- [ ] **Step 2:** Test → FAIL. **Step 3:** Implementasi. **Step 4:** `bun test` → PASS.
- [ ] **Step 5:** Commit `feat(api): role-scoped inbox, human reply, handback and bot activity (B-3.1, B-3.3, B-3.4)`.

### Task G4.2: Presence (B-3.2)

**Files:**
- Modify: `packages/storage/src/schema.ts` (+ migrasi), `packages/api/src/stream.ts`, `packages/api/src/app.ts`, `packages/api/src/main.ts`, `packages/domain/src/desk.ts`
- Create: `packages/api/src/presence.ts`
- Test: `packages/api/tests/presence.test.ts`

**Interfaces:**
- Produces: tabel `user_presence (user_id PK FK, status text CHECK IN ('online','busy','away'), max_concurrent int NOT NULL DEFAULT 5, updated_at)`; status efektif `offline` bila kunci Redis `presence:<userId>` tidak ada. **Tanpa timer di browser:** `deskStream` menyetel `presence:<userId>` dengan `EX 60` saat tersambung dan di setiap heartbeat (30 dtk); tab tertutup → kunci kedaluwarsa ≤ 60 dtk. `currentLoad` = `COUNT(conversations WHERE assigned_user_id = u AND status = 'human_active')` saat dibaca (keputusan 2026-09-17). `GET /api/presence` → `Presence[]` (`{ userId, displayName, status: "online"|"busy"|"away"|"offline", currentLoad, maxConcurrent }`); `PUT /api/presence` body `{ status }` untuk diri sendiri.

- [ ] **Step 1: Write the failing tests**: tanpa kunci Redis → `offline`; `PUT` `busy` + kunci ada → `busy`; `currentLoad` mengikuti claim/handback.
- [ ] **Step 2–4:** FAIL → implementasi → PASS. Manual: tutup tab, `GET /api/presence` → `offline` ≤ 60 dtk.
- [ ] **Step 5:** Commit `feat(api): presence via SSE-refreshed TTL and computed load (B-3.2)`.

### Task G4.3: Template balasan di database (B-3.5 backend)

**Files:**
- Modify: `packages/storage/src/schema.ts` (+ migrasi), `packages/api/src/app.ts`, `packages/api/src/main.ts`, `packages/api/tests/roles.test.ts`, `packages/domain/src/desk.ts`
- Create: `packages/api/src/canned.ts`
- Test: `packages/api/tests/canned.test.ts`

**Interfaces:**
- Produces: `canned_responses (id uuid PK, title text NOT NULL, body text NOT NULL, created_by FK, updated_at)`; `CannedResponse` di domain; `GET /api/canned-responses` (semua peran), `POST` / `PUT /:id` / `DELETE /:id` (admin, audit `canned.*`); tambah ke `ADMIN_ROUTES`. Placeholder `{nama_customer}` diisi di desk, bukan server.

- [ ] **Step 1–4:** test CRUD + 403 agent → FAIL → implementasi → PASS.
- [ ] **Step 5:** Commit `feat(api): canned responses stored in database (B-3.5)`.

### Task G4.4: Halaman detail percakapan + aksi (B-3.1, B-3.3, B-3.4, B-3.5 UI)

**Files:**
- Create: `apps/desk/src/routes/_auth/inbox.$id.tsx`, `apps/desk/src/components/{reply-box,handback-dialog,bot-activity,canned-picker}.tsx`
- Modify: `apps/desk/src/copy/index.ts`, `apps/desk/src/routes/_auth/inbox.tsx`
- Test: `apps/desk/tests/conversation-actions.test.tsx`

**Interfaces:**
- Consumes: G4.1 routes, G4.3 `GET /api/canned-responses`, `HandbackNote`, `errorMessage`.
- Produces: tombol **Ambil alih** tampil hanya bila status `bot_active`/`handoff_requested`; kotak balas & **Kembalikan ke bot** hanya bila `assignee.id === me`; panel "Apa yang dilakukan bot" dari `/runs` (lipatan "Detail teknis" hanya bila `technical !== null`); `fillPlaceholders(body: string, ctx: { nama_customer: string }): string`.

- [ ] **Step 1: Write the failing tests** (Testing Library, `api` di-stub): claim → `ApiError("ALREADY_CLAIMED")` menampilkan `copy.errors.ALREADY_CLAIMED`, bukan `message` server; Agent CS bukan pemilik tidak melihat kotak balas; tombol kirim `disabled` selama request berjalan; submit handback dengan 19 karakter tetap `disabled`; memilih template mengisi kotak balas (tidak mengirim) dengan `{nama_customer}` terganti.
- [ ] **Step 2–4:** FAIL → implementasi → PASS. Manual end-to-end (DoD Sprint 3): login agent → ambil alih → balas (sampai di Telegram) → kembalikan ke bot; selama `human_active` bot tidak menjawab.
- [ ] **Step 5:** Commit `feat(desk): conversation detail with claim, reply, handback and bot activity (B-3.1, B-3.3, B-3.4)`.

### Task G4.5: Status agent, Jeda/Aktifkan bot, beranda minimal (B-3.6, B-3.9)

**Files:**
- Create: `apps/desk/src/components/{presence-menu,bot-control}.tsx`, `apps/desk/src/routes/_auth/beranda.tsx`, `apps/desk/src/routes/_auth/template.tsx`
- Modify: `apps/desk/src/routes/_auth.tsx`, `apps/desk/src/copy/index.ts`, `apps/desk/src/routes/_auth/inbox.tsx` (`handleDeskEvent` + `bot_state_changed`)
- Test: `apps/desk/tests/bot-control.test.tsx`

**Interfaces:**
- Produces: header menampilkan status agent ("3 / 5") dan pengubahnya; untuk `admin`: status bot ("Aktif" / "Dijeda" / "Belum aktif"), tombol **Jeda bot** (dialog alasan + konfirmasi) atau **Aktifkan bot**; `SETUP_INCOMPLETE` → `copy.bot.setupIncomplete` ("Bot belum bisa diaktifkan: pastikan Telegram tersambung dan ada anggota tim aktif."). Rincian per langkah menyusul di B-4.12. `/beranda` (admin): status bot + jumlah "Menunggu manusia" (`GET /api/conversations?status=handoff_requested` → `total`). `/template` (admin): kelola template balasan. Navigasi per peran sesuai spec §5.1 (Laporan/Pengaturan belum dirender di Fase A).

- [ ] **Step 1: Write the failing tests**: role `agent` → tidak ada tombol Jeda/Aktifkan, tidak ada link Beranda/Template; `admin` + `SETUP_INCOMPLETE` → teks `copy.bot.setupIncomplete`; event `bot_state_changed` → query `["bot-state"]` di-invalidate.
- [ ] **Step 2–4:** FAIL → implementasi → PASS. Manual: dua tab Supervisor, jeda di satu → tab lain berubah tanpa refresh; kirim pesan Telegram saat dijeda → pelanggan menerima pemberitahuan, percakapan masuk "Menunggu manusia".
- [ ] **Step 5:** Commit `feat(desk): agent status, bot pause control and minimal home (B-3.6, B-3.9)`.

---

## G5 — Jam kerja · branch `a/3.4-time-policy`

### Task G5.1: Time policy engine (A-3.4)

**Files:**
- Create: `packages/domain/src/time/{policy.ts,index.ts}`
- Modify: `packages/domain/src/settings/index.ts`, `packages/domain/package.json` (+ `luxon`, `@types/luxon`)
- Test: `packages/domain/tests/time-policy.test.ts`

**Interfaces:**
- Produces: `TimePolicyConfig` (Zod; bentuk mengikuti PRD FR-15.1 — jadwal bernama dengan `priority`, `days`, `from`/`to` `"HH:mm"`, `zone` IANA, field policy `slaFirstResponse`, `handoffMode`, `personaVariant`; hari libur tanggal tunggal & rentang) dengan `superRefine` yang menolak dua jadwal prioritas sama yang rentangnya tumpang tindih (issue `path` menunjuk jadwal kedua) dan zona tak dikenal; `resolvePolicy(now: DateTime, cfg: TimePolicyConfig): EffectivePolicy`; `DEFAULT_TIME_POLICY` (Senin–Jumat 08:00–17:00 `Asia/Jakarta`, nilai awal siap pakai — AC-D2.3); `SETTINGS.time_policy = TimePolicyConfig`.

- [ ] **Step 1: Write the failing tests** — salin "Selesai bila" A-3.4 sebagai test: `jam_sibuk` menimpa `slaFirstResponse` tapi mewarisi `handoffMode` (AC-15.2); hari libur menonaktifkan jadwal kerja (AC-15.3); `22:00–02:00` benar pada 23:30 dan 01:00 (AC-15.4); dua jadwal prioritas sama tumpang tindih → `safeParse` gagal dengan `path` ke jadwal itu (AC-15.5); zona `"Mars/Base"` → gagal; `packages/domain` tetap tanpa IO (`bun run check:domain-deps` hijau).
- [ ] **Step 2–4:** FAIL → implementasi → PASS (juga dengan `TZ=UTC bun test packages/domain`).
- [ ] **Step 5:** Commit `feat(domain): layered time policy resolution (A-3.4)`.

### Task G5.2: `businessElapsed` (A-3.5)

**Files:**
- Create: `packages/domain/src/time/elapsed.ts`
- Test: `packages/domain/tests/business-elapsed.test.ts`

**Interfaces:**
- Produces: `businessElapsed(from: DateTime, to: DateTime, cfg: TimePolicyConfig): Duration`.

- [ ] **Step 1: Write the failing tests** — minimal 15 kasus dari A-3.5 (satu hari kerja, melintasi malam, akhir pekan, libur panjang, jadwal lintas tengah malam, `from === to`), termasuk handoff 16:58 dengan jam kerja berakhir 17:00 → pada 17:01 elapsed = 2 menit (AC-15.8).
- [ ] **Step 2–4:** FAIL → implementasi → PASS dengan `TZ=UTC`.
- [ ] **Step 5:** Commit `feat(domain): businessElapsed over business hours (A-3.5)`.

### Task G5.3: Endpoint pengaturan generik (A-3.4)

**Files:**
- Create: `packages/api/src/settings.ts`
- Modify: `packages/api/src/app.ts`, `packages/api/src/main.ts`, `packages/api/src/error.ts`, `packages/api/tests/roles.test.ts`, `packages/worker/src/main.ts`, `packages/domain/src/event.ts`
- Test: `packages/api/tests/settings.test.ts`

**Interfaces:**
- Consumes: `getSetting`, `saveSetting`, `insertSettingIfMissing` (G3.1); `SETTINGS`.
- Produces: `EDITABLE_SECTIONS = ["time_policy"] as const` (`bot_state` **tidak** bisa diubah lewat route ini); `GET /api/settings/:section` → `{ value, version, updatedBy }`; `PUT /api/settings/:section` body `{ value, version }` → 200 `{ version }` | 422 `INVALID_SETTINGS` dengan `error.fields: Array<{ path: string; message: string }>` dari issue Zod | 409 `STALE_SETTINGS` | 404 section tak dikenal; setelah commit `notify({ type: "settings_changed", section })`. Api & worker memanggil `insertSettingIfMissing(db, "time_policy", DEFAULT_TIME_POLICY)` saat start. Tambah ke `ADMIN_ROUTES`.

- [ ] **Step 1: Write the failing tests**: PUT jadwal tumpang tindih → 422 dengan `fields[0].path` menunjuk jadwalnya; PUT versi lama → 409; PUT sukses → versi naik + satu audit; `PUT /api/settings/bot_state` → 404; `agent` → 403.
- [ ] **Step 2–4:** FAIL → implementasi → PASS.
- [ ] **Step 5:** Commit `feat(api): generic settings endpoint with optimistic locking (A-3.4)`.

### Task G5.4: Halaman Jam kerja & hari libur (B-3.10)

**Files:**
- Create: `apps/desk/src/routes/_auth/pengaturan.jam-kerja.tsx`, `apps/desk/src/components/schedule-editor.tsx`
- Modify: `apps/desk/src/copy/index.ts`, `apps/desk/src/routes/_auth.tsx` (menu Pengaturan → hanya admin)
- Test: `apps/desk/tests/jam-kerja.test.tsx`

**Interfaces:**
- Consumes: `GET/PUT /api/settings/time_policy`, `TimePolicyConfig` (validasi form via `zodResolver`), `lib/time.ts`.
- Produces: form jadwal mingguan, hari libur (tanggal & rentang), pesan di luar jam kerja; tombol Simpan per halaman.

- [ ] **Step 1: Write the failing tests**: respons 422 dengan `fields` → pesan muncul di field yang sesuai; 409 → `copy.errors.STALE_SETTINGS` ("Pengaturan ini sudah diubah orang lain. Muat ulang untuk melihat versi terbaru."); form awal terisi `DEFAULT_TIME_POLICY`.
- [ ] **Step 2–4:** FAIL → implementasi → PASS; test pemindai `copy/` tetap hijau.
- [ ] **Step 5:** Commit `feat(desk): business hours settings page (B-3.10)`.

---

## Verifikasi akhir Fase A (spec §13)

- [ ] `bun test`, `bun run lint`, `bun run typecheck` hijau di `development` setelah kelima PR.
- [ ] Race A-3.3: `for i in $(seq 50); do bun test packages/worker/tests/handoff-race.test.ts || exit 1; done` → 50 lulus.
- [ ] `ADMIN_ROUTES` di `roles.test.ts` memuat setiap route admin: bot (3), audit, canned (3), settings (1).
- [ ] Jeda bot: test G3.2 (dispatcher) dan G3.3 (job sudah diambil) hijau, `FakeLlm` 0 panggilan.
- [ ] Instalasi dengan Telegram di env → `GET /api/bot/state` = `active` setelah upgrade.
- [ ] Manual di `localhost:8080`: DoD Sprint 3 + jeda/aktifkan + ubah jam kerja oleh Supervisor; Agent CS tidak melihat Beranda/Template/Pengaturan.
