import { expect, test } from "bun:test";
import { type InboundMessage, Secret } from "@ticko/domain";
import { createLogger } from "@ticko/storage/log";
import { createApp } from "../src/app";

function app(receive: (m: InboundMessage) => Promise<unknown>) {
	return createApp({
		log: createLogger("error"),
		checkDatabase: async () => ({ ok: true }),
		checkRedis: async () => ({ ok: true }),
		webhooks: { telegramSecret: new Secret("rahasia-webhook"), receive },
	});
}

const post = (a: ReturnType<typeof app>, secret: string, body: unknown) =>
	a.request(`/webhook/telegram/${secret}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

const update = {
	update_id: 1,
	message: {
		message_id: 5,
		date: 1789322400,
		chat: { id: 42 },
		from: { id: 42, first_name: "Budi" },
		text: "halo",
	},
};

test("secret salah → 404, pesan tidak diproses", async () => {
	const got: InboundMessage[] = [];
	const res = await post(
		app(async (m) => got.push(m)),
		"tebakan",
		update,
	);
	expect(res.status).toBe(404);
	expect(got).toHaveLength(0);
});

test("pesan valid → receive dipanggil lalu 200", async () => {
	const got: InboundMessage[] = [];
	const res = await post(
		app(async (m) => got.push(m)),
		"rahasia-webhook",
		update,
	);
	expect(res.status).toBe(200);
	expect(got.map((m) => [m.externalMessageId, m.content.text])).toEqual([
		["42:5", "halo"],
	]);
});

test("payload rusak → tetap 200, tidak diproses", async () => {
	const got: InboundMessage[] = [];
	const a = app(async (m) => got.push(m));
	expect((await post(a, "rahasia-webhook", "{bukan json")).status).toBe(200);
	expect((await post(a, "rahasia-webhook", { update_id: "x" })).status).toBe(
		200,
	);
	expect(got).toHaveLength(0);
});

test("database gagal → 500 supaya Telegram mengirim ulang", async () => {
	const res = await post(
		app(async () => {
			throw new Error("db mati");
		}),
		"rahasia-webhook",
		update,
	);
	expect(res.status).toBe(500);
});
