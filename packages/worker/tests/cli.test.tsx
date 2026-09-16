import { afterAll, beforeAll, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { FakeLlm } from "@ticko/agent/fake";
import { schema } from "@ticko/storage";
import { createTestDb } from "@ticko/storage/testing";
import { createCli } from "../src/cli";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
	t = await createTestDb();
});
afterAll(() => t.drop());

test("chat, takeover membuat bot diam, handback tak sah tidak melempar", async () => {
	const out: string[] = [];
	const llm = FakeLlm.withText("Halo dari bot");
	const cli = createCli({
		db: t.db,
		llm,
		config: {
			model: "fake",
			maxOutputTokens: 256,
			contextMaxTokens: 4000,
			recentMessages: 20,
			inputUsdPerMtok: 0,
			outputUsdPerMtok: 0,
		},
		systemPrompt: "Kamu CS.",
		print: (l) => out.push(l),
	});
	const replies = () => out.filter((l) => l.includes("Halo dari bot")).length;

	await cli.handle("halo");
	expect(replies()).toBe(1);
	expect((await t.db.select().from(schema.agentRuns))[0]?.status).toBe(
		"succeeded",
	);

	await cli.handle("/handback");
	expect(out.at(-1)).toContain("transisi ditolak");

	await cli.handle("/takeover");
	await cli.handle("masih ada orang?");
	expect(replies()).toBe(1);
	expect(llm.calls).toHaveLength(1);

	await cli.handle("/handback");
	await cli.handle("oke lanjut");
	expect(replies()).toBe(2);

	expect(await cli.handle("/quit")).toBe(false);
});

test("/msgs cetak tabel dengan header dan baris sejajar", async () => {
	const out: string[] = [];
	const cli = createCli({
		db: t.db,
		llm: FakeLlm.withText("Halo dari bot"),
		config: {
			model: "fake",
			maxOutputTokens: 256,
			contextMaxTokens: 4000,
			recentMessages: 20,
			inputUsdPerMtok: 0,
			outputUsdPerMtok: 0,
		},
		systemPrompt: "Kamu CS.",
		print: (l) => out.push(l),
	});

	await cli.handle("halo");
	out.length = 0;
	await cli.handle("/msgs");

	const table = out.find((l) => l.includes("DARI"));
	expect(table).toBeDefined();
	const lines = (table ?? "").split("\n");
	expect(lines.length).toBeGreaterThanOrEqual(2);
	// Header dan baris data harus sejajar (lebar visual sama).
	const width = (s: string) => stripVTControlCharacters(s).length;
	expect(width(lines[1] ?? "")).toBe(width(lines[0] ?? ""));
});
