import { DESK_EVENTS_CHANNEL, DeskEvent, type Secret } from "@ticko/domain";
import Redis from "ioredis";
import type { Logger } from "./log";

export function connectRedis(url: Secret): Redis {
	return new Redis(url.reveal(), {
		lazyConnect: true,
		connectTimeout: 3000,
		commandTimeout: 3000,
		maxRetriesPerRequest: 1,
	});
}

export type RedisPingResult =
	| { ok: true }
	| { ok: false; error: { kind: "unreachable"; message: string } };

export async function pingRedis(redis: Redis): Promise<RedisPingResult> {
	try {
		await redis.ping();
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: {
				kind: "unreachable",
				message: e instanceof Error ? e.message : String(e),
			},
		};
	}
}

// --- Pub/sub desk (B-2.3, Kontrak 4) --------------------------------------------

/**
 * Menerbitkan satu event ke `desk:events`, dipanggil SETELAH transaksi commit
 * (CONVENTIONS §4). Tidak pernah melempar: event desk hanya pemicu refresh,
 * sumber kebenaran tetap database — Redis mati cukup jadi warning.
 */
export async function publishDeskEvent(
	redis: Redis,
	event: DeskEvent,
	log: Logger,
): Promise<void> {
	try {
		await redis.publish(
			DESK_EVENTS_CHANNEL,
			JSON.stringify(DeskEvent.parse(event)),
		);
	} catch (err) {
		log.warn(
			{
				err: err instanceof Error ? err.message : String(err),
				event: event.type,
			},
			"gagal menerbitkan event desk",
		);
	}
}

export type DeskListener = (event: DeskEvent) => void;

export interface DeskSubscriber {
	/** Mengembalikan fungsi untuk berhenti mendengar (dipanggil saat SSE ditutup). */
	listen(listener: DeskListener): () => void;
	close(): Promise<void>;
}

/**
 * Satu koneksi langganan per proses, disebar ke banyak listener (satu per
 * tab SSE). Tab yang ditutup cukup melepas listener-nya, tidak ada langganan
 * Redis yang menggantung. Pesan yang tidak lolos Zod dibuang dengan warning.
 * Redis putus → warning; ioredis menyambung dan berlangganan ulang sendiri.
 */
export function createDeskSubscriber(url: Secret, log: Logger): DeskSubscriber {
	const sub = new Redis(url.reveal(), { connectTimeout: 3000 });
	const listeners = new Set<DeskListener>();
	sub.on("error", (err) =>
		log.warn({ err: err.message }, "koneksi redis desk:events bermasalah"),
	);
	sub.on("message", (_channel, raw) => {
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			json = undefined;
		}
		const parsed = DeskEvent.safeParse(json);
		if (!parsed.success) {
			log.warn({ raw: raw.slice(0, 500) }, "event desk tidak valid, dibuang");
			return;
		}
		for (const l of listeners) l(parsed.data);
	});
	// Tidak di-await: Redis mati saat start tidak boleh menahan api. Perintah
	// ini antre di ioredis dan berjalan begitu koneksi tersambung.
	sub
		.subscribe(DESK_EVENTS_CHANNEL)
		.catch((err: Error) =>
			log.warn({ err: err.message }, "gagal berlangganan desk:events"),
		);
	return {
		listen(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async close() {
			listeners.clear();
			await sub.quit();
		},
	};
}
