import { afterEach, describe, expect, test } from "bun:test";
import { ChannelFailure, Secret } from "@ticko/domain";
import { buildRegistry } from "../src";
import { TelegramAdapter } from "../src/telegram/adapter";
import { parseUpdate } from "../src/telegram/update";
import { type MockTelegramServer, startMockTelegram } from "./mock-telegram";

const TOKEN = "123456:SECRET-TOKEN";

type Call = { url: string; body: unknown };
function stubFetch(
	respond: (
		call: Call,
		signal: AbortSignal | null | undefined,
	) => Promise<Response>,
) {
	const calls: Call[] = [];
	const f = async (input: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(input), body: JSON.parse(String(init?.body)) };
		calls.push(call);
		return respond(call, init?.signal);
	};
	return { calls, fetch: f as typeof fetch };
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

async function failureOf(p: Promise<unknown>) {
	const e = await p.catch((err: unknown) => err);
	if (!(e instanceof ChannelFailure))
		throw new Error(`bukan ChannelFailure: ${String(e)}`);
	return e.error;
}

describe("sendText", () => {
	test("memanggil sendMessage dan mengembalikan SentMessage", async () => {
		const s = stubFetch(async () =>
			json(200, { ok: true, result: { message_id: 77, date: 1789322400 } }),
		);
		const a = new TelegramAdapter({
			botToken: new Secret(TOKEN),
			fetch: s.fetch,
		});
		const sent = await a.sendText("42", "halo");
		expect(sent).toEqual({
			externalMessageId: "42:77",
			sentAt: "2026-09-13T18:00:00.000Z",
		});
		expect(s.calls).toEqual([
			{
				url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
				body: { chat_id: "42", text: "halo" },
			},
		]);
	});

	test("429 → rate_limited dengan retry_after", async () => {
		const s = stubFetch(async () =>
			json(429, {
				ok: false,
				error_code: 429,
				description: "Too Many Requests",
				parameters: { retry_after: 5 },
			}),
		);
		const a = new TelegramAdapter({
			botToken: new Secret(TOKEN),
			fetch: s.fetch,
		});
		expect(await failureOf(a.sendText("42", "x"))).toEqual({
			kind: "rate_limited",
			retryAfterSeconds: 5,
		});
	});

	test("403 → recipient_unavailable; 400 → rejected", async () => {
		const blocked = stubFetch(async () =>
			json(403, {
				ok: false,
				error_code: 403,
				description: "Forbidden: bot was blocked by the user",
			}),
		);
		const bad = stubFetch(async () =>
			json(400, {
				ok: false,
				error_code: 400,
				description: "Bad Request: chat not found",
			}),
		);
		expect(
			await failureOf(
				new TelegramAdapter({
					botToken: new Secret(TOKEN),
					fetch: blocked.fetch,
				}).sendText("1", "x"),
			),
		).toMatchObject({ kind: "recipient_unavailable" });
		expect(
			await failureOf(
				new TelegramAdapter({
					botToken: new Secret(TOKEN),
					fetch: bad.fetch,
				}).sendText("1", "x"),
			),
		).toEqual({
			kind: "rejected",
			status: 400,
			description: "Bad Request: chat not found",
		});
	});

	test("API menggantung → timeout, bukan menunggu selamanya", async () => {
		const s = stubFetch(
			(_c, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason));
				}),
		);
		const a = new TelegramAdapter({
			botToken: new Secret(TOKEN),
			fetch: s.fetch,
			timeoutMs: 30,
		});
		expect(await failureOf(a.sendText("42", "x"))).toEqual({ kind: "timeout" });
	});

	test("error jaringan tidak membocorkan token", async () => {
		const s = stubFetch(async (c) => {
			throw new Error(`Unable to connect to ${c.url}`);
		});
		const a = new TelegramAdapter({
			botToken: new Secret(TOKEN),
			fetch: s.fetch,
		});
		const err = await failureOf(a.sendText("42", "x"));
		expect(err.kind).toBe("network");
		expect(JSON.stringify(err)).not.toContain("SECRET-TOKEN");
	});
});

describe("sendText lewat mock server Bot API (B-1.6, HTTP sungguhan)", () => {
	let mock: MockTelegramServer;
	afterEach(() => mock?.stop());

	test("429 dari server nyata → rate_limited dengan retry_after", async () => {
		mock = startMockTelegram();
		mock.respond("sendMessage", {
			kind: "error",
			status: 429,
			body: {
				error_code: 429,
				description: "Too Many Requests",
				retryAfter: 3,
			},
		});
		const a = new TelegramAdapter({
			botToken: new Secret(TOKEN),
			apiBase: mock.url,
		});
		expect(await failureOf(a.sendText("42", "x"))).toEqual({
			kind: "rate_limited",
			retryAfterSeconds: 3,
		});
	});

	test("server yang menggantung → timeout, bukan menunggu selamanya", async () => {
		mock = startMockTelegram();
		mock.respond("sendMessage", { kind: "hang" });
		const a = new TelegramAdapter({
			botToken: new Secret(TOKEN),
			apiBase: mock.url,
			timeoutMs: 50,
		});
		expect(await failureOf(a.sendText("42", "x"))).toEqual({ kind: "timeout" });
	});
});

describe("parseUpdate", () => {
	const base = {
		update_id: 1,
		message: {
			message_id: 9,
			date: 1789322400,
			chat: { id: 42 },
			from: { id: 42, first_name: "Budi", last_name: "S" },
		},
	};

	test("pesan teks → InboundMessage", () => {
		expect(
			parseUpdate({ ...base, message: { ...base.message, text: "halo" } }),
		).toEqual({
			ok: true,
			message: {
				channel: "telegram",
				externalConversationId: "42",
				externalMessageId: "42:9",
				senderExternalId: "42",
				senderDisplayName: "Budi S",
				content: { text: "halo" },
				attachments: [],
				sentAt: "2026-09-13T18:00:00.000Z",
			},
		});
	});

	test("foto dengan caption dan dokumen", () => {
		const r = parseUpdate({
			...base,
			message: {
				...base.message,
				caption: "struk",
				photo: [{ file_id: "small" }, { file_id: "large" }],
				document: { file_id: "doc", mime_type: "application/pdf" },
			},
		});
		expect(r.ok && r.message).toMatchObject({
			content: { text: "struk" },
			attachments: [
				{ kind: "photo", externalFileId: "large", mimeType: null },
				{
					kind: "document",
					externalFileId: "doc",
					mimeType: "application/pdf",
				},
			],
		});
	});

	test("update tanpa message → null; bentuk aneh → error", () => {
		expect(parseUpdate({ update_id: 2, edited_message: {} })).toEqual({
			ok: true,
			message: null,
		});
		const bad = parseUpdate({ update_id: "x" });
		expect(bad.ok).toBe(false);
	});
});

test("registry: channel tidak dikonfigurasi → error jelas", () => {
	expect(() => buildRegistry({ telegram: null })).toThrow("tidak ada channel");
	const r = buildRegistry({
		telegram: { botToken: new Secret(TOKEN), webhookSecret: new Secret("s") },
	});
	expect(r.get("telegram").channel).toBe("telegram");
	expect(() => r.get("whatsapp")).toThrow(
		"channel whatsapp tidak dikonfigurasi",
	);
});
