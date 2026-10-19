import { expect, test } from "bun:test";
import { ConversationId } from "@ticko/domain";
import { z } from "zod";
import { type Tool, ToolRegistry } from "../src/tools";

const ctx = {
	conversationId: ConversationId.parse("0b8e7a52-4c1f-4d2e-9a6b-3f5c8d7e1a20"),
	traceId: "t",
};

const ran: string[] = [];
const orderStatus: Tool<z.ZodObject<{ orderId: z.ZodString }>> = {
	name: "get_order_status",
	description: "Status pesanan",
	kind: "read",
	args: z.object({ orderId: z.string().min(1).describe("Nomor pesanan") }),
	run: async ({ orderId }) => {
		ran.push(orderId);
		return { ok: true, output: { orderId, status: "dikirim" } };
	},
};
const note: Tool<z.ZodObject<{ text: z.ZodString }>> = {
	name: "add_note",
	description: "Tambah catatan internal",
	kind: "write",
	args: z.object({ text: z.string() }),
	run: async () => ({ ok: false, error: { kind: "failed", message: "db" } }),
};
const handoff = {
	name: "request_human_handoff",
	description: "Alihkan ke manusia",
	kind: "control" as const,
	args: z.object({
		reason: z.string().min(1),
		urgency: z.enum(["low", "normal", "high", "critical"]).default("normal"),
	}),
	run: async (input: { reason: string; urgency: string }) => ({
		ok: true as const,
		output: input,
	}),
};

const registry = () =>
	new ToolRegistry().register(orderStatus).register(note).register(handoff);

test("registry menampung tiga tool berbeda dan skema JSON dihasilkan dari Zod (AC-4.6)", () => {
	const defs = registry().definitions();
	expect(defs.map((d) => d.name)).toEqual([
		"get_order_status",
		"add_note",
		"request_human_handoff",
	]);
	expect(defs[0]?.parameters).toEqual({
		type: "object",
		properties: {
			orderId: { type: "string", minLength: 1, description: "Nomor pesanan" },
		},
		required: ["orderId"],
	});
	// io: "input" — field ber-default tidak wajib dikirim LLM.
	expect(defs[2]?.parameters.required).toEqual(["reason"]);
});

test("argumen tidak sesuai skema → error terstruktur, tool tidak dijalankan (AC-4.1)", async () => {
	ran.length = 0;
	const r = await registry().execute("get_order_status", { orderId: 7 }, ctx);
	expect(r).toMatchObject({
		ok: false,
		error: { kind: "invalid_args", issues: [{ path: "orderId" }] },
	});
	expect(ran).toEqual([]);
});

test("argumen sah → tool dijalankan dengan hasil parse (default terisi)", async () => {
	const reg = registry();
	expect(await reg.execute("get_order_status", { orderId: "A1" }, ctx)).toEqual(
		{ ok: true, output: { orderId: "A1", status: "dikirim" } },
	);
	expect(
		await reg.execute("request_human_handoff", { reason: "marah" }, ctx),
	).toEqual({ ok: true, output: { reason: "marah", urgency: "normal" } });
});

test("tool tak dikenal → unknown_tool yang menyebut tool yang tersedia", async () => {
	const r = await registry().execute("hapus_semua", {}, ctx);
	expect(r.ok).toBe(false);
	if (!r.ok) {
		expect(r.error.kind).toBe("unknown_tool");
		expect(r.error.message).toContain("get_order_status");
	}
});

test("nama tool ganda atau tidak sah ditolak saat register", () => {
	expect(() => registry().register(orderStatus)).toThrow("tool ganda");
	expect(() =>
		new ToolRegistry().register({ ...note, name: "nama dengan spasi" }),
	).toThrow("tidak sah");
});
