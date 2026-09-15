import { z } from "zod";

// Satu-satunya tempat TOML diimpor (CONVENTIONS §9). File dibaca dari
// `config/<nama>.toml`, ditimpa env `TICKO_<NAMA>__<BAGIAN>__<KUNCI>`, lalu
// divalidasi. Kredensial tidak pernah dibaca dari file: skema file `strict`,
// jadi kunci rahasia yang ditulis di TOML membuat proses gagal start.

/** Nilai rahasia. Tidak bisa bocor lewat log atau JSON.stringify. */
export class Secret {
	readonly #value: string;
	constructor(value: string) {
		this.#value = value;
	}
	reveal(): string {
		return this.#value;
	}
	toJSON(): string {
		return "[redacted]";
	}
	toString(): string {
		return "[redacted]";
	}
}

export class ConfigError extends Error {
	override name = "ConfigError";
}

type Env = Record<string, string | undefined>;

const secret = (env: Env, name: string): Secret => {
	const v = env[name];
	if (!v) throw new ConfigError(`env ${name} wajib diisi`);
	return new Secret(v);
};

const LogLevel = z.enum(["error", "warn", "info", "debug", "trace"]);

const AppFile = z.strictObject({
	server: z.strictObject({ port: z.number().int().min(1).max(65535) }),
	database: z.strictObject({ max_connections: z.number().int().min(1) }),
	logging: z.strictObject({ level: LogLevel }),
});

const ChannelsFile = z.strictObject({
	telegram: z.strictObject({ enabled: z.boolean() }),
});

const AgentFile = z.strictObject({
	provider: z.enum(["anthropic", "openai"]),
	model: z.string().min(1),
	// Diganti untuk endpoint yang kompatibel dengan API penyedia.
	base_url: z.url(),
	max_output_tokens: z.number().int().min(1),
	context_max_tokens: z.number().int().min(1),
	recent_messages: z.number().int().min(1),
	input_usd_per_mtok: z.number().min(0),
	output_usd_per_mtok: z.number().min(0),
});

export async function loadAppConfig(
	dir = defaultDir(),
	env: Env = process.env,
) {
	const f = await readConfig(dir, "app", AppFile, env);
	return {
		server: { port: f.server.port },
		database: {
			url: secret(env, "TICKO_DATABASE_URL"),
			maxConnections: f.database.max_connections,
		},
		redis: { url: secret(env, "TICKO_REDIS_URL") },
		logging: { level: f.logging.level },
	};
}
export type AppConfig = Awaited<ReturnType<typeof loadAppConfig>>;

export async function loadChannelsConfig(
	dir = defaultDir(),
	env: Env = process.env,
) {
	const f = await readConfig(dir, "channels", ChannelsFile, env);
	return {
		telegram: f.telegram.enabled
			? {
					botToken: secret(env, "TICKO_TELEGRAM_BOT_TOKEN"),
					webhookSecret: secret(env, "TICKO_TELEGRAM_WEBHOOK_SECRET"),
				}
			: null,
	};
}
export type ChannelsConfig = Awaited<ReturnType<typeof loadChannelsConfig>>;

export async function loadAgentConfig(
	dir = defaultDir(),
	env: Env = process.env,
) {
	const f = await readConfig(dir, "agent", AgentFile, env);
	return {
		provider: f.provider,
		model: f.model,
		baseUrl: f.base_url,
		apiKey: secret(env, "TICKO_LLM_API_KEY"),
		maxOutputTokens: f.max_output_tokens,
		contextMaxTokens: f.context_max_tokens,
		recentMessages: f.recent_messages,
		inputUsdPerMtok: f.input_usd_per_mtok,
		outputUsdPerMtok: f.output_usd_per_mtok,
	};
}
export type AgentConfig = Awaited<ReturnType<typeof loadAgentConfig>>;

function defaultDir(): string {
	return `${process.cwd()}/config`;
}

async function readConfig<T>(
	dir: string,
	name: string,
	schema: z.ZodType<T>,
	env: Env,
): Promise<T> {
	const path = `${dir}/${name}.toml`;
	let raw: unknown;
	try {
		raw = (await import(path, { with: { type: "toml" } })).default;
	} catch (cause) {
		throw new ConfigError(
			`gagal membaca ${path} (salin dari ${name}.example.toml?)`,
			{ cause },
		);
	}
	const parsed = schema.safeParse(applyEnv(raw, name, env));
	if (!parsed.success) {
		throw new ConfigError(
			`${path} tidak valid:\n${z.prettifyError(parsed.error)}`,
		);
	}
	return parsed.data;
}

// TICKO_APP__SERVER__PORT=8080 → { server: { port: 8080 } }. Nilai dibaca
// sebagai JSON bila bisa (angka, boolean), selain itu string; Zod yang menilai.
function applyEnv(raw: unknown, name: string, env: Env): unknown {
	const prefix = `TICKO_${name.toUpperCase()}__`;
	const root = structuredClone(raw);
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(prefix) || value === undefined) continue;
		const path = key.slice(prefix.length).toLowerCase().split("__");
		const last = path.pop();
		if (last === undefined || !isRecord(root)) continue;
		let node: Record<string, unknown> = root;
		for (const part of path) {
			const next = node[part];
			if (!isRecord(next)) node[part] = {};
			const child = node[part];
			if (!isRecord(child)) break;
			node = child;
		}
		node[last] = parseScalar(value);
	}
	return root;
}

function parseScalar(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function isRecord(x: unknown): x is Record<string, unknown> {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}
