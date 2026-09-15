import { expect, test } from "bun:test";
import {
	ConfigError,
	loadAgentConfig,
	loadAppConfig,
	loadChannelsConfig,
} from "../src/config/load";

// domain dilarang mengimpor node:*, jadi test memakai global Bun.
const root = `${import.meta.dir}/../../../config`;
const examples = Object.fromEntries(
	await Promise.all(
		["app", "channels", "agent"].map(
			async (n) =>
				[n, await Bun.file(`${root}/${n}.example.toml`).text()] as const,
		),
	),
);
const example = (name: string): string => examples[name] ?? "";

// Setiap test memakai direktori sendiri: import() meng-cache per path.
async function configDir(files: Record<string, string>): Promise<string> {
	const dir = `${Bun.env.TMPDIR ?? "/tmp"}/ticko-config-${crypto.randomUUID()}`;
	for (const [name, body] of Object.entries(files)) {
		await Bun.write(`${dir}/${name}.toml`, body);
	}
	return dir;
}

const env = {
	TICKO_DATABASE_URL: "postgres://u:rahasia@db/ticko",
	TICKO_REDIS_URL: "redis://127.0.0.1:6379",
	TICKO_SESSION_SECRET: "session-rahasia",
	TICKO_TELEGRAM_BOT_TOKEN: "123:abc",
	TICKO_TELEGRAM_WEBHOOK_SECRET: "s3cret",
	TICKO_LLM_API_KEY: "sk-rahasia",
};

test("semua file example valid", async () => {
	const dir = await configDir({
		app: example("app"),
		channels: example("channels"),
		agent: example("agent"),
	});
	const app = await loadAppConfig(dir, env);
	expect(app.server.port).toBe(3000);
	expect(app.database.url.reveal()).toBe(env.TICKO_DATABASE_URL);
	expect((await loadChannelsConfig(dir, env)).telegram).not.toBeNull();
	expect((await loadAgentConfig(dir, env)).provider).toBe("anthropic");
});

test("field wajib hilang → gagal dengan path field-nya (AC-9.2)", async () => {
	const dir = await configDir({
		app: example("app").replace("port = 3000", ""),
	});
	const err = await loadAppConfig(dir, env).catch((e: unknown) => e);
	expect(err).toBeInstanceOf(ConfigError);
	expect(String(err)).toContain("server.port");
});

test("kredensial di file ditolak", async () => {
	const dir = await configDir({
		agent: `${example("agent")}\napi_key = "sk-bocor"\n`,
	});
	const err = await loadAgentConfig(dir, env).catch((e: unknown) => e);
	expect(err).toBeInstanceOf(ConfigError);
	expect(String(err)).toContain("api_key");
});

test("env kredensial kosong → gagal start", async () => {
	const dir = await configDir({ app: example("app") });
	const { TICKO_DATABASE_URL: _, ...noDb } = env;
	await expect(loadAppConfig(dir, noDb)).rejects.toThrow("TICKO_DATABASE_URL");
});

test("env TICKO_<FILE>__ menimpa nilai file", async () => {
	const dir = await configDir({ app: example("app") });
	const app = await loadAppConfig(dir, {
		...env,
		TICKO_APP__SERVER__PORT: "8080",
		TICKO_APP__LOGGING__LEVEL: "debug",
	});
	expect(app.server.port).toBe(8080);
	expect(app.logging.level).toBe("debug");
});

test("ringkasan config tidak membocorkan kredensial (AC-9.4)", async () => {
	const dir = await configDir({ app: example("app"), agent: example("agent") });
	const dump = JSON.stringify([
		await loadAppConfig(dir, env),
		await loadAgentConfig(dir, env),
	]);
	expect(dump).not.toContain("rahasia");
	expect(dump).toContain("[redacted]");
});

test("base_url opsional: default per penyedia, bisa ditimpa", async () => {
	const body = (provider: string, extra = "") =>
		`provider = "${provider}"\nmodel = "m"\n${extra}max_output_tokens = 1\ncontext_max_tokens = 1\nrecent_messages = 1\ninput_usd_per_mtok = 0\noutput_usd_per_mtok = 0\n`;
	const url = async (toml: string) =>
		(await loadAgentConfig(await configDir({ agent: toml }), env)).baseUrl;
	expect(await url(body("openrouter"))).toBe("https://openrouter.ai/api/v1");
	expect(await url(body("9router"))).toBe("http://localhost:20128/v1");
	expect(
		await url(body("9router", 'base_url = "http://10.0.0.5:20128/v1"\n')),
	).toBe("http://10.0.0.5:20128/v1");
});
