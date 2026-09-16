import type { Key } from "ink";
import { COMMANDS } from "../cli";

// Editor baris gaya readline (bash/zsh), murni tanpa terminal supaya bisa di-test.

export interface LineState {
	value: string;
	cursor: number;
	history: string[];
	/** Posisi saat menelusuri riwayat; null = sedang mengetik baris baru. */
	index: number | null;
	/** Baris yang sedang diketik sebelum ↑, dikembalikan saat ↓ melewati akhir. */
	draft: string;
	/** Teks terakhir yang dipotong (Ctrl+W/U/K, Alt+D), ditempel dengan Ctrl+Y. */
	kill: string;
	/** Ctrl+R: `skip` = lompati sekian kecocokan terbaru. */
	search: { query: string; skip: number } | null;
	/** Menu completion yang dibuka Tab saat ada beberapa perintah cocok. */
	menu: { base: string; index: number } | null;
}

export type Action = "exit" | "clear";

export interface EditResult {
	state: LineState;
	submit?: string;
	action?: Action;
}

export const emptyLine: LineState = {
	value: "",
	cursor: 0,
	history: [],
	index: null,
	draft: "",
	kill: "",
	search: null,
	menu: null,
};

export function suggest(value: string) {
	if (!value.startsWith("/") || /\s/.test(value)) return [];
	return COMMANDS.filter((c) => c.name.startsWith(value));
}

export function searchMatch(s: LineState): string | undefined {
	if (!s.search) return undefined;
	const { query, skip } = s.search;
	return s.history.filter((h) => h.includes(query)).reverse()[skip];
}

function wordLeft(v: string, c: number): number {
	let i = c;
	while (i > 0 && /\s/.test(v[i - 1] ?? "")) i--;
	while (i > 0 && !/\s/.test(v[i - 1] ?? "")) i--;
	return i;
}

function wordRight(v: string, c: number): number {
	let i = c;
	while (i < v.length && /\s/.test(v[i] ?? "")) i++;
	while (i < v.length && !/\s/.test(v[i] ?? "")) i++;
	return i;
}

const set = (
	s: LineState,
	value: string,
	cursor = value.length,
): LineState => ({
	...s,
	value,
	cursor,
	menu: null,
});

/** Potong value[from, to) ke kill buffer. */
function cut(s: LineState, from: number, to: number): LineState {
	if (from === to) return { ...s, menu: null };
	return {
		...set(s, s.value.slice(0, from) + s.value.slice(to), from),
		kill: s.value.slice(from, to),
	};
}

function recall(s: LineState, index: number | null): LineState {
	const value = index === null ? s.draft : (s.history[index] ?? "");
	return { ...set(s, value), index };
}

function submit(s: LineState, value: string): EditResult {
	const history =
		value.trim() && s.history.at(-1) !== value
			? [...s.history, value]
			: s.history;
	return { state: { ...emptyLine, history, kill: s.kill }, submit: value };
}

function editSearch(
	s: LineState,
	input: string,
	key: Partial<Key>,
): EditResult {
	const search = s.search ?? { query: "", skip: 0 };
	const match = searchMatch(s);
	const ctrl = (c: string) => key.ctrl === true && input === c;
	if (ctrl("r")) {
		const next = { ...search, skip: search.skip + 1 };
		return {
			state: searchMatch({ ...s, search: next }) ? { ...s, search: next } : s,
		};
	}
	if (key.escape || ctrl("g") || ctrl("c"))
		return { state: { ...s, search: null } };
	if (key.return)
		return match ? submit(s, match) : { state: { ...s, search: null } };
	if (key.backspace) {
		return {
			state: { ...s, search: { query: search.query.slice(0, -1), skip: 0 } },
		};
	}
	if (input && !key.ctrl && !key.meta && !key.tab) {
		return {
			state: { ...s, search: { query: search.query + input, skip: 0 } },
		};
	}
	// Tombol lain (panah, Tab, Ctrl+A/E, …): terima hasil ke baris lalu proses tombolnya.
	return editLine({ ...set(s, match ?? s.value), search: null }, input, key);
}

function complete(s: LineState, step: 1 | -1): LineState {
	if (s.menu) {
		const names = suggest(s.menu.base).map((c) => c.name);
		const index = (s.menu.index + step + names.length) % names.length;
		return { ...set(s, names[index] ?? s.value), menu: { ...s.menu, index } };
	}
	const names = suggest(s.value).map((c) => c.name);
	if (names.length === 0) return s;
	if (names.length === 1) return set(s, `${names[0]} `);
	let prefix = names[0] ?? "";
	for (const n of names)
		while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
	if (prefix.length > s.value.length) return set(s, prefix);
	const index = step === 1 ? 0 : names.length - 1;
	return { ...set(s, names[index] ?? s.value), menu: { base: s.value, index } };
}

/** Reducer prompt. `submit` terisi saat Enter, `action` untuk hal di luar baris. */
export function editLine(
	s: LineState,
	input: string,
	key: Partial<Key>,
): EditResult {
	if (s.search) return editSearch(s, input, key);
	const { value, cursor } = s;
	const ctrl = (c: string) => key.ctrl === true && input === c;
	const meta = (c: string) => key.meta === true && input === c;

	if (key.return) return submit(s, value);
	if (key.tab) return { state: complete(s, key.shift ? -1 : 1) };

	if (s.menu && (key.upArrow || key.downArrow)) {
		return { state: complete(s, key.upArrow ? -1 : 1) };
	}
	if (key.escape) {
		if (s.menu) return { state: set(s, s.menu.base) };
		return { state: set(s, "") };
	}

	if (ctrl("c"))
		return value ? { state: set(s, "") } : { state: s, action: "exit" };
	if (ctrl("d") && value === "") return { state: s, action: "exit" };
	if (ctrl("l")) return { state: s, action: "clear" };
	if (ctrl("r"))
		return { state: { ...s, menu: null, search: { query: "", skip: 0 } } };

	// Riwayat
	if (key.upArrow || ctrl("p")) {
		if (s.history.length === 0) return { state: s };
		const draft = s.index === null ? value : s.draft;
		const index =
			s.index === null ? s.history.length - 1 : Math.max(0, s.index - 1);
		return { state: recall({ ...s, draft }, index) };
	}
	if (key.downArrow || ctrl("n")) {
		if (s.index === null) return { state: s };
		const index = s.index + 1 < s.history.length ? s.index + 1 : null;
		return { state: recall(s, index) };
	}

	// Gerak kursor
	const move = (c: number): EditResult => ({
		state: { ...s, cursor: c, menu: null },
	});
	if ((key.leftArrow && (key.ctrl || key.meta)) || meta("b"))
		return move(wordLeft(value, cursor));
	if ((key.rightArrow && (key.ctrl || key.meta)) || meta("f"))
		return move(wordRight(value, cursor));
	if (key.leftArrow || ctrl("b")) return move(Math.max(0, cursor - 1));
	if (key.rightArrow || ctrl("f"))
		return move(Math.min(value.length, cursor + 1));
	if (key.home || ctrl("a")) return move(0);
	if (key.end || ctrl("e")) return move(value.length);

	// Hapus & potong
	if (key.backspace && key.meta)
		return { state: cut(s, wordLeft(value, cursor), cursor) };
	if (key.backspace) {
		if (cursor === 0) return { state: s };
		return {
			state: set(
				s,
				value.slice(0, cursor - 1) + value.slice(cursor),
				cursor - 1,
			),
		};
	}
	if (key.delete || ctrl("d")) {
		return {
			state: set(s, value.slice(0, cursor) + value.slice(cursor + 1), cursor),
		};
	}
	if (ctrl("w")) return { state: cut(s, wordLeft(value, cursor), cursor) };
	if (meta("d")) return { state: cut(s, cursor, wordRight(value, cursor)) };
	if (ctrl("u")) return { state: cut(s, 0, cursor) };
	if (ctrl("k")) return { state: cut(s, cursor, value.length) };
	if (ctrl("y")) {
		const v = value.slice(0, cursor) + s.kill + value.slice(cursor);
		return { state: set(s, v, cursor + s.kill.length) };
	}

	// Ketikan biasa (termasuk paste satu baris). Kombinasi Ctrl/Alt lain diabaikan.
	if (key.ctrl || key.meta) return { state: s };
	// biome-ignore lint/suspicious/noControlCharactersInRegex: buang karakter kontrol dari paste
	const text = input.replace(/[\x00-\x1f\x7f]/g, "");
	if (!text) return { state: s };
	const v = value.slice(0, cursor) + text + value.slice(cursor);
	return { state: { ...set(s, v, cursor + text.length), index: null } };
}
