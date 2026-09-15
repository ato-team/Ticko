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
