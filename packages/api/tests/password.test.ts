import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "..", "src", "lib", "password.ts");

function tsFilesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.isDirectory()) return tsFilesUnder(p);
		return e.name.endsWith(".ts") ? [p] : [];
	});
}

// AGENTS.md / B-1.7: Bun.password hanya boleh dipanggil dari lib/password.ts.
test("Bun.password tidak dipanggil di luar pembungkusnya", () => {
	const offenders = tsFilesUnder(join(import.meta.dir, "..", "src"))
		.filter((f) => f !== WRAPPER)
		.filter((f) => readFileSync(f, "utf8").includes("Bun.password"));
	expect(offenders).toEqual([]);
});
