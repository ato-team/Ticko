import { expect, test } from "bun:test";
import { ChannelFailure } from "@ticko/domain";
import { MockChannelAdapter } from "../src/fake";

test("sendText mencatat pesan tanpa jaringan", async () => {
	const adapter = new MockChannelAdapter();
	const sent = await adapter.sendText("42", "halo");
	expect(adapter.sent).toEqual([{ ...sent, to: "42", text: "halo" }]);
});

test("failNext melempar ChannelFailure sekali lalu kembali normal", async () => {
	const adapter = new MockChannelAdapter();
	adapter.failNext = true;
	adapter.failWith = { kind: "rate_limited", retryAfterSeconds: 3 };

	const err = await adapter.sendText("42", "a").catch((e: unknown) => e);
	expect(err).toBeInstanceOf(ChannelFailure);
	expect(err instanceof ChannelFailure && err.error).toEqual({
		kind: "rate_limited",
		retryAfterSeconds: 3,
	});
	expect(adapter.sent).toHaveLength(0);

	await adapter.sendText("42", "b");
	expect(adapter.sent).toHaveLength(1);
});

test("freeFormAllowed mengendalikan supportsFreeForm", () => {
	const adapter = new MockChannelAdapter("whatsapp");
	expect(adapter.supportsFreeForm(null)).toBe(true);
	adapter.freeFormAllowed = false;
	expect(adapter.supportsFreeForm("2026-09-14T03:00:00Z")).toBe(false);
});
