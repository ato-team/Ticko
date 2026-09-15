import { expect, test } from "bun:test";
import { type Channel, type InboundMessage, Secret } from "@ticko/domain";
import { createLogger } from "@ticko/storage/log";
import { createApp } from "../src/app";

type DeadLetter = { channel: Channel; payload: string; error: string };

function app(
	receive: (m: InboundMessage) => Promise<unknown>,
	deadLetter: (d: DeadLetter) => Promise<void> = async () => {},
) {
	return createApp({
		log: createLogger("error"),
		checkDatabase: async () => ({ ok: true }),
		checkRedis: async () => ({ ok: true }),
		webhooks: {
			telegramSecret: new Secret("rahasia-webhook"),
			receive,
			deadLetter,
		},
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

test("payload rusak → tetap 200, tidak diproses, masuk dead_letter (AC-1.7)", async () => {
	const got: InboundMessage[] = [];
	const deadLetters: DeadLetter[] = [];
	const a = app(
		async (m) => got.push(m),
		async (d) => {
			deadLetters.push(d);
		},
	);
	expect((await post(a, "rahasia-webhook", "{bukan json")).status).toBe(200);
	expect((await post(a, "rahasia-webhook", { update_id: "x" })).status).toBe(
		200,
	);
	expect(got).toHaveLength(0);
	expect(deadLetters).toHaveLength(2);
	expect(deadLetters[0]).toEqual({
		channel: "telegram",
		payload: "{bukan json",
		error: expect.any(String),
	});
	expect(deadLetters[1]).toEqual({
		channel: "telegram",
		payload: JSON.stringify({ update_id: "x" }),
		error: expect.any(String),
	});
});

test("dead_letter gagal disimpan → 500 supaya Telegram mengirim ulang", async () => {
	const res = await post(
		app(
			async () => {},
			async () => {
				throw new Error("dead_letter mati");
			},
		),
		"rahasia-webhook",
		"{bukan json",
	);
	expect(res.status).toBe(500);
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
