export {};

// domain hanya boleh bergantung pada luxon dan zod (Backlog A-0.1).
const allowed = new Set(["luxon", "zod"]);
const pkg = await Bun.file("packages/domain/package.json").json();
const bad = Object.keys(pkg.dependencies ?? {}).filter((d) => !allowed.has(d));
if (bad.length > 0) {
	console.error(`@ticko/domain punya dependensi terlarang: ${bad.join(", ")}`);
	process.exit(1);
}
