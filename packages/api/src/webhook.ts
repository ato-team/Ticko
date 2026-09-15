import { timingSafeEqual } from "node:crypto";
import { parseUpdate } from "@ticko/channels";
import type { Channel, InboundMessage, Secret } from "@ticko/domain";
import { Hono } from "hono";
import type { Env } from "./app";

export interface WebhookDeps {
	telegramSecret: Secret;
	/** Menyimpan pesan dan menjadwalkan job dalam satu transaksi. */
	receive: (msg: InboundMessage, traceId: string) => Promise<unknown>;
	/** Payload gagal diparse (AC-1.7). Kegagalan di sini boleh melempar 500 — Telegram retry, tidak ada data hilang. */
	deadLetter: (input: {
		channel: Channel;
		payload: string;
		error: string;
	}) => Promise<void>;
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
		// Body mentah dibaca dulu (bukan c.req.json()) supaya body yang bukan
		// JSON valid pun tetap tersimpan utuh di dead_letter.
		const raw = await c.req.text();
		let body: unknown;
		try {
			body = raw ? JSON.parse(raw) : null;
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			log.warn({ error }, "payload telegram bukan JSON valid");
			await deps.deadLetter({ channel: "telegram", payload: raw, error });
			return c.body(null, 200);
		}
		const parsed = parseUpdate(body);
		if (!parsed.ok) {
			// Tetap 200: balasan 5xx membuat Telegram retry payload yang sama
			// terus-menerus.
			log.warn({ zod_error: parsed.error }, "payload telegram gagal diparse");
			await deps.deadLetter({
				channel: "telegram",
				payload: raw,
				error: parsed.error,
			});
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
