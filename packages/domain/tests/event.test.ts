import { expect, test } from "bun:test";
import { DeskEvent, URGENCY_RANK } from "../src/event";

const conversationId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const messageId = "3fa85f64-5717-4562-b3fc-2c963f66afa7";
const userId = "3fa85f64-5717-4562-b3fc-2c963f66afa8";

test("message_received valid diterima", () => {
	expect(
		DeskEvent.safeParse({
			type: "message_received",
			conversationId,
			messageId,
		}).success,
	).toBe(true);
});

test("handoff_requested valid diterima", () => {
	expect(
		DeskEvent.safeParse({
			type: "handoff_requested",
			conversationId,
			urgency: "high",
		}).success,
	).toBe(true);
});

test("conversation_assigned valid diterima", () => {
	expect(
		DeskEvent.safeParse({
			type: "conversation_assigned",
			conversationId,
			userId,
		}).success,
	).toBe(true);
});

test("sla_breached valid diterima", () => {
	expect(
		DeskEvent.safeParse({ type: "sla_breached", conversationId }).success,
	).toBe(true);
});

test("status_changed valid diterima", () => {
	expect(
		DeskEvent.safeParse({
			type: "status_changed",
			conversationId,
			status: "human_active",
		}).success,
	).toBe(true);
});

test("type tidak dikenal ditolak", () => {
	expect(
		DeskEvent.safeParse({ type: "unknown_event", conversationId }).success,
	).toBe(false);
});

test("URGENCY_RANK: critical lebih tinggi dari low", () => {
	expect(URGENCY_RANK.critical).toBeGreaterThan(URGENCY_RANK.low);
});
