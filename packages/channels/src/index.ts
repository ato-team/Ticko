import type { Channel, ChannelAdapter, ChannelsConfig } from "@ticko/domain";
import { TelegramAdapter } from "./telegram/adapter";

export { TelegramAdapter } from "./telegram/adapter";
export { type ParseUpdateResult, parseUpdate } from "./telegram/update";

export interface ChannelRegistry {
	/** Melempar bila channel tidak dikonfigurasi. */
	get(channel: Channel): ChannelAdapter;
}

/** Dibangun saat start. Gagal di sini, bukan `undefined` yang meledak belakangan. */
export function buildRegistry(
	config: ChannelsConfig,
	opts: { fetch?: typeof fetch } = {},
): ChannelRegistry {
	const adapters = new Map<Channel, ChannelAdapter>();
	if (config.telegram) {
		adapters.set(
			"telegram",
			new TelegramAdapter({
				botToken: config.telegram.botToken,
				...(opts.fetch ? { fetch: opts.fetch } : {}),
			}),
		);
	}
	if (adapters.size === 0) {
		throw new Error(
			"tidak ada channel yang diaktifkan di config/channels.toml",
		);
	}
	return fromAdapters(adapters);
}

export function fromAdapters(
	adapters: Map<Channel, ChannelAdapter>,
): ChannelRegistry {
	return {
		get(channel) {
			const adapter = adapters.get(channel);
			if (!adapter) {
				throw new Error(`channel ${channel} tidak dikonfigurasi`);
			}
			return adapter;
		},
	};
}
