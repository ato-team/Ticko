import { Secret } from "@ticko/domain";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { close, connect, type Db, type Tx } from "./db";

// Helper test integrasi (A-0.5). Hanya untuk test — diekspor lewat
// `@ticko/storage/testing` supaya pemakaiannya di kode produksi terlihat.
//
// Pola isolasi:
// - withTestDb(fn): transaksi yang selalu di-rollback. Default untuk test biasa.
// - createTestDb(): database baru hasil clone template yang sudah dimigrasi.
//   Untuk test yang butuh commit sungguhan dan banyak koneksi (SKIP LOCKED,
//   balapan). Wajib `drop()` di afterAll.
//
// ponytail: template dibuat ulang setiap proses test; dua `bun test` paralel di
// mesin yang sama akan bertabrakan. Beri nama template per proses kalau perlu.

const baseUrl =
	process.env.TICKO_TEST_DATABASE_URL ??
	"postgres://ticko:ticko@127.0.0.1:5432/ticko";
const TEMPLATE = "ticko_test_template";
const migrationsFolder = `${import.meta.dir}/../migrations`;

function urlFor(database: string): string {
	const u = new URL(baseUrl);
	u.pathname = `/${database}`;
	return u.toString();
}

async function withAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
	const sql = postgres(baseUrl, { max: 1, onnotice: () => {} });
	try {
		return await fn(sql);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

let template: Promise<void> | undefined;

function ensureTemplate(): Promise<void> {
	template ??= (async () => {
		await withAdmin(async (sql) => {
			// Sisa proses test sebelumnya yang mati sebelum drop().
			const stale = await sql<{ datname: string }[]>`
				SELECT datname FROM pg_database WHERE datname LIKE 'ticko\_test\_%'`;
			for (const { datname } of stale) {
				await sql`DROP DATABASE IF EXISTS ${sql(datname)} WITH (FORCE)`;
			}
			await sql`CREATE DATABASE ${sql(TEMPLATE)}`;
		});
		const client = postgres(urlFor(TEMPLATE), { max: 1, onnotice: () => {} });
		try {
			await migrate(drizzle(client), { migrationsFolder });
		} finally {
			await client.end({ timeout: 5 });
		}
	})();
	return template;
}

export async function createTestDb(): Promise<{
	db: Db;
	drop: () => Promise<void>;
}> {
	await ensureTemplate();
	const name = `ticko_test_${crypto.randomUUID().replaceAll("-", "")}`;
	await withAdmin(
		(sql) => sql`CREATE DATABASE ${sql(name)} TEMPLATE ${sql(TEMPLATE)}`,
	);
	const db = connect({ url: new Secret(urlFor(name)), maxConnections: 10 });
	return {
		db,
		drop: async () => {
			await close(db);
			await withAdmin(
				(sql) => sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`,
			);
		},
	};
}

class Rollback extends Error {}

let shared: Promise<Db> | undefined;

/** Menjalankan fn dalam transaksi yang selalu di-rollback. */
export async function withTestDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
	shared ??= createTestDb().then(({ db }) => db);
	const db = await shared;
	let result: { value: T } | undefined;
	try {
		await db.transaction(async (tx) => {
			result = { value: await fn(tx) };
			throw new Rollback();
		});
	} catch (e) {
		if (!(e instanceof Rollback)) throw e;
	}
	if (!result) throw new Error("withTestDb: transaksi tidak berjalan");
	return result.value;
}

/** Kode error Postgres (mis. `23514` check_violation) dari error Drizzle. */
export function pgErrorCode(e: unknown): string | null {
	const cause = e instanceof Error ? e.cause : undefined;
	if (typeof cause === "object" && cause !== null && "code" in cause) {
		return String(cause.code);
	}
	return null;
}
