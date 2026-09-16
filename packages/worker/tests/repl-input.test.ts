import { expect, test } from "bun:test";
import { editLine, emptyLine, type LineState } from "../src/ui/repl";

function type(s: LineState, text: string): LineState {
	return editLine(s, text, {}).state;
}

test("ketik, backspace, Enter mengirim dan masuk riwayat", () => {
	let s = type(emptyLine, "halo!");
	s = editLine(s, "", { backspace: true }).state;
	const r = editLine(s, "", { return: true });
	expect(r.submit).toBe("halo");
	expect(r.state).toEqual({ value: "", history: ["halo"], index: null });
});

test("↑/↓ menelusuri riwayat lalu kembali ke baris kosong", () => {
	let s: LineState = { value: "", history: ["a", "b"], index: null };
	s = editLine(s, "", { upArrow: true }).state;
	expect(s.value).toBe("b");
	s = editLine(s, "", { upArrow: true }).state;
	s = editLine(s, "", { upArrow: true }).state;
	expect(s.value).toBe("a");
	s = editLine(s, "", { downArrow: true }).state;
	expect(s.value).toBe("b");
	s = editLine(s, "", { downArrow: true }).state;
	expect(s).toMatchObject({ value: "", index: null });
});

test("Tab melengkapi perintah unik dan prefix bersama", () => {
	expect(editLine(type(emptyLine, "/ta"), "", { tab: true }).state.value).toBe(
		"/takeover ",
	);
	// /help dan /handback sama-sama diawali /h: tidak ada prefix lebih panjang.
	expect(editLine(type(emptyLine, "/h"), "", { tab: true }).state.value).toBe(
		"/h",
	);
	expect(editLine(type(emptyLine, "halo"), "", { tab: true }).state.value).toBe(
		"halo",
	);
});
