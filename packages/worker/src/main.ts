import { readFile } from "node:fs/promises";
import { createLlmClient } from "@ticko/agent";
import { buildRegistry } from "@ticko/channels";
import {
	ConfigError,
	loadAgentConfig,
	loadAppConfig,
	loadChannelsConfig,
} from "@ticko/domain";
import { close, connect } from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { agentRunHandler } from "./handlers/agent";
import { sendMessageHandler } from "./handlers/send";
import { startPoller } from "./poller";

// Proses terpisah dari api: loop agent yang lambat tidak boleh menahan webhook.
const [app, channelsConfig, agentConfig] = await Promise.all([
	loadAppConfig(),
	loadChannelsConfig(),
	loadAgentConfig(),
]).catch((e: unknown) => {
	if (e instanceof ConfigError) {
		console.error(e.message);
		process.exit(1);
	}
	throw e;
});

const log = createLogger(app.logging.level);
log.info(
	{ config: { app, channels: channelsConfig, agent: agentConfig } },
	"worker start",
);
const systemPrompt = await readFile(
	`${process.cwd()}/prompts/agent.md`,
	"utf8",
);

const db = connect(app.database);
const channels = buildRegistry(channelsConfig);
const workerId = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

const poller = startPoller({
	db,
	workerId,
	log,
	handlers: {
		send_message: sendMessageHandler({ db, channels }),
		agent_run: agentRunHandler({
			db,
			llm: createLlmClient(agentConfig),
			config: agentConfig,
			systemPrompt,
		}),
	},
});
log.info({ worker_id: workerId }, "worker mendengarkan antrian");

process.once("SIGTERM", async () => {
	log.info("SIGTERM diterima, menunggu job yang sedang berjalan");
	await poller.stop();
	await close(db);
	log.info("worker berhenti");
	process.exit(0);
});
