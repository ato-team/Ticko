import { timingSafeEqual } from "node:crypto";
import { parseUpdate } from "@ticko/channels";
import type { InboundMessage, Secret } from "@ticko/domain";
import { Hono } from "hono";
import type { Env } from "./app";

export interface WebhookDeps {
	telegramSecret: Secret;
	/** Menyimpan pesan dan menjadwalkan job dalam satu transaksi. */
	receive: (msg: InboundMessage, traceId: string) => Promise<unknown>;
}

function sameSecret(given: string, expected: Secret): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(expected.reveal());
	return a.length === b.length && timingSafeEqual(a, b);
}

export function webhookRoutes(deps: WebhookDeps): Hono<Env> {
	const app = new Hono<Env>();

	app.post("/telegram/:secret", async (c) => {
		// 404, bukan 401: jangan beri tahu bahwa endpoint ini ada.
		if (!sameSecret(c.req.param("secret"), deps.telegramSecret)) {
			return c.notFound();
		}
		const log = c.get("log");
		const body: unknown = await c.req.json().catch(() => null);
		const parsed = parseUpdate(body);
		if (!parsed.ok) {
			// Tetap 200: balasan 5xx membuat Telegram retry payload yang sama
			// terus-menerus. Tabel dead_letter menyusul di B-1.3.
			log.warn({ zod_error: parsed.error }, "payload telegram gagal diparse");
			return c.body(null, 200);
		}
		if (!parsed.message) return c.body(null, 200);

		// Pesan dan job disimpan sebelum 200 dikirim, dalam satu transaksi.
		// Tidak ada pekerjaan yang berjalan setelah respons. Kalau database
		// gagal, 500 membuat Telegram mengirim ulang: pesan tidak hilang.
		const result = await deps.receive(parsed.message, c.get("traceId"));
		log.info({ result }, "pesan telegram diterima");
		return c.body(null, 200);
	});

	return app;
}
