import {
	type ConversationDetail,
	ConversationId,
	ConversationStatus,
	type ConversationSummary,
	type Page,
} from "@ticko/domain";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./app";
import { toResponse } from "./error";

// Route baca-saja agent desk (B-2.1). Dipasang di belakang requireAuth.

export interface ConversationDeps {
	list(filter: {
		status?: ConversationStatus | undefined;
		page: number;
		pageSize: number;
	}): Promise<Page<ConversationSummary>>;
	get(id: ConversationId): Promise<ConversationDetail | null>;
}

const ListQuery = z.object({
	status: ConversationStatus.optional(),
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function conversationRoutes(deps: ConversationDeps): Hono<Env> {
	const app = new Hono<Env>();

	app.get("/", async (c) => {
		const query = ListQuery.safeParse(c.req.query());
		if (!query.success) return toResponse({ kind: "bad_request" });
		return c.json(await deps.list(query.data));
	});

	app.get("/:id", async (c) => {
		// id yang bukan UUID tidak mungkin ada → 404, bukan error Postgres (500).
		const id = ConversationId.safeParse(c.req.param("id"));
		if (!id.success) return toResponse({ kind: "not_found" });
		const detail = await deps.get(id.data);
		return detail ? c.json(detail) : toResponse({ kind: "not_found" });
	});

	return app;
}
