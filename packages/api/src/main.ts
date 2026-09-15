import { ConfigError, loadAppConfig, loadChannelsConfig } from "@ticko/domain";
import { close, connect, insertDeadLetter, ping } from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { connectRedis, pingRedis } from "@ticko/storage/redis";
import { receiveInbound } from "@ticko/worker";
import { createApp } from "./app";

// Fail fast: config tidak valid mematikan proses sebelum request pertama.
const [config, channels] = await Promise.all([
	loadAppConfig(),
	loadChannelsConfig(),
]).catch((e: unknown) => {
	if (e instanceof ConfigError) {
		console.error(e.message);
		process.exit(1);
	}
	throw e;
});

const log = createLogger(config.logging.level);
// Secret me-redact dirinya sendiri, jadi ringkasan aman di-log utuh (AC-9.4).
log.info({ config: { app: config, channels } }, "api start");

const db = connect(config.database);
const redis = connectRedis(config.redis.url);

const app = createApp({
	log,
	checkDatabase: async () => {
		const r = await ping(db);
		if (!r.ok) log.error({ error: r.error }, "database tidak sehat");
		return r;
	},
	checkRedis: async () => {
		const r = await pingRedis(redis);
		if (!r.ok) log.error({ error: r.error }, "redis tidak sehat");
		return r;
	},
	webhooks: channels.telegram
		? {
				telegramSecret: channels.telegram.webhookSecret,
				receive: (msg, traceId) => receiveInbound(db, msg, traceId),
				deadLetter: (input) => insertDeadLetter(db, input),
			}
		: null,
});

const server = Bun.serve({ port: config.server.port, fetch: app.fetch });
log.info({ port: server.port }, "api mendengarkan");

process.once("SIGTERM", async () => {
	log.info("SIGTERM diterima, menutup koneksi");
	// Selesaikan request yang sedang berjalan, tolak yang baru.
	await server.stop();
	await Promise.allSettled([close(db), redis.quit()]);
	log.info("api berhenti");
	process.exit(0);
});
