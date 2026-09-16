import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createLlmClient } from "@ticko/agent";
// Hanya alat pengecekan lokal: `--fake` sengaja memakai LLM palsu.
import { FakeLlm } from "@ticko/agent/fake";
import { ConfigError, loadAgentConfig, loadAppConfig } from "@ticko/domain";
import { close, connect } from "@ticko/storage";
import { render, renderToString } from "ink";
import { createCli } from "./cli";
import { type Line, LineView } from "./ui/entries";
import { App } from "./ui/repl";

const fake = process.argv.includes("--fake");
// Dengan --fake, API key tidak dibutuhkan.
const env = fake
	? {
			...process.env,
			TICKO_LLM_API_KEY: process.env.TICKO_LLM_API_KEY || "fake",
		}
	: process.env;
const [app, agent] = await Promise.all([
	loadAppConfig(undefined, env),
	loadAgentConfig(undefined, env),
]).catch((e: unknown) => {
	if (e instanceof ConfigError) {
		console.error(
			renderToString(<LineView line={{ kind: "fail", text: e.message }} />),
		);
		process.exit(1);
	}
	throw e;
});

const db = connect(app.database);
const deps = {
	db,
	llm: fake
		? FakeLlm.withText("Halo! Ini balasan dari FakeLlm (mode --fake).")
		: createLlmClient(agent),
	config: agent,
	systemPrompt: await readFile(`${process.cwd()}/prompts/agent.md`, "utf8"),
};
const llm = fake ? "FakeLlm" : `${agent.provider}/${agent.model}`;

try {
	if (process.stdin.isTTY) {
		await render(<App deps={deps} llm={llm} />).waitUntilExit();
	} else {
		// Input di-pipe: tanpa prompt live, setiap entry langsung dicetak.
		const print = (line: Line) =>
			console.log(renderToString(<LineView line={line} />, { columns: 100 }));
		const cli = createCli({ ...deps, emit: print });
		print({ kind: "banner", llm });
		// Iterator readline menyangga input, jadi perintah yang di-pipe tidak hilang.
		for await (const text of createInterface({ input: process.stdin })) {
			if (text.trim() === "") continue;
			console.log();
			print({ kind: "input", text: text.trim() });
			try {
				if (!(await cli.handle(text))) break;
			} catch (e) {
				print({
					kind: "fail",
					text: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}
} finally {
	await close(db);
}
