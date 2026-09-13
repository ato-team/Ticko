import { buildRegistry } from "@ticko/channels";
import { ConfigError, loadAppConfig, loadChannelsConfig } from "@ticko/domain";
import { close, connect } from "@ticko/storage";
import { createLogger } from "@ticko/storage/log";
import { echoAgentHandler } from "./handlers/agent";
import { sendMessageHandler } from "./handlers/send";
import { startPoller } from "./poller";

// Proses terpisah dari api: loop agent yang lambat tidak boleh menahan webhook.
const [app, channelsConfig] = await Promise.all([
	loadAppConfig(),
	loadChannelsConfig(),
]).catch((e: unknown) => {
	if (e instanceof ConfigError) {
		console.error(e.message);
		process.exit(1);
	}
	throw e;
});

const log = createLogger(app.logging.level);
log.info({ config: { app, channels: channelsConfig } }, "worker start");

const db = connect(app.database);
const channels = buildRegistry(channelsConfig);
const workerId = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

const poller = startPoller({
	db,
	workerId,
	log,
	handlers: {
		send_message: sendMessageHandler({ db, channels }),
		agent_run: echoAgentHandler({ db }),
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
