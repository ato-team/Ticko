import { describe, expect, test } from "bun:test";
import { Secret } from "@ticko/domain";
import { FakeLlm } from "../src/fake";
import {
	AnthropicClient,
	createLlmClient,
	describeLlmError,
	estimateCostUsd,
	LlmFailure,
	OpenAiClient,
} from "../src/llm";

const KEY = "sk-sangat-rahasia";
const req = {
	system: "Kamu CS.",
	messages: [{ role: "user" as const, content: "halo" }],
	maxOutputTokens: 256,
};

type Call = { url: string; headers: Record<string, string>; body: unknown };
function stub(...responses: (Response | Error | "hang")[]) {
	const calls: Call[] = [];
	const f = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: JSON.parse(String(init?.body)),
		});
		const r = responses[Math.min(calls.length - 1, responses.length - 1)];
		if (r === "hang") {
			return new Promise<Response>((_res, rej) =>
				init?.signal?.addEventListener("abort", () => rej(init.signal?.reason)),
			);
		}
		if (r instanceof Error) throw r;
		return r ? r.clone() : new Response(null, { status: 500 });
	};
	return { calls, fetch: f as typeof fetch };
}
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status });
const deps = (f: typeof fetch, timeoutMs = 30_000) => ({
	apiKey: new Secret(KEY),
	fetch: f,
	timeoutMs,
	baseUrl: "https://llm.test",
	model: "model-x",
});

const openaiDeps = (f: typeof fetch) => ({
	...deps(f),
	maxTokensParam: "max_completion_tokens" as const,
	stream: false,
});

async function failure(p: Promise<unknown>) {
	const e = await p.catch((x: unknown) => x);
	if (!(e instanceof LlmFailure))
		throw new Error(`bukan LlmFailure: ${String(e)}`);
	return e.error;
}

const anthropicOk = json(200, {
	model: "model-x",
	stop_reason: "end_turn",
	content: [
		{ type: "thinking", thinking: "" },
		{ type: "text", text: "Halo, ada yang bisa dibantu?" },
	],
	usage: { input_tokens: 12, output_tokens: 7 },
});

describe("Anthropic", () => {
	test("satu panggilan mengembalikan teks dan token", async () => {
		const s = stub(anthropicOk);
		const r = await new AnthropicClient(deps(s.fetch)).complete(req);
		expect(r).toMatchObject({
			text: "Halo, ada yang bisa dibantu?",
			model: "model-x",
			inputTokens: 12,
			outputTokens: 7,
		});
		expect(s.calls[0]).toMatchObject({
			url: "https://llm.test/v1/messages",
			headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01" },
			body: {
				model: "model-x",
				max_tokens: 256,
				system: "Kamu CS.",
				messages: req.messages,
			},
		});
	});

	test("refusal → refused, tidak diretry", async () => {
		const s = stub(
			json(200, {
				model: "m",
				stop_reason: "refusal",
				content: [],
				usage: { input_tokens: 1, output_tokens: 0 },
			}),
		);
		expect(
			await failure(new AnthropicClient(deps(s.fetch)).complete(req)),
		).toEqual({ kind: "refused" });
		expect(s.calls).toHaveLength(1);
	});

	test("529 diretry maksimal 2 kali lalu gagal", async () => {
		const s = stub(
			json(529, { error: { type: "overloaded_error", message: "Overloaded" } }),
		);
		expect(
			await failure(new AnthropicClient(deps(s.fetch)).complete(req)),
		).toEqual({ kind: "overloaded" });
		expect(s.calls).toHaveLength(3);
	});

	test("retry berhasil di percobaan kedua", async () => {
		const s = stub(json(500, {}), anthropicOk);
		expect(
			(await new AnthropicClient(deps(s.fetch)).complete(req)).text,
		).toContain("Halo");
		expect(s.calls).toHaveLength(2);
	});

	test("400 → bad_request dengan pesan, tanpa retry", async () => {
		const s = stub(
			json(400, {
				error: {
					type: "invalid_request_error",
					message: "max_tokens terlalu besar",
				},
			}),
		);
		expect(
			await failure(new AnthropicClient(deps(s.fetch)).complete(req)),
		).toEqual({
			kind: "bad_request",
			status: 400,
			message: "max_tokens terlalu besar",
		});
		expect(s.calls).toHaveLength(1);
	});

	test("respons berubah bentuk → invalid_response, bukan lolos diam-diam", async () => {
		const s = stub(json(200, { model: "m", content: "teks" }));
		expect(
			(await failure(new AnthropicClient(deps(s.fetch)).complete(req))).kind,
		).toBe("invalid_response");
	});

	test("timeout membatalkan request, tidak menggantung (AC-3.3)", async () => {
		const s = stub("hang");
		expect(
			await failure(new AnthropicClient(deps(s.fetch, 20)).complete(req)),
		).toEqual({ kind: "timeout" });
		expect(s.calls).toHaveLength(3);
	});

	test("kunci API tidak bocor lewat error jaringan (AC-8.5)", async () => {
		const s = stub(new Error(`connect failed with header x-api-key=${KEY}`));
		const err = await failure(new AnthropicClient(deps(s.fetch)).complete(req));
		expect(JSON.stringify(err)).not.toContain(KEY);
	});
});

describe("OpenAI / kompatibel", () => {
	test("satu panggilan mengembalikan teks dan token", async () => {
		const s = stub(
			json(200, {
				model: "model-x",
				choices: [
					{
						message: { content: "Halo!", refusal: null },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 20, completion_tokens: 3 },
			}),
		);
		const r = await new OpenAiClient(openaiDeps(s.fetch)).complete(req);
		expect(r).toMatchObject({
			text: "Halo!",
			inputTokens: 20,
			outputTokens: 3,
		});
		expect(s.calls[0]).toMatchObject({
			url: "https://llm.test/chat/completions",
			headers: { authorization: `Bearer ${KEY}` },
			body: {
				model: "model-x",
				max_completion_tokens: 256,
				messages: [{ role: "system", content: "Kamu CS." }, ...req.messages],
			},
		});
	});

	test("refusal → refused; 401 → auth", async () => {
		const refusal = stub(
			json(200, {
				model: "m",
				choices: [{ message: { content: null, refusal: "tidak bisa" } }],
				usage: { prompt_tokens: 1, completion_tokens: 0 },
			}),
		);
		expect(
			await failure(new OpenAiClient(openaiDeps(refusal.fetch)).complete(req)),
		).toEqual({ kind: "refused" });
		const auth = stub(json(401, { error: { message: "bad key" } }));
		expect(
			await failure(new OpenAiClient(openaiDeps(auth.fetch)).complete(req)),
		).toEqual({ kind: "auth", status: 401 });
	});
});

test("createLlmClient memilih penyedia dari config; biaya dari tarif config", () => {
	const base = {
		model: "m",
		baseUrl: "https://x",
		apiKey: new Secret(KEY),
		maxOutputTokens: 1,
		contextMaxTokens: 1,
		recentMessages: 1,
		inputUsdPerMtok: 1,
		outputUsdPerMtok: 5,
	};
	expect(createLlmClient({ ...base, provider: "anthropic" })).toBeInstanceOf(
		AnthropicClient,
	);
	expect(createLlmClient({ ...base, provider: "openai" })).toBeInstanceOf(
		OpenAiClient,
	);
	expect(
		estimateCostUsd(base, { inputTokens: 1_000_000, outputTokens: 200_000 }),
	).toBe(2);
});

describe("FakeLlm", () => {
	test("tanpa jaringan, deterministik, calls bisa diperiksa", async () => {
		const llm = FakeLlm.withText("satu", "dua");
		expect((await llm.complete(req)).text).toBe("satu");
		expect((await llm.complete(req)).text).toBe("dua");
		expect((await llm.complete(req)).text).toBe("dua");
		expect(llm.calls).toHaveLength(3);
		expect(llm.calls[0]?.system).toBe("Kamu CS.");
	});

	test("withError memicu jalur kegagalan", async () => {
		const llm = FakeLlm.withError({ kind: "timeout" });
		expect(await failure(llm.complete(req))).toEqual({ kind: "timeout" });
	});
});

describe("router kompatibel OpenAI", () => {
	const reply = json(200, {
		choices: [{ message: { content: "Halo dari router" } }],
	});
	const cfg = (provider: "openrouter" | "9router", baseUrl: string) => ({
		provider,
		model: "anthropic/claude-sonnet-5",
		baseUrl,
		apiKey: new Secret(KEY),
		maxOutputTokens: 256,
		contextMaxTokens: 1,
		recentMessages: 1,
		inputUsdPerMtok: 0,
		outputUsdPerMtok: 0,
	});

	for (const [provider, baseUrl] of [
		["openrouter", "https://openrouter.ai/api/v1"],
		["9router", "http://localhost:20128/v1"],
	] as const) {
		test(`${provider}: max_tokens, Bearer, tanpa usage/model tetap jalan`, async () => {
			const s = stub(reply);
			const r = await createLlmClient(cfg(provider, baseUrl), {
				fetch: s.fetch,
			}).complete(req);
			expect(r).toMatchObject({
				text: "Halo dari router",
				model: "anthropic/claude-sonnet-5",
				inputTokens: 0,
				outputTokens: 0,
			});
			expect(s.calls[0]).toMatchObject({
				url: `${baseUrl}/chat/completions`,
				headers: { authorization: `Bearer ${KEY}` },
				body: {
					model: "anthropic/claude-sonnet-5",
					max_tokens: 256,
					stream: true,
				},
			});
		});
	}
});

test("respons SSE dirangkai: teks, model, usage dari chunk terakhir", async () => {
	const sse = [
		": OPENROUTER PROCESSING",
		'data: {"model":"muse-spark","choices":[{"index":0,"delta":{"role":"assistant","content":"Halo! "}}]}',
		'data: {"model":"muse-spark","choices":[{"index":0,"delta":{"content":"Ada yang bisa dibantu?"}}]}',
		'data: {"model":"muse-spark","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":6}}',
		"data: [DONE]",
		"",
	].join("\n\n");
	const s = stub(
		new Response(sse, { headers: { "content-type": "text/event-stream" } }),
	);
	const client = new OpenAiClient({
		...deps(s.fetch),
		maxTokensParam: "max_tokens",
		stream: true,
	});
	expect(await client.complete(req)).toMatchObject({
		text: "Halo! Ada yang bisa dibantu?",
		model: "muse-spark",
		inputTokens: 20,
		outputTokens: 6,
	});
});

test("content kosong → invalid_response dengan pesan yang menjelaskan", async () => {
	const s = stub(json(200, { choices: [{ message: { content: "" } }] }));
	const err = await failure(
		new OpenAiClient(openaiDeps(s.fetch)).complete(req),
	);
	expect(describeLlmError(err)).toBe("invalid_response: jawaban kosong");
});
