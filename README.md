# Ticko

Sistem customer service berbasis AI agent dengan handoff ke manusia yang
ditegakkan di level arsitektur, bukan di level prompt.

- Runtime: Bun 1.4.x (dipatok) + TypeScript strict
- Konteks, alasan keputusan, dan backlog: vault Obsidian, lihat `AGENTS.md`
- Aturan menulis kode: `CONVENTIONS.md`

## Setup dari nol

```
bun install
cp config/app.example.toml config/app.toml   # ulangi untuk 5 file config
docker compose up -d
bun run typecheck && bun test
```
