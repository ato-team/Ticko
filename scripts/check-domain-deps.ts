import { Glob } from "bun";

// Parser Bun, bukan regex: komentar, string, dan beberapa statement dalam satu
// baris ditangani dengan benar. Kekurangannya, Bun membuang import yang hanya
// berisi tipe — padahal paket itu tetap harus ter-resolve. Jadi kata `type`
// dilepas dulu; teks di komentar/string ikut berubah tapi tetap diabaikan parser.
function dropTypeModifiers(src: string): string {
	return src
		.replace(/\bimport\s+type\b(?!\s+from\b)(?=\s*[\w$*{])/g, "import")
		.replace(/\bexport\s+type\b(?=\s*[{*])/g, "export")
		.replace(/([{,]\s*)type\s+(?=[\w$]+\s*(?:[,}]|as\b))/g, "$1");
}

export function importSpecifiers(
	src: string,
	loader: "ts" | "tsx" = "ts",
): string[] {
	return new Bun.Transpiler({ loader })
		.scanImports(dropTypeModifiers(src))
		.map((i) => i.path);
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
		"packages/domain/{src,tests}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
	).scan()) {
		const src = await Bun.file(file).text();
		const loader = /\.[jt]sx$/.test(file) ? "tsx" : "ts";
		for (const spec of importSpecifiers(src, loader)) {
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
