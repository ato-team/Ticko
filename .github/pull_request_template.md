## Tugas
Backlog: <A-x.y / B-x.y>

## Selesai bila
<salin checklist dari Backlog>

## Checklist reviewer
- [ ] Seluruh "Selesai bila" benar-benar terpenuhi, bukan hanya diklaim
- [ ] ▲ Tidak ada `any`, `as` paksa, `!`, atau `@ts-ignore` di luar pengecualian
- [ ] ▲ Setiap `switch` atas union ditutup `assertNever`, tanpa `default` yang mengembalikan nilai
- [ ] ▲ Setiap `await` jaringan punya timeout
- [ ] ▲ Tidak ada `setTimeout`/`setInterval` di luar `worker/src/poller.ts`
- [ ] ▲ Data luar divalidasi Zod, bukan di-`as`
- [ ] Transaksi ditutup di jalur error, bukan hanya jalur sukses
- [ ] Tidak ada string concat untuk SQL
- [ ] Tidak ada kredensial / data pribadi yang bisa masuk log
- [ ] Test ada untuk jalur utama + minimal satu jalur error
- [ ] Tidak menyentuh file milik orang lain tanpa kesepakatan
- [ ] Interface baru dirilis bersama test double-nya di PR ini

## Konteks baru
- [ ] Tidak ada konteks baru di PR ini, **atau**
- [ ] Sudah mendarat di vault — note: `<nama note>`, bagian: `<heading>`
