import type { DeskSubscriber } from "@ticko/storage/redis";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import type { Env } from "./app";

// GET /api/stream (B-2.4): DeskEvent dari Redis `desk:events` → SSE. SSE, bukan
// WebSocket: arah datanya satu, balasan agent cukup lewat POST biasa.

/** Komentar SSE berkala supaya proxy tidak memutus koneksi yang diam. */
export const HEARTBEAT_MS = 30_000;

export function deskStream(
	desk: Pick<DeskSubscriber, "listen">,
	heartbeatMs = HEARTBEAT_MS,
): Handler<Env> {
	return (c) =>
		streamSSE(c, async (stream) => {
			const stop = desk.listen((event) => {
				stream.writeSSE({ data: JSON.stringify(event) }).catch(() => stop());
			});
			// Tab ditutup → listener lepas saat itu juga, bukan setelah tidur berikutnya.
			stream.onAbort(stop);
			try {
				// stream.sleep bawaan Hono, bukan setInterval sendiri (guardrail #3,
				// keputusan 2026-09-17).
				while (!stream.aborted && !stream.closed) {
					await stream.sleep(heartbeatMs);
					if (!stream.aborted) await stream.write(": ping\n\n");
				}
			} finally {
				stop();
			}
		});
}
