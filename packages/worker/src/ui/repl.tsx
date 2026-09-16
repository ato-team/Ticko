import { Box, type Key, Static, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import { type Cli, type CliDeps, type CliStatus, createCli } from "../cli";
import { type Line, LineView, statusColor } from "./entries";
import {
	editLine,
	emptyLine,
	type LineState,
	searchMatch,
	suggest,
} from "./line-editor";

type Item = { id: number; line: Line };

export interface AppProps {
	deps: Omit<CliDeps, "emit">;
	llm: string;
}

function Prompt({ s }: { s: LineState }) {
	if (s.search) {
		const match = searchMatch(s);
		return (
			<Text>
				<Text color="magenta" bold>
					cari riwayat
				</Text>
				<Text dimColor> `</Text>
				{s.search.query}
				<Text dimColor>`: </Text>
				{match ?? <Text dimColor>(tidak ada yang cocok)</Text>}
			</Text>
		);
	}
	return (
		<Text>
			<Text color="cyan" bold>
				❯{" "}
			</Text>
			{s.value.slice(0, s.cursor)}
			<Text inverse>{s.value[s.cursor] ?? " "}</Text>
			{s.value.slice(s.cursor + 1)}
		</Text>
	);
}

function Hints({ s }: { s: LineState }) {
	if (s.search) {
		return (
			<Text dimColor>Ctrl+R lebih lama · Enter kirim · → edit · Esc batal</Text>
		);
	}
	const commands = suggest(s.menu?.base ?? s.value);
	if (commands.length === 0) {
		return s.value ? null : (
			<Text dimColor>
				Tab lengkapi · ↑↓ riwayat · Ctrl+R cari · Ctrl+L bersihkan · Ctrl+C
				keluar · /help
			</Text>
		);
	}
	return (
		<Box flexDirection="column">
			{commands.map((c, i) => {
				const selected = s.menu?.index === i;
				return (
					<Text key={c.name}>
						<Text color="cyan">{selected ? "› " : "  "}</Text>
						<Text color="cyan" bold={selected} inverse={selected}>
							{c.name.padEnd(10)}
						</Text>
						<Text dimColor>
							{" "}
							{("args" in c ? c.args : "").padEnd(4)}
							{c.desc}
						</Text>
					</Text>
				);
			})}
		</Box>
	);
}

export function App({ deps, llm }: AppProps) {
	const { exit, waitUntilRenderFlush } = useApp();
	const { write } = useStdout();
	// Keluar setelah frame tanpa prompt tercetak, supaya layar akhir bersih.
	const [done, setDone] = useState(false);
	useEffect(() => {
		if (done) waitUntilRenderFlush().then(() => exit());
	}, [done, exit, waitUntilRenderFlush]);
	const [items, setItems] = useState<Item[]>([
		{ id: 0, line: { kind: "banner", llm } },
	]);
	const [prompt, setPrompt] = useState(emptyLine);
	const [pending, setPending] = useState(0);
	const [notice, setNotice] = useState<string | null>(null);
	// Ref, bukan state: ketikan cepat datang sebelum render berikutnya.
	const promptRef = useRef(emptyLine);
	const pendingRef = useRef(0);
	const queue = useRef(Promise.resolve());
	const quitting = useRef(false);
	const nextId = useRef(1);
	const push = (line: Line) =>
		setItems((prev) => [...prev, { id: nextId.current++, line }]);
	const cliRef = useRef<Cli | null>(null);
	cliRef.current ??= createCli({ ...deps, emit: push });
	const cli = cliRef.current;
	const [status, setStatus] = useState<CliStatus>(cli.status());

	const addPending = (n: number) => {
		pendingRef.current += n;
		setPending(pendingRef.current);
	};

	function quit() {
		// Tekan kedua, atau tidak ada yang berjalan: langsung keluar.
		if (quitting.current || pendingRef.current === 0) {
			quitting.current = true;
			return setDone(true);
		}
		quitting.current = true;
		setNotice("keluar setelah proses ini selesai · Ctrl+C lagi untuk paksa");
		queue.current.then(() => setDone(true));
	}

	function enqueue(text: string) {
		if (text.trim() === "") return;
		addPending(1);
		// Berurutan: handle() tidak boleh jalan paralel untuk satu percakapan.
		queue.current = queue.current.then(async () => {
			try {
				if (quitting.current) return;
				push({ kind: "input", text: text.trim() });
				if (!(await cli.handle(text))) quit();
			} catch (e) {
				push({
					kind: "fail",
					text: e instanceof Error ? e.message : String(e),
				});
			} finally {
				setStatus(cli.status());
				addPending(-1);
			}
		});
	}

	function apply(input: string, key: Partial<Key>) {
		const { state, submit, action } = editLine(promptRef.current, input, key);
		promptRef.current = state;
		setPrompt(state);
		if (!quitting.current) setNotice(null);
		if (submit !== undefined) enqueue(submit);
		if (action === "exit") quit();
		if (action === "clear") write("\x1b[2J\x1b[3J\x1b[H");
	}

	// Tetap aktif saat memproses: pengguna bisa mengetik duluan, Enter masuk antrean.
	useInput((input, key) => {
		// Tombol khusus (backspace, panah, Tab) datang dengan input kosong.
		if (key.return || !/[\r\n]/.test(input)) return apply(input, key);
		// Paste atau ketikan cepat bisa membawa Enter di tengah satu chunk.
		input.split(/\r\n?|\n/).forEach((part, i) => {
			if (i > 0) apply("", { return: true });
			if (part) apply(part, key);
		});
	});

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
						{pending > 0 && (
							<Text color="yellow">
								{" "}
								· … memproses{pending > 1 ? ` (+${pending - 1} antre)` : ""}
							</Text>
						)}
					</Text>
					<Prompt s={prompt} />
					{notice ? <Text color="yellow">{notice}</Text> : <Hints s={prompt} />}
				</Box>
			)}
		</>
	);
}
