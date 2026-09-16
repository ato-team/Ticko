import { afterAll, beforeAll, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { FakeLlm } from "@ticko/agent/fake";
import { schema } from "@ticko/storage";
import { createTestDb } from "@ticko/storage/testing";
import { renderToString } from "ink";
import { createCli, type Entry } from "../src/cli";
import { Table } from "../src/ui/entries";

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
	t = await createTestDb();
});
afterAll(() => t.drop());

const config = {
	model: "fake",
	maxOutputTokens: 256,
	contextMaxTokens: 4000,
	recentMessages: 20,
	inputUsdPerMtok: 0,
	outputUsdPerMtok: 0,
};

test("chat, takeover membuat bot diam, handback tak sah tidak melempar", async () => {
	const out: Entry[] = [];
	const llm = FakeLlm.withText("Halo dari bot");
	const cli = createCli({
		db: t.db,
		llm,
		config,
		systemPrompt: "Kamu CS.",
		emit: (e) => out.push(e),
	});
	const replies = () =>
		out.filter((e) => e.kind === "bot" && e.text === "Halo dari bot").length;

	await cli.handle("halo");
	expect(replies()).toBe(1);
	expect(cli.status()).toMatchObject({
		status: "bot_active",
		controlOwner: "bot",
	});
	expect((await t.db.select().from(schema.agentRuns))[0]?.status).toBe(
		"succeeded",
	);

	await cli.handle("/handback");
	expect(out.at(-1)).toMatchObject({ kind: "fail" });
	expect(JSON.stringify(out.at(-1))).toContain("transisi ditolak");

	await cli.handle("/takeover");
	expect(cli.status().status).toBe("human_active");
	await cli.handle("masih ada orang?");
	expect(replies()).toBe(1);
	expect(llm.calls).toHaveLength(1);

	await cli.handle("/handback");
	await cli.handle("oke lanjut");
	expect(replies()).toBe(2);

	expect(await cli.handle("/quit")).toBe(false);
});

test("/msgs memancarkan tabel yang dirender sejajar", async () => {
	const out: Entry[] = [];
	const cli = createCli({
		db: t.db,
		llm: FakeLlm.withText("Halo dari bot"),
		config,
		systemPrompt: "Kamu CS.",
		emit: (e) => out.push(e),
	});

	await cli.handle("halo");
	out.length = 0;
	await cli.handle("/msgs");

	const table = out.find((e) => e.kind === "table");
	if (table?.kind !== "table") throw new Error("tabel tidak dipancarkan");
	expect(table.rows.length).toBeGreaterThanOrEqual(2);

	const lines = stripVTControlCharacters(
		renderToString(<Table title={table.title} rows={table.rows} />, {
			columns: 120,
		}),
	).split("\n");
	const header = lines.findIndex((l) => l.includes("DARI"));
	expect(header).toBeGreaterThan(0);
	// Kolom kedua (WAKTU) mulai di posisi yang sama pada header dan baris data.
	const col = (l: string) => l.search(/WAKTU|\d{2}:\d{2}:\d{2} UTC/);
	expect(col(lines[header + 1] ?? "")).toBe(col(lines[header] ?? ""));
});
