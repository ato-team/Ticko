import { expect, test } from "bun:test";
import type { Key } from "ink";
import {
	editLine,
	emptyLine,
	type LineState,
	searchMatch,
} from "../src/ui/line-editor";

/** Jalankan urutan tombol; string = ketikan, objek = [input, key]. */
function press(s: LineState, ...keys: (string | [string, Partial<Key>])[]) {
	let state = s;
	let last: ReturnType<typeof editLine> = { state };
	for (const k of keys) {
		last =
			typeof k === "string" ? editLine(state, k, {}) : editLine(state, ...k);
		state = last.state;
	}
	return last;
}

const ctrl = (c: string): [string, Partial<Key>] => [c, { ctrl: true }];
const meta = (c: string): [string, Partial<Key>] => [c, { meta: true }];
const k = (key: Partial<Key>): [string, Partial<Key>] => ["", key];
const typed = (value: string, cursor = value.length): LineState => ({
	...emptyLine,
	value,
	cursor,
});

test("ketik di tengah, backspace & delete mengikuti kursor", () => {
	let r = press(
		emptyLine,
		"hlo",
		k({ leftArrow: true }),
		k({ leftArrow: true }),
		"a",
	);
	expect(r.state).toMatchObject({ value: "halo", cursor: 2 });
	r = press(r.state, k({ backspace: true }));
	expect(r.state).toMatchObject({ value: "hlo", cursor: 1 });
	r = press(r.state, k({ delete: true }));
	expect(r.state).toMatchObject({ value: "ho", cursor: 1 });
	// Backspace di awal baris tidak melakukan apa-apa.
	expect(press(typed("ab", 0), k({ backspace: true })).state.value).toBe("ab");
});

test("Home/End, Ctrl+A/E, lompat kata dengan Ctrl/Alt", () => {
	const s = typed("kirim pesan sekarang");
	expect(press(s, ctrl("a")).state.cursor).toBe(0);
	expect(press(s, k({ home: true }), k({ end: true })).state.cursor).toBe(20);
	expect(press(s, meta("b")).state.cursor).toBe(12);
	expect(
		press(s, k({ leftArrow: true, ctrl: true }), meta("b")).state.cursor,
	).toBe(6);
	expect(press(typed("kirim pesan", 0), meta("f")).state.cursor).toBe(5);
	expect(
		press(typed("kirim pesan", 0), k({ rightArrow: true, meta: true })).state
			.cursor,
	).toBe(5);
});

test("potong kata/awal/akhir lalu tempel dengan Ctrl+Y", () => {
	let r = press(typed("halo apa kabar"), ctrl("w"));
	expect(r.state).toMatchObject({ value: "halo apa ", kill: "kabar" });
	r = press(r.state, ctrl("y"));
	expect(r.state.value).toBe("halo apa kabar");
	expect(press(typed("halo apa kabar", 5), ctrl("k")).state.value).toBe(
		"halo ",
	);
	expect(press(typed("halo apa kabar", 5), ctrl("u")).state.value).toBe(
		"apa kabar",
	);
	expect(press(typed("halo apa kabar", 4), meta("d")).state.value).toBe(
		"halo kabar",
	);
	expect(
		press(typed("halo apa"), k({ backspace: true, meta: true })).state.value,
	).toBe("halo ");
});

test("Enter mengirim, riwayat ↑/↓ menyimpan draft", () => {
	let r = press(
		emptyLine,
		"satu",
		k({ return: true }),
		"dua",
		k({ return: true }),
	);
	expect(r.submit).toBe("dua");
	r = press(r.state, "draf", k({ upArrow: true }));
	expect(r.state.value).toBe("dua");
	r = press(r.state, ctrl("p"));
	expect(r.state.value).toBe("satu");
	r = press(r.state, k({ downArrow: true }), ctrl("n"));
	expect(r.state).toMatchObject({ value: "draf", index: null });
});

test("Ctrl+R mencari riwayat, Ctrl+R lagi lebih lama, Enter mengirim", () => {
	const s: LineState = {
		...emptyLine,
		history: ["/msgs 5", "halo", "/msgs 20"],
	};
	let r = press(s, ctrl("r"), "msgs");
	expect(searchMatch(r.state)).toBe("/msgs 20");
	r = press(r.state, ctrl("r"));
	expect(searchMatch(r.state)).toBe("/msgs 5");
	// Tidak ada yang lebih lama: tetap di kecocokan terakhir.
	expect(searchMatch(press(r.state, ctrl("r")).state)).toBe("/msgs 5");
	expect(press(r.state, k({ return: true })).submit).toBe("/msgs 5");
	// Panah menerima hasil ke baris untuk diedit.
	expect(press(r.state, k({ end: true })).state).toMatchObject({
		value: "/msgs 5",
		search: null,
	});
	expect(press(r.state, k({ escape: true })).state).toMatchObject({
		value: "",
		search: null,
	});
});

test("Tab melengkapi, lalu membuka menu yang bisa diputar", () => {
	expect(press(typed("/ta"), k({ tab: true })).state.value).toBe("/takeover ");
	let r = press(typed("/h"), k({ tab: true }));
	expect(r.state).toMatchObject({ value: "/handback", menu: { index: 0 } });
	r = press(r.state, k({ tab: true }));
	expect(r.state.value).toBe("/help");
	r = press(r.state, k({ tab: true, shift: true }));
	expect(r.state.value).toBe("/handback");
	r = press(r.state, k({ downArrow: true }));
	expect(r.state.value).toBe("/help");
	expect(press(r.state, k({ escape: true })).state).toMatchObject({
		value: "/h",
		menu: null,
	});
	expect(press(typed("halo"), k({ tab: true })).state.value).toBe("halo");
});

test("Ctrl+C mengosongkan baris dulu, keluar di baris kosong; Ctrl+D & Ctrl+L", () => {
	const r = press(typed("halo"), ctrl("c"));
	expect(r).toMatchObject({ state: { value: "" } });
	expect(r.action).toBeUndefined();
	expect(press(r.state, ctrl("c")).action).toBe("exit");
	expect(press(emptyLine, ctrl("d")).action).toBe("exit");
	expect(press(typed("ab", 0), ctrl("d")).state.value).toBe("b");
	expect(press(typed("ab"), ctrl("l")).action).toBe("clear");
});

test("paste membuang karakter kontrol", () => {
	expect(press(emptyLine, "a\tb\x1bc").state.value).toBe("abc");
});
