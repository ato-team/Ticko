import type { User } from "@ticko/storage";
import type { Logger } from "@ticko/storage/log";
import { Hono } from "hono";
import { type AuthDeps, authRoutes, requireAuth } from "./auth";
import { type WebhookDeps, webhookRoutes } from "./webhook";

// `user` hanya diisi oleh requireAuth; route di belakangnya boleh menganggap
// c.get("user") sudah ada (idiom Hono), route lain tidak pernah membacanya.
export type Env = {
	Variables: { log: Logger; traceId: string; user: User };
};

export interface AppDeps {
	log: Logger;
	checkDatabase: () => Promise<{ ok: boolean }>;
	checkRedis: () => Promise<{ ok: boolean }>;
	/** null bila channel Telegram tidak diaktifkan. */
	webhooks: WebhookDeps | null;
	auth: AuthDeps;
}

export function createApp(deps: AppDeps): Hono<Env> {
	const app = new Hono<Env>();

	// Setiap log dalam satu request membawa trace_id yang sama (AC-10.1); nanti
	// ikut disimpan di payload job.
	app.use(async (c, next) => {
		const traceId = crypto.randomUUID();
		const log = deps.log.child({ trace_id: traceId });
		c.set("traceId", traceId);
		c.set("log", log);
		const started = performance.now();
		await next();
		log.info(
			{
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				duration_ms: Math.round(performance.now() - started),
			},
			"request",
		);
	});

	app.get("/health", async (c) => {
		const [db, redis] = await Promise.all([
			deps.checkDatabase(),
			deps.checkRedis(),
		]);
		const healthy = db.ok && redis.ok;
		return c.json(
			{
				status: healthy ? "ok" : "degraded",
				database: db.ok ? "ok" : "down",
				redis: redis.ok ? "ok" : "down",
			},
			healthy ? 200 : 503,
		);
	});

	// Detail error internal tidak pernah dikirim ke klien (CONVENTIONS §3).
	app.onError((err, c) => {
		(c.get("log") ?? deps.log).error({ err }, "request gagal");
		return c.json(
			{ error: { code: "INTERNAL", message: "Terjadi kesalahan" } },
			500,
		);
	});

	if (deps.webhooks) app.route("/webhook", webhookRoutes(deps.webhooks));
	app.route("/auth", authRoutes(deps.auth));
	app.get("/me", requireAuth(deps.auth), (c) => c.json(c.get("user")));

	return app;
}
