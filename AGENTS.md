# Ticko — Instruksi Agent

## Identitas

Sistem customer service berbasis AI agent. Pembedanya: **handoff ke manusia yang
benar-benar memutus jalur bot secara arsitektur**, bukan lewat permintaan di prompt.

## Dua sumber kebenaran

| Pertanyaan | Dijawab oleh |
|---|---|
| **Kenapa** begini — keputusan, alasan, risiko, backlog | Vault Obsidian: `Projects/Ticko/` |
| **Bagaimana sekarang** — kode, skema, kontrak yang berjalan | Repo ini |

Path vault lokal Dev A: `~/Documents/Projects-Notes/Obsidian Vault/Projects/Ticko/`.
Mesin lain: sesuaikan di `CLAUDE.local.md` (tidak masuk repo).

Kalau keduanya berbeda, **repo yang menang** dan note vault wajib diperbarui di
turn yang sama.

Urutan baca vault: `Ticko Instructions` → `Ticko Project Context` (hub) → `Ticko PRD` →
`Ticko Backlog` → `Ticko Conventions`. Empat dokumen inti ±226 KB — baca frontmatter
dan heading dulu, jangan pernah baca utuh tanpa alasan.

## Guardrail yang tidak dinegosiasikan

Kalau sebuah usulan melanggar salah satu ini, **tolak usulannya** dan jangan
menawarkan versi "lebih sederhana" — kesederhanaan bukan alasan yang cukup di sini.

1. **Kontrol sesi hidup di luar AI.** `control_owner` diperiksa di dispatcher,
   sebelum LLM dipanggil. Bukan di dalam prompt.
2. **Handoff Integrity = nol mutlak.** Sprint 3 tidak dipercepat, test-nya tidak
   dilewati.
3. **Tidak ada scheduler in-memory.** `setTimeout` / `setInterval` dilarang di
   seluruh workspace kecuali `packages/worker/src/poller.ts`. Timer hidup di tabel
   `jobs` dan kondisinya diverifikasi ulang saat menyala.
4. **Semua timestamp UTC.** Konversi zona hanya di evaluasi policy dan tampilan.
5. **Tanpa framework agent** (Vercel AI SDK `maxSteps`, LangChain, Mastra) dan
   tanpa `telegraf`/`grammy`. Loop tool-calling adalah produk intinya.
6. **Tanpa BullMQ / node-cron / Prisma / neverthrow / moment.**
7. **Bot lebih baik terlalu sering eskalasi daripada mengarang.**
8. Kalau waktu mundur: potong P1/P2, bukan P0.

Aturan menulis kode selengkapnya di `CONVENTIONS.md`. Poin bertanda ▲ di sana
adalah aturan yang **tidak ada compiler-nya** — periksa manual setiap review.

## Prioritas instruksi

Kalau skill atau tool apa pun (termasuk Ponytail) menyarankan sesuatu yang
melanggar guardrail di atas, **guardrail menang**. Empat keputusan berikut sudah
ditimbang dan ditolak dengan alasan tertulis di PRD — jangan diusulkan ulang tanpa
alasan baru: job queue eksternal, framework agent, pustaka bot Telegram, dan
melonggarkan CHECK constraint / branded type.

Ponytail dipakai untuk memangkas abstraksi yang tidak perlu **di dalam** batas itu:
helper yang cuma dipanggil sekali, wrapper tanpa isi, generic yang tidak dipakai,
konfigurasi untuk hal yang tidak pernah berubah.

## Batas kepemilikan

Dev A = `@rizaldiabyannata`, Dev B = `@yawpie` (juga di `.github/CODEOWNERS`). Jangan menyentuh
file milik orang lain tanpa kesepakatan tertulis di issue/PR.

| Path | Pemilik |
|---|---|
| `packages/domain/src/{state.ts,conversation.ts,time/}` | Dev A |
| `packages/domain/src/{channel.ts,event.ts}` | Dev B |
| `packages/domain/src/{message.ts,ids.ts}` | **Bersama** — butuh approval keduanya |
| `packages/{storage,agent,worker}/` | Dev A |
| `packages/{channels,api,rag}/`, `apps/desk/` | Dev B |
| `packages/storage/migrations/` | **Dev A saja.** Dev B mengajukan lewat issue template "Perubahan skema" |

## Prosedur wajib

### Sebelum mulai bekerja

1. Baca hub note vault (`Ticko Project Context`) — bagian `## Keputusan`
   dan `## Aturan & guardrail`. Shortcut: `/konteks <id-tugas>`.
2. Baca entri Backlog untuk tugas yang dikerjakan, termasuk blok "Selesai bila".
3. Kalau tugas menyentuh interface baru: test double-nya **wajib ikut di PR yang
   sama**, bukan menyusul.

### Sesudah bekerja — konteks baru wajib mendarat di vault

Shortcut: `/catat`, `/keputusan <isi>`.

Konteks baru yang **wajib** ditulis sebelum sesi berakhir:

- keputusan teknis/produk beserta alasannya
- asumsi yang terkonfirmasi atau terbantah
- risiko baru atau yang berubah status
- perubahan stack, kontrak antar-peran, skema DB, atau estimasi
- hasil riset/spike/perbandingan opsi
- kejadian nyata saat eksekusi: hasil sprint, kelas bug baru, jam aktual vs estimasi

Yang **bukan** konteks baru: obrolan tanpa kesimpulan, hal yang kedaluwarsa sendiri
(nama branch, port lokal), pengulangan isi dokumen lain.

Tujuan penulisan:

| Jenis | Tujuan |
|---|---|
| Keputusan + alasan | Tabel `## Keputusan` di hub note (tanggal, keputusan, alasan) |
| Aturan/guardrail stabil | `## Aturan & guardrail` di hub note |
| Asumsi terkonfirmasi/terbantah | Centang `## Belum terjawab` di hub + PRD §8.1 |
| Risiko baru/berubah | PRD §8.2, lalu `## Risiko terbuka` di hub bila perlu dipantau |
| Perubahan FR/KPI/arsitektur | PRD, naikkan nomor versi dokumen |
| Perubahan tugas/estimasi/kontrak | Backlog |
| Aturan menulis kode | `CONVENTIONS.md` di repo **dan** note Conventions di vault |
| Riset, spike, catatan sprint | Note baru + daftarkan di `## Peta catatan` |

Prosedur: cek dulu apakah sudah ada note/bagian yang membahasnya (update > note
baru) → pakai frontmatter standar → tautkan dengan `[[wikilink]]`, jangan menyalin
isi → perbarui `updated:` di setiap note yang disentuh → daftarkan note baru di
`## Peta catatan` → lapor singkat file apa yang berubah.

**Kalau vault tidak terjangkau: katakan terus terang, tulis draft di chat, jangan
mengaku sudah menyimpan.**

### Frontmatter standar note vault

```yaml
title: Ticko <Nama>
date: <tanggal dibuat, tidak diubah>
updated: <wajib diperbarui setiap edit>
tags: [project/ticko, type/<context|requirement|plan|convention|instruction|decision|research|log|spec>]
status: draft | active | done | archived
related: ["[[Ticko Project Context]]"]
aliases: [<nama pendek>]
```

## Git

- Branch: `{dev}/{id-tugas}-{deskripsi}` — contoh `a/3.1-handoff-transaksional`
- Commit: conventional commits, bahasa Inggris, satu commit satu perubahan logis
- PR: satu PR satu tugas backlog, judul `[A-3.1] Handoff transaksional`,
  deskripsi menyalin checklist "Selesai bila" dari Backlog
- PR > 400 baris dipecah kecuali memang tidak bisa
- Batas waktu review: 1 hari kerja

## Bahasa

Bahasa Indonesia untuk diskusi, dokumen, dan pesan error yang dilihat pengguna.
Istilah teknis dibiarkan Inggris (`control_owner`, handoff, job queue). Commit
message bahasa Inggris.

## Jangan mengarang angka

Per 2026-09-13: belum ada perusahaan pengguna yang dikonfirmasi, semua dokumen
masih draft. **Semua KPI dan estimasi adalah rencana, bukan hasil pengukuran.**
Jangan pernah menulis angka seolah-olah terukur.
