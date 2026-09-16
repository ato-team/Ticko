import { Box, Text } from "ink";
import { COMMANDS, type Entry, formatCell, type Row } from "../cli";

export type Line =
	| Entry
	| { kind: "input"; text: string }
	| { kind: "banner"; llm: string };

export function statusColor(status: string | null): string {
	if (status === "bot_active") return "green";
	if (status === "human_active") return "yellow";
	return "gray";
}

const MAX_COL = 48;

export function Table({ title, rows }: { title: string; rows: Row[] }) {
	if (rows.length === 0) {
		return <Text dimColor> {title}: (belum ada data)</Text>;
	}
	const cols = Object.keys(rows[0] ?? {});
	const cells = rows.map((r) => cols.map((c) => formatCell(r[c])));
	const widths = cols.map((c, i) =>
		Math.min(
			MAX_COL,
			Math.max(c.length, ...cells.map((row) => row[i]?.length ?? 0)),
		),
	);
	const line = (values: string[], header = false) => (
		<Box>
			{values.map((v, i) => (
				<Box key={cols[i]} width={(widths[i] ?? 0) + 2} flexShrink={0}>
					<Text
						bold={header}
						{...(header
							? { color: "cyan" }
							: cols[i] === "status"
								? { color: statusColor(v) }
								: {})}
						wrap="truncate-end"
					>
						{v}
					</Text>
				</Box>
			))}
		</Box>
	);
	return (
		<Box
			flexDirection="column"
			alignSelf="flex-start"
			borderStyle="round"
			borderColor="gray"
			paddingX={1}
		>
			<Text dimColor>
				{title} · {rows.length} baris
			</Text>
			{line(
				cols.map((c) => c.toUpperCase()),
				true,
			)}
			{cells.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: baris statis, tidak diurutkan ulang
				<Box key={i}>{line(row)}</Box>
			))}
		</Box>
	);
}

function Kv({ title, row }: { title: string; row: Row }) {
	const width = Math.max(...Object.keys(row).map((k) => k.length));
	return (
		<Box
			flexDirection="column"
			alignSelf="flex-start"
			borderStyle="round"
			borderColor="gray"
			paddingX={1}
		>
			<Text dimColor>{title}</Text>
			{Object.entries(row).map(([k, v]) => (
				<Box key={k}>
					<Box width={width + 2} flexShrink={0}>
						<Text bold>{k}</Text>
					</Box>
					<Text {...(k === "status" ? { color: statusColor(String(v)) } : {})}>
						{k === "id" ? String(v) : formatCell(v)}
					</Text>
				</Box>
			))}
		</Box>
	);
}

const SHORTCUTS = [
	["Enter", "kirim (boleh saat memproses, masuk antrean)"],
	["Tab / Shift+Tab", "lengkapi perintah, putar pilihan menu"],
	["↑ ↓  Ctrl+P/N", "riwayat (atau pilih di menu)"],
	["Ctrl+R", "cari riwayat; Ctrl+R lagi untuk lebih lama"],
	["← →  Ctrl+B/F", "geser kursor"],
	["Ctrl/Alt+← →  Alt+B/F", "lompat per kata"],
	["Home End  Ctrl+A/E", "awal / akhir baris"],
	["Backspace  Delete", "hapus sebelum / di kursor"],
	["Ctrl+W  Alt+Backspace", "hapus kata sebelumnya"],
	["Alt+D", "hapus kata berikutnya"],
	["Ctrl+U  Ctrl+K", "hapus ke awal / ke akhir baris"],
	["Ctrl+Y", "tempel teks yang terakhir dihapus"],
	["Esc", "tutup menu / kosongkan baris"],
	["Ctrl+L", "bersihkan layar"],
	["Ctrl+C", "kosongkan baris; di baris kosong keluar"],
	["Ctrl+D", "keluar di baris kosong"],
] as const;

function Help() {
	const groups = [...new Set(COMMANDS.map((c) => c.group))];
	return (
		<Box
			flexDirection="column"
			alignSelf="flex-start"
			borderStyle="round"
			borderColor="gray"
			paddingX={1}
		>
			{groups.map((g) => (
				<Box key={g} flexDirection="column" marginBottom={1}>
					<Text bold>{g}</Text>
					{COMMANDS.filter((c) => c.group === g).map((c) => (
						<Box key={c.name}>
							<Box width={16} flexShrink={0}>
								<Text color="cyan">
									{c.name} {"args" in c ? c.args : ""}
								</Text>
							</Box>
							<Text dimColor>{c.desc}</Text>
						</Box>
					))}
				</Box>
			))}
			<Box flexDirection="column" marginBottom={1}>
				<Text bold>Keyboard</Text>
				{SHORTCUTS.map(([keys, desc]) => (
					<Box key={keys}>
						<Box width={24} flexShrink={0}>
							<Text color="cyan">{keys}</Text>
						</Box>
						<Text dimColor>{desc}</Text>
					</Box>
				))}
			</Box>
			<Text>Ketik teks biasa untuk mengirim pesan sebagai pelanggan.</Text>
		</Box>
	);
}

export function Banner({ llm }: { llm: string }) {
	return (
		<Box
			flexDirection="column"
			alignSelf="flex-start"
			borderStyle="round"
			borderColor="cyan"
			paddingX={1}
		>
			<Text>
				<Text bold color="cyan">
					Ticko CLI
				</Text>
				<Text dimColor> · LLM </Text>
				<Text>{llm}</Text>
			</Text>
			<Text color="yellow">
				⚠ Jangan jalankan `bun run worker` bersamaan: ia bisa mengambil job CLI.
			</Text>
			<Text dimColor>Ketik /help untuk daftar perintah.</Text>
		</Box>
	);
}

export function LineView({ line }: { line: Line }) {
	switch (line.kind) {
		case "banner":
			return <Banner llm={line.llm} />;
		case "input":
			return line.text.startsWith("/") ? (
				<Text color="magenta">❯ {line.text}</Text>
			) : (
				<Text>
					<Text color="cyan" bold>
						pelanggan ›{" "}
					</Text>
					{line.text}
				</Text>
			);
		case "bot":
			return (
				<Text>
					<Text color="green" bold>
						bot{"       "}›{" "}
					</Text>
					{line.text}
				</Text>
			);
		case "info":
			return <Text dimColor> {line.text}</Text>;
		case "ok":
			return <Text color="green"> ✓ {line.text}</Text>;
		case "fail":
			return <Text color="red"> ✗ {line.text}</Text>;
		case "help":
			return <Help />;
		case "kv":
			return <Kv title={line.title} row={line.row} />;
		case "table":
			return <Table title={line.title} rows={line.rows} />;
		case "summary":
			return (
				<Text>
					{"  "}
					<Text color={statusColor(line.status)}>●</Text>
					<Text dimColor>
						{" "}
						{line.status} ({line.controlOwner})
					</Text>
					{line.run && (
						<>
							<Text dimColor> · </Text>
							<Text color={line.run.ok ? "green" : "red"}>
								{line.run.ok ? "✓" : "✗"} run
							</Text>
							<Text dimColor>
								{" "}
								{line.run.tokensIn}→{line.run.tokensOut} tok · ${line.run.usd} ·{" "}
								{line.run.secs}s
							</Text>
							{line.run.error && <Text color="red"> ({line.run.error})</Text>}
						</>
					)}
					{line.job && (
						<Text color="yellow">
							{" "}
							· job {line.job.type} {line.job.status}: {line.job.error ?? "-"}
						</Text>
					)}
				</Text>
			);
	}
}
