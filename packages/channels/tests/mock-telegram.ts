import { Hono } from "hono";

// Server Hono kecil yang memalsukan Bot API Telegram lewat HTTP sungguhan
// (loopback, port 0), supaya test adapter tidak bergantung pada jaringan
// nyata (B-1.6). Dipakai ulang untuk memalsukan Meta Cloud API di Sprint 5.

export type MockResponse =
	| { kind: "ok"; result: unknown }
	| {
			kind: "error";
			status: number;
			body: { error_code: number; description: string; retryAfter?: number };
	  }
	// Tidak pernah membalas: dipakai untuk menguji AbortSignal.timeout().
	| { kind: "hang" };

export interface MockTelegramServer {
	url: string;
	/** Atur respons Bot API untuk method tertentu (mis. "sendMessage"). */
	respond: (method: string, r: MockResponse) => void;
	calls: { method: string; body: unknown }[];
	stop: () => void;
}

export function startMockTelegram(): MockTelegramServer {
	const responses = new Map<string, MockResponse>();
	const calls: { method: string; body: unknown }[] = [];

	const app = new Hono();
	app.post("/bot:token/:method", async (c) => {
		const method = c.req.param("method");
		calls.push({ method, body: await c.req.json().catch(() => null) });

		const r = responses.get(method) ?? { kind: "ok", result: {} };
		if (r.kind === "hang") {
			// Tidak pernah membalas sendiri — selesai hanya kalau klien membatalkan
			// (AbortSignal.timeout di adapter). Tanpa ini, stop() server menunggu
			// handler ini selamanya.
			return new Promise<Response>((_resolve, reject) => {
				c.req.raw.signal.addEventListener("abort", () =>
					reject(new Error("client membatalkan request")),
				);
			});
		}
		if (r.kind === "error") {
			const { error_code, description, retryAfter } = r.body;
			return new Response(
				JSON.stringify({
					ok: false,
					error_code,
					description,
					...(retryAfter !== undefined
						? { parameters: { retry_after: retryAfter } }
						: {}),
				}),
				{ status: r.status, headers: { "content-type": "application/json" } },
			);
		}
		return c.json({ ok: true, result: r.result });
	});

	const server = Bun.serve({ port: 0, fetch: app.fetch });
	return {
		url: `http://127.0.0.1:${server.port}`,
		respond: (method, r) => responses.set(method, r),
		calls,
		stop: () => server.stop(true),
	};
}
