import { Box, render, renderToString, Text, useApp } from "ink";
import { useEffect, useState } from "react";

export interface Step {
	label: string;
	/** String yang dikembalikan ditampilkan sebagai hasil langkah. */
	run: () => Promise<string | undefined>;
}

type State = "wait" | "run" | "ok" | "fail";

const MARK: Record<State, { icon: string; color: string }> = {
	wait: { icon: "○", color: "gray" },
	run: { icon: "…", color: "yellow" },
	ok: { icon: "✓", color: "green" },
	fail: { icon: "✗", color: "red" },
};

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function Steps({ title, steps }: { title: string; steps: Step[] }) {
	const { exit, waitUntilRenderFlush } = useApp();
	const [states, setStates] = useState<State[]>(steps.map(() => "wait"));
	const [notes, setNotes] = useState<(string | undefined)[]>([]);
	// Keluar lewat effect, supaya frame dengan status akhir sudah tercetak.
	const [result, setResult] = useState<"ok" | "fail" | null>(null);
	useEffect(() => {
		if (!result) return;
		waitUntilRenderFlush().then(() =>
			result === "ok" ? exit() : exit(new Error("langkah gagal")),
		);
	}, [result, exit, waitUntilRenderFlush]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: langkah dijalankan sekali saat mount
	useEffect(() => {
		const set = (i: number, s: State, note?: string) => {
			setStates((prev) => prev.map((v, j) => (j === i ? s : v)));
			setNotes((prev) => Object.assign([...prev], { [i]: note }));
		};
		(async () => {
			for (const [i, step] of steps.entries()) {
				set(i, "run");
				try {
					set(i, "ok", await step.run());
				} catch (e) {
					set(i, "fail", errorText(e));
					return setResult("fail");
				}
			}
			setResult("ok");
		})();
	}, []);

	return (
		<Box
			flexDirection="column"
			alignSelf="flex-start"
			borderStyle="round"
			borderColor="cyan"
			paddingX={1}
		>
			<Text bold color="cyan">
				{title}
			</Text>
			{steps.map((step, i) => {
				const state = states[i] ?? "wait";
				const note = notes[i];
				return (
					<Text key={step.label}>
						<Text color={MARK[state].color}>{MARK[state].icon}</Text>{" "}
						<Text dimColor={state === "wait"}>{step.label}</Text>
						{note && (
							<Text color={state === "fail" ? "red" : "gray"}> · {note}</Text>
						)}
					</Text>
				);
			})}
		</Box>
	);
}

/** Menjalankan langkah berurutan dengan tampilan progres; berhenti di kegagalan pertama. */
export async function runSteps(title: string, steps: Step[]): Promise<boolean> {
	const app = render(<Steps title={title} steps={steps} />);
	return app.waitUntilExit().then(
		() => true,
		() => false,
	);
}

export function printNotice(title: string, lines: string[]) {
	console.error(
		renderToString(
			<Box
				flexDirection="column"
				alignSelf="flex-start"
				borderStyle="round"
				borderColor="yellow"
				paddingX={1}
			>
				<Text bold color="yellow">
					{title}
				</Text>
				{lines.map((l) => (
					<Text key={l}>{l}</Text>
				))}
			</Box>,
		),
	);
}
