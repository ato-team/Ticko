import type { Channel } from "./entity";

// Kontrak 2: inti memanggil, channel mengimplementasikan.

export interface SentMessage {
	externalMessageId: string;
	sentAt: string; // ISO 8601 UTC
}

export interface TemplateRef {
	name: string;
	language: string;
	params: string[];
}

// Outbound worker bercabang di sini: yang sementara dicoba ulang, yang
// permanen langsung berhenti.
export type ChannelError =
	| { kind: "timeout" }
	| { kind: "network"; cause: unknown }
	| { kind: "rate_limited"; retryAfterSeconds: number | null }
	| { kind: "recipient_unavailable"; description: string }
	| { kind: "rejected"; status: number; description: string };

export class ChannelFailure extends Error {
	constructor(readonly error: ChannelError) {
		super(`pengiriman channel gagal: ${error.kind}`);
		this.name = "ChannelFailure";
	}
}

export interface ChannelAdapter {
	readonly channel: Channel;

	/** Melempar `ChannelFailure` saat gagal. */
	sendText(to: string, text: string): Promise<SentMessage>;

	/** Melempar `ChannelFailure` saat gagal. */
	sendTemplate(to: string, template: TemplateRef): Promise<SentMessage>;

	/** Apakah pesan teks bebas boleh dikirim sekarang?
	 *  Telegram selalu true. WhatsApp bergantung jendela 24 jam. */
	supportsFreeForm(lastInboundAt: string | null): boolean;
}
