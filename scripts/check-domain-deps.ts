import { Glob } from "bun";

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
const importRe = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
for await (const file of new Glob(
	"packages/domain/{src,tests}/**/*.{ts,tsx,mts,cts}",
).scan()) {
	const src = await Bun.file(file).text();
	for (const [, spec = ""] of src.matchAll(importRe)) {
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
