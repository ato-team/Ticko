import type { ConversationId, ConversationStatus, UserId } from "@ticko/domain";
import type { Executor } from "../db";
import type { Contact, Conversation } from "./index";

// Kontrak repo (AB-0.1): antarmuka saja, tanpa implementasi. Dipakai oleh
// fake in-memory (A-0.6) dan implementasi Drizzle sungguhan.

export type ConversationSummary = Pick<
	Conversation,
	"id" | "channel" | "status" | "controlOwner" | "lastInboundAt"
>;

export interface Page<T> {
	items: T[];
	page: number;
	pageSize: number;
	total: number;
}

export interface InboxFilter {
	status?: ConversationStatus;
	assignedUserId?: UserId;
	page?: number;
	pageSize?: number;
}

export type ClaimResult =
	| { ok: true; conversation: Conversation }
	| { ok: false; reason: "already_claimed" | "not_found" };

export type HandbackResult =
	| { ok: true }
	| { ok: false; reason: "not_found" | "not_assigned" };

export interface ConversationRepo {
	get(ex: Executor, id: ConversationId): Promise<Conversation | null>;
	listInbox(
		ex: Executor,
		filter: InboxFilter,
	): Promise<Page<ConversationSummary>>;
	claim(
		ex: Executor,
		id: ConversationId,
		userId: UserId,
		version: number,
	): Promise<ClaimResult>;
	handback(
		ex: Executor,
		id: ConversationId,
		userId: UserId,
		note: string,
	): Promise<HandbackResult>;
}

export interface ContactRepo {
	findOrCreateContact(
		ex: Executor,
		input: {
			channel: Contact["channel"];
			externalId: string;
			displayName: string | null;
		},
	): Promise<Contact>;
}
