import { expect, test } from "bun:test";
import { Secret } from "@ticko/domain";
import { createLogger } from "@ticko/storage/log";
import { createApp } from "../src/app";
import type { AuthDeps } from "../src/auth";

// Test di file ini tidak pernah memanggil /auth atau /me.
const fakeAuth: AuthDeps = {
	sessionSecret: new Secret("test-secret"),
	findUserByEmail: async () => null,
	createSession: async () => {
		throw new Error("tidak dipakai di test ini");
	},
	findSessionUser: async () => null,
	deleteSession: async () => {},
};

function capture() {
	const lines: Record<string, unknown>[] = [];
	const log = createLogger("info", {
		write: (s: string) => {
			lines.push(JSON.parse(s));
		},
	});
	return { log, lines };
}

const up = async () => ({ ok: true });
const down = async () => ({ ok: false });

test("GET /health 200 dengan status database dan redis", async () => {
	const { log } = capture();
	const app = createApp({
		log,
		checkDatabase: up,
		checkRedis: up,
		webhooks: null,
		auth: fakeAuth,
	});
	const res = await app.request("/health");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		status: "ok",
		database: "ok",
		redis: "ok",
	});
});

test("GET /health 503 saat salah satu dependensi mati", async () => {
	const { log } = capture();
	const app = createApp({
		log,
		checkDatabase: down,
		checkRedis: up,
		webhooks: null,
		auth: fakeAuth,
	});
	const res = await app.request("/health");
	expect(res.status).toBe(503);
	expect(await res.json()).toMatchObject({ database: "down", redis: "ok" });
});

test("log request berupa JSON dengan trace_id", async () => {
	const { log, lines } = capture();
	const app = createApp({
		log,
		checkDatabase: up,
		checkRedis: up,
		webhooks: null,
		auth: fakeAuth,
	});
	await app.request("/health");
	await app.request("/health");
	expect(lines).toHaveLength(2);
	const [a, b] = lines;
	expect(typeof a?.trace_id).toBe("string");
	expect(a?.trace_id).not.toBe(b?.trace_id);
	expect(a).toMatchObject({ level: "info", path: "/health", status: 200 });
});

test("field kredensial di-redact", () => {
	const { log, lines } = capture();
	log.info({ apiKey: "sk-bocor", telegram: { botToken: "123:abc" } }, "x");
	expect(JSON.stringify(lines)).not.toContain("sk-bocor");
	expect(JSON.stringify(lines)).not.toContain("123:abc");
});
