import { Glob } from "bun";

// Hanya bentuk import yang sah: `from "x"` harus berada di statement
// import/export, dan `import(`/`require(` harus kata utuh — agar
// `Array.from("abc")` atau `Buffer.from('x')` tidak dianggap import.
const importRes = [
	/^\s*(?:import|export)\b[^'";]*?\bfrom\s*["']([^"']+)["']/gm,
	/^\s*import\s*["']([^"']+)["']/gm,
	/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g,
];

export function importSpecifiers(src: string): string[] {
	return importRes
		.flatMap((re) => [...src.matchAll(re)])
		.sort((a, b) => a.index - b.index)
		.map((m) => m[1] ?? "");
}

if (import.meta.main) await main();

async function main() {
	// domain hanya boleh bergantung pada luxon dan zod (Backlog A-0.1).
	const allowed = new Set(["luxon", "zod"]);
	const bad: string[] = [];

	const pkg = await Bun.file("packages/domain/package.json").json();
	for (const field of [
		"dependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		for (const dep of Object.keys(pkg[field] ?? {})) {
			if (!allowed.has(dep)) bad.push(`${field}: ${dep}`);
		}
	}

	// Workspace Bun meng-hoist node_modules, jadi import yang tidak terdaftar di
	// package.json tetap ter-resolve. Import di source juga harus diperiksa.
	for await (const file of new Glob(
		"packages/domain/{src,tests}/**/*.{ts,tsx,mts,cts}",
	).scan()) {
		const src = await Bun.file(file).text();
		for (const spec of importSpecifiers(src)) {
			if (spec.startsWith(".")) continue;
			if (file.includes("/tests/") && spec === "bun:test") continue;
			const name = spec.startsWith("@")
				? spec.split("/", 2).join("/")
				: spec.split("/")[0];
			if (!allowed.has(name ?? "")) bad.push(`${file}: ${spec}`);
		}
	}

	if (bad.length > 0) {
		console.error(
			`@ticko/domain punya dependensi terlarang:\n  ${bad.join("\n  ")}`,
		);
		process.exit(1);
	}
}
