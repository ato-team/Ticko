# Ticko

Sistem customer service berbasis AI agent dengan handoff ke manusia yang
ditegakkan di level arsitektur, bukan di level prompt.

- Runtime: Bun 1.4.x (dipatok) + TypeScript strict
- Konteks, alasan keputusan, dan backlog: vault Obsidian, lihat `AGENTS.md`
- Aturan menulis kode: `CONVENTIONS.md`

## Setup dari nol

Prasyarat: Bun 1.4.x, Docker dengan Compose v2.

```
bun install
cp config/app.example.toml config/app.toml   # ulangi untuk 5 file config
docker compose up -d --wait                  # PostgreSQL 16 + pgvector, Redis 7
bun run typecheck && bun test
```

Cek pgvector aktif:

```
docker compose exec postgres psql -U ticko -d ticko \
  -c "SELECT extversion FROM pg_extension WHERE extname='vector'"
```

Koneksi lokal: `postgres://ticko:ticko@127.0.0.1:5432/ticko` dan
`redis://127.0.0.1:6379`. Kalau port sudah dipakai, ganti lewat env saat
menyalakan, misalnya `TICKO_REDIS_PORT=6380 docker compose up -d --wait`.

Data tersimpan di volume `ticko_pgdata` dan `ticko_redisdata`, jadi tetap ada
setelah restart. `init.sql` hanya berjalan saat volume masih kosong; untuk mulai
dari database kosong: `docker compose down -v`.

## Dari nol sampai bot Telegram membalas

1. **Buat bot** lewat [@BotFather](https://t.me/BotFather) di Telegram: `/newbot`,
   catat token yang diberikan.
2. **Isi kredensial** di `.env` (`cp .env.example .env` bila belum ada):
   ```
   TICKO_TELEGRAM_BOT_TOKEN=<token dari BotFather>
   TICKO_TELEGRAM_WEBHOOK_SECRET=<string acak, mis. `openssl rand -hex 24`>
   TICKO_LLM_API_KEY=<API key penyedia LLM>
   ```
3. **Aktifkan channel** di `config/channels.toml`: `[telegram] enabled = true`.
   Salin juga `config/agent.example.toml` ke `config/agent.toml` (provider dan
   model default: Anthropic + `claude-opus-5`; ganti bila memakai penyedia lain).
4. **Nyalakan database, migrasi, lalu server**:
   ```
   docker compose up -d --wait
   bun run db:migrate
   bun run api      # terminal 1 — webhook & health check
   bun run worker   # terminal 2 — job queue & balasan agent LLM
   ```
5. **Buka tunnel** ke `api` (default port 3000) supaya Telegram bisa menjangkau
   localhost — pilih salah satu:
   ```
   cloudflared tunnel --url http://localhost:3000
   # atau: ngrok http 3000
   ```
   Catat URL publik yang diberikan (mis. `https://acak.trycloudflare.com`).
6. **Daftarkan webhook**:
   ```
   bun run webhook:setup https://acak.trycloudflare.com
   ```
7. Kirim "halo" ke bot di Telegram — balasannya dari agent LLM. Payload yang
   gagal diparse (bukan dari Telegram, atau bentuknya rusak) tersimpan di
   tabel `dead_letter` untuk diperiksa manual, bukan membuat webhook gagal.
