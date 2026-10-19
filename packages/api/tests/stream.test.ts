import { afterAll, expect, test } from "bun:test";
import { ConversationId, type DeskEvent, Secret, UserId } from "@ticko/domain";
import { createLogger } from "@ticko/storage/log";
import {
	connectRedis,
	createDeskSubscriber,
	type DeskListener,
	publishDeskEvent,
} from "@ticko/storage/redis";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { hashPassword } from "../src/lib/password";
import { deskStream } from "../src/stream";
import { noConversations } from "./support";

const log = createLogger("error");
const url = new Secret(process.env.TICKO_REDIS_URL ?? "redis://127.0.0.1:6379");
const subscriber = createDeskSubscriber(url, log);
const publisher = connectRedis(url);
afterAll(async () => {
	await subscriber.close();
	publisher.disconnect();
});

// Membungkus subscriber sungguhan supaya test bisa melihat listener yang aktif.
const active = new Set<DeskListener>();
const desk = {
	listen(l: DeskListener) {
		active.add(l);
		const stop = subscriber.listen(l);
		return () => {
			active.delete(l);
			stop();
		};
	},
};

const user = {
	id: UserId.parse("5d2c1f0e-8a7b-4c3d-9e1f-2a3b4c5d6e7f"),
	email: "agent@ticko.test",
	displayName: "Agent",
	role: "agent" as const,
};
const passwordHash = await hashPassword("rahasia123");
const app = createApp({
	log,
	checkDatabase: async () => ({ ok: true }),
	checkRedis: async () => ({ ok: true }),
	webhooks: null,
	auth: {
		sessionSecret: new Secret("test-secret"),
		findUserByEmail: async () => ({ ...user, passwordHash }),
		createSession: async () => ({ token: "tok", expiresAt: new Date() }),
		findSessionUser: async (token) => (token === "tok" ? user : null),
		deleteSession: async () => {},
	},
	conversations: noConversations,
	desk,
});

async function cookie() {
	const res = await app.request("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: user.email, password: "rahasia123" }),
	});
	return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	needle: string,
) {
	let text = "";
	const decoder = new TextDecoder();
	while (!text.includes(needle)) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value);
	}
	return text;
}

async function waitFor(check: () => boolean) {
	for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
}

test("tanpa session → 401", async () => {
	const res = await app.request("/api/stream");
	expect(res.status).toBe(401);
});

test("event dari proses lain sampai ke SSE < 3 detik; tab ditutup melepas listener", async () => {
	const res = await app.request("/api/stream", {
		headers: { cookie: await cookie() },
	});
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/event-stream");
	const reader = res.body?.getReader();
	if (!reader) throw new Error("tanpa body");
	await waitFor(() => active.size === 1);

	const event: DeskEvent = {
		type: "sla_breached",
		conversationId: ConversationId.parse(
			"0b8e7a52-4c1f-4d2e-9a6b-3f5c8d7e1a20",
		),
	};
	const started = performance.now();
	await publishDeskEvent(publisher, event, log);
	const text = await readUntil(reader, "sla_breached");
	expect(performance.now() - started).toBeLessThan(3000);
	expect(text).toContain(`data: ${JSON.stringify(event)}`);

	await reader.cancel();
	await waitFor(() => active.size === 0);
	expect(active.size).toBe(0);
});

test("heartbeat berupa komentar SSE", async () => {
	const fake = { listen: () => () => {} };
	const mini = new Hono().get("/", deskStream(fake, 20));
	const reader = (await mini.request("/")).body?.getReader();
	if (!reader) throw new Error("tanpa body");
	expect(await readUntil(reader, ": ping")).toContain(": ping\n\n");
	await reader.cancel();
});
