import { defineConfig } from "drizzle-kit";

// Hanya @rizaldiabyannata yang menjalankan `generate` (CONVENTIONS §1).
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema.ts",
	out: "./migrations",
	dbCredentials: {
		url:
			process.env.TICKO_DATABASE_URL ??
			"postgres://ticko:ticko@127.0.0.1:5432/ticko",
	},
});
