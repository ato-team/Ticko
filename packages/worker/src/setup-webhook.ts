import { TelegramAdapter } from "@ticko/channels";
import { ConfigError, loadChannelsConfig } from "@ticko/domain";

// B-1.5: satu perintah untuk mendaftarkan webhook Telegram. Dipakai lokal
// lewat tunnel (ngrok/cloudflared) dan di produksi lewat domain sebenarnya.
// Lihat README §"Dari nol sampai bot membalas" untuk langkah lengkapnya.

const publicUrl = process.argv[2];
if (!publicUrl) {
	console.error("pakai: bun run webhook:setup <public-url>");
	console.error(
		"contoh: bun run webhook:setup https://contoh.trycloudflare.com",
	);
	process.exit(1);
}

const channels = await loadChannelsConfig().catch((e: unknown) => {
	if (e instanceof ConfigError) {
		console.error(e.message);
		process.exit(1);
	}
	throw e;
});

if (!channels.telegram) {
	console.error("channel telegram tidak aktif di config/channels.toml");
	process.exit(1);
}

const adapter = new TelegramAdapter({ botToken: channels.telegram.botToken });
const base = publicUrl.replace(/\/$/, "");
// Secret tidak pernah dicetak ke terminal — path lengkapnya tersimpan di
// config/channels.toml.
await adapter.setWebhook(
	`${base}/webhook/telegram/${channels.telegram.webhookSecret.reveal()}`,
);
console.log(`webhook terdaftar: ${base}/webhook/telegram/<secret>`);
