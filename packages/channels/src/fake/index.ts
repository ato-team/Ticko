import {
	type Channel,
	type ChannelAdapter,
	type ChannelError,
	ChannelFailure,
	type SentMessage,
	type TemplateRef,
} from "@ticko/domain";

export type MockSent = SentMessage & { to: string } & (
		| { text: string }
		| { template: TemplateRef }
	);

// Menyimpan pesan ke array alih-alih mengirim ke jaringan (Kontrak 6).
export class MockChannelAdapter implements ChannelAdapter {
	readonly sent: MockSent[] = [];
	/** Pengiriman berikutnya melempar `failWith`, lalu kembali normal. */
	failNext = false;
	failWith: ChannelError = { kind: "timeout" };
	/** Untuk menguji jendela 24 jam WhatsApp. */
	freeFormAllowed = true;
	private seq = 0;

	constructor(readonly channel: Channel = "telegram") {}

	async sendText(to: string, text: string): Promise<SentMessage> {
		return this.record(to, { text });
	}

	async sendTemplate(to: string, template: TemplateRef): Promise<SentMessage> {
		return this.record(to, { template });
	}

	supportsFreeForm(_lastInboundAt: string | null): boolean {
		return this.freeFormAllowed;
	}

	private record(
		to: string,
		body: { text: string } | { template: TemplateRef },
	): SentMessage {
		if (this.failNext) {
			this.failNext = false;
			throw new ChannelFailure(this.failWith);
		}
		this.seq += 1;
		const msg = {
			externalMessageId: `mock-${this.seq}`,
			sentAt: new Date().toISOString(),
		};
		this.sent.push({ ...msg, to, ...body });
		return msg;
	}
}
