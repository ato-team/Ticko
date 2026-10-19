import type { ConversationDeps } from "../src/conversations";

/** Untuk test yang tidak menyentuh /api/conversations. */
export const noConversations: ConversationDeps = {
	list: async () => ({ items: [], page: 1, pageSize: 20, total: 0 }),
	get: async () => null,
};

/** Untuk test yang tidak menyentuh /api/stream. */
export const noDesk = { listen: () => () => {} };
