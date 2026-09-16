import { TelegramAdapter } from "@ticko/channels";
import { loadChannelsConfig } from "@ticko/domain";
import { printNotice, runSteps } from "./ui/task";

// B-1.5: satu perintah untuk mendaftarkan webhook Telegram. Dipakai lokal
// lewat tunnel (ngrok/cloudflared) dan di produksi lewat domain sebenarnya.
// Lihat README §"Dari nol sampai bot membalas" untuk langkah lengkapnya.

const publicUrl = process.argv[2];
if (!publicUrl) {
	printNotice("URL publik belum diberikan", [
		"pakai:  bun run webhook:setup <public-url>",
		"contoh: bun run webhook:setup https://contoh.trycloudflare.com",
	]);
	process.exit(1);
}

const base = publicUrl.replace(/\/$/, "");
let adapter: TelegramAdapter | undefined;
let secret = "";

const ok = await runSteps("Webhook Telegram", [
	{
		label: "Memuat config/channels.toml",
		run: async () => {
			const channels = await loadChannelsConfig();
			if (!channels.telegram) {
				throw new Error("channel telegram tidak aktif di config/channels.toml");
			}
			adapter = new TelegramAdapter({ botToken: channels.telegram.botToken });
			secret = channels.telegram.webhookSecret.reveal();
			return undefined;
		},
	},
	{
		label: "Mendaftarkan webhook ke Bot API",
		run: async () => {
			await adapter?.setWebhook(`${base}/webhook/telegram/${secret}`);
			// Secret tidak pernah dicetak ke terminal — path lengkapnya tersimpan di
			// config/channels.toml.
			return `${base}/webhook/telegram/<secret>`;
		},
	},
]);
process.exit(ok ? 0 : 1);
