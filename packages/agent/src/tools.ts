import type { ConversationId } from "@ticko/domain";
import { z } from "zod";

// Tool & registry (A-2.7). `args` adalah satu-satunya sumber untuk validasi
// runtime DAN skema JSON yang dikirim ke LLM (AC-4.6) — tidak ada skema yang
// ditulis manual, jadi keduanya tidak bisa jadi tidak sinkron.

export interface ToolContext {
	conversationId: ConversationId;
	traceId: string;
}

// `invalid_args` dan `unknown_tool` dikembalikan ke AI agar ia memperbaiki
// panggilannya (AC-4.1); `failed` untuk tool yang berjalan tapi tidak berhasil.
export type ToolError =
	| { kind: "unknown_tool"; message: string }
	| {
			kind: "invalid_args";
			message: string;
			issues: { path: string; message: string }[];
	  }
	| { kind: "failed"; message: string };

export type ToolResult =
	| { ok: true; output: unknown }
	| { ok: false; error: ToolError };

export interface Tool<A extends z.ZodObject = z.ZodObject> {
	name: string;
	description: string;
	/** `control` mengubah alur percakapan (handoff, resolve), bukan data. */
	kind: "read" | "write" | "control";
	args: A;
	run(input: z.infer<A>, ctx: ToolContext): Promise<ToolResult>;
}

/** Bentuk yang dikirim ke LLM; adapter penyedia memetakan ke format masing-masing. */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

// Batas nama tool yang diterima Anthropic dan OpenAI.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export class ToolRegistry {
	private tools = new Map<string, Tool>();

	/** Nama tidak sah atau ganda adalah bug saat start, jadi dilempar. */
	register<A extends z.ZodObject>(tool: Tool<A>): this {
		if (!TOOL_NAME.test(tool.name))
			throw new Error(`nama tool tidak sah: ${tool.name}`);
		if (this.tools.has(tool.name)) throw new Error(`tool ganda: ${tool.name}`);
		this.tools.set(tool.name, tool);
		return this;
	}

	definitions(): ToolDefinition[] {
		return [...this.tools.values()].map((t) => {
			const { $schema: _, ...parameters } = z.toJSONSchema(t.args, {
				io: "input",
			});
			return { name: t.name, description: t.description, parameters };
		});
	}

	/** Argumen divalidasi dulu; tool tidak dijalankan kalau tidak sah (AC-4.1). */
	async execute(
		name: string,
		rawArgs: unknown,
		ctx: ToolContext,
	): Promise<ToolResult> {
		const tool = this.tools.get(name);
		if (!tool) {
			const known = [...this.tools.keys()].join(", ");
			return {
				ok: false,
				error: {
					kind: "unknown_tool",
					message: `tool "${name}" tidak ada; yang tersedia: ${known}`,
				},
			};
		}
		const parsed = tool.args.safeParse(rawArgs);
		if (!parsed.success) {
			return {
				ok: false,
				error: {
					kind: "invalid_args",
					message: `argumen untuk "${name}" tidak sesuai skema; perbaiki lalu panggil ulang`,
					issues: parsed.error.issues.map((i) => ({
						path: i.path.join(".") || "(root)",
						message: i.message,
					})),
				},
			};
		}
		return tool.run(parsed.data, ctx);
	}
}
