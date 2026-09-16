import { Box, type Key, Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
	type Cli,
	type CliDeps,
	type CliStatus,
	COMMANDS,
	createCli,
} from "../cli";
import { type Line, LineView, statusColor } from "./entries";

export interface LineState {
	value: string;
	history: string[];
	/** Posisi saat menelusuri riwayat; null = sedang mengetik baris baru. */
	index: number | null;
}

export const emptyLine: LineState = { value: "", history: [], index: null };

export function suggest(value: string) {
	const word = value.split(/\s/)[0] ?? "";
	if (!value.startsWith("/") || value.includes(" ")) return [];
	return COMMANDS.filter((c) => c.name.startsWith(word));
}

/** Reducer murni untuk prompt; `submit` terisi saat Enter. */
export function editLine(
	s: LineState,
	input: string,
	key: Partial<Key>,
): { state: LineState; submit?: string } {
	if (key.return) {
		const history =
			s.value.trim() && s.history.at(-1) !== s.value
				? [...s.history, s.value]
				: s.history;
		return { state: { value: "", history, index: null }, submit: s.value };
	}
	if (key.upArrow) {
		if (s.history.length === 0) return { state: s };
		const index =
			s.index === null ? s.history.length - 1 : Math.max(0, s.index - 1);
		return { state: { ...s, index, value: s.history[index] ?? "" } };
	}
	if (key.downArrow) {
		if (s.index === null) return { state: s };
		const index = s.index + 1;
		if (index >= s.history.length)
			return { state: { ...s, index: null, value: "" } };
		return { state: { ...s, index, value: s.history[index] ?? "" } };
	}
	if (key.tab) {
		const names = suggest(s.value).map((c) => c.name);
		if (names.length === 0) return { state: s };
		let prefix = names[0] ?? "";
		for (const n of names)
			while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
		const value = names.length === 1 ? `${prefix} ` : prefix;
		return {
			state: { ...s, value: value.length > s.value.length ? value : s.value },
		};
	}
	if (key.backspace || key.delete) {
		return { state: { ...s, value: s.value.slice(0, -1) } };
	}
	if (key.ctrl && input === "u") return { state: { ...s, value: "" } };
	if (key.ctrl || key.meta || key.escape || input === "") return { state: s };
	return { state: { ...s, value: s.value + input.replace(/[\r\n]+/g, " ") } };
}

type Item = { id: number; line: Line };

export interface AppProps {
	deps: Omit<CliDeps, "emit">;
	llm: string;
}

export function App({ deps, llm }: AppProps) {
	const { exit, waitUntilRenderFlush } = useApp();
	// Keluar setelah frame tanpa prompt tercetak, supaya layar akhir bersih.
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (done) waitUntilRenderFlush().then(() => exit());
	}, [done, exit, waitUntilRenderFlush]);
	const [items, setItems] = useState<Item[]>([
		{ id: 0, line: { kind: "banner", llm } },
	]);
	const [busy, setBusy] = useState(false);
	const [prompt, setPrompt] = useState(emptyLine);
	const promptRef = useRef(emptyLine);
	const queue = useRef(Promise.resolve());
	const quitting = useRef(false);
	const nextId = useRef(1);
	const push = (line: Line) =>
		setItems((prev) => [...prev, { id: nextId.current++, line }]);
	const cliRef = useRef<Cli | null>(null);
	cliRef.current ??= createCli({ ...deps, emit: push });
	const cli = cliRef.current;
	const [status, setStatus] = useState<CliStatus>(cli.status());

	async function run(text: string): Promise<boolean> {
		if (text.trim() === "") return true;
		push({ kind: "input", text: text.trim() });
		setBusy(true);
		try {
			return await cli.handle(text);
		} catch (e) {
			push({ kind: "fail", text: e instanceof Error ? e.message : String(e) });
			return true;
		} finally {
			setStatus(cli.status());
			setBusy(false);
		}
	}

	useInput(
		(input, key) => {
			// Ref, bukan state: ketikan cepat datang sebelum render berikutnya.
			const apply = (text: string, k: Partial<Key>) => {
				const { state, submit } = editLine(promptRef.current, text, k);
				promptRef.current = state;
				setPrompt(state);
				if (submit !== undefined) {
					// Berurutan: handle() tidak boleh jalan paralel untuk satu percakapan.
					queue.current = queue.current.then(async () => {
						if (quitting.current) return;
						if (!(await run(submit))) {
							quitting.current = true;
							setDone(true);
						}
					});
				}
			};
			if (key.return) return apply(input, key);
			// Paste atau ketikan cepat bisa membawa Enter di tengah satu chunk.
			input.split(/\r\n?|\n/).forEach((part, i) => {
				if (i > 0) apply("", { return: true });
				if (part) apply(part, key);
			});
		},
		{ isActive: !busy },
	);

	const hints = busy ? [] : suggest(prompt.value);

	return (
		<>
			<Static items={items}>
				{(item) => (
					<Box key={item.id} marginTop={item.line.kind === "input" ? 1 : 0}>
						<LineView line={item.line} />
					</Box>
				)}
			</Static>
			{!done && (
				<Box flexDirection="column" marginTop={1}>
					<Text>
						<Text color={statusColor(status.status)}>●</Text>{" "}
						<Text bold>{status.status ?? "belum ada percakapan"}</Text>
						{status.controlOwner && (
							<Text dimColor> · control_owner={status.controlOwner}</Text>
						)}
						<Text dimColor> · {status.chatId}</Text>
					</Text>
					{busy ? (
						<Text color="yellow">… memproses</Text>
					) : (
						<Text>
							<Text color="cyan" bold>
								❯{" "}
							</Text>
							{prompt.value}
							<Text inverse> </Text>
						</Text>
					)}
					{hints.map((c) => (
						<Text key={c.name}>
							{"  "}
							<Text color="cyan">{c.name.padEnd(10)}</Text>
							<Text dimColor>{("args" in c ? c.args : "").padEnd(4)}</Text>
							<Text dimColor>{c.desc}</Text>
						</Text>
					))}
				</Box>
			)}
		</>
	);
}
