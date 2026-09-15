import { ConfigError, loadAppConfig } from "@ticko/domain";
import { close, connect, createUser, findUserByEmail } from "@ticko/storage";
import { hashPassword } from "./lib/password";

// B-1.7: satu perintah untuk membuat user admin pertama.
// `bun run user:create-admin -- --email a@b.com --name "Nama Admin"`

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Prompt tanpa echo — password tidak pernah muncul di terminal/history.
 * Dalam TTY, tiap keystroke datang sebagai chunk terpisah; dari pipe (mis.
 * test atau `printf ... |`), seluruh input bisa datang dalam satu chunk —
 * jadi tiap chunk diiterasi per karakter, bukan diperlakukan sebagai satu unit.
 */
async function promptPassword(question: string): Promise<string> {
	process.stdout.write(question);
	return new Promise((resolve) => {
		const stdin = process.stdin;
		stdin.resume();
		stdin.setRawMode?.(true);
		let input = "";
		const finish = () => {
			stdin.setRawMode?.(false);
			stdin.pause();
			stdin.removeListener("data", onData);
			stdin.removeListener("end", finish);
			process.stdout.write("\n");
			resolve(input);
		};
		const onData = (chunk: Buffer) => {
			for (const c of chunk.toString("utf8")) {
				if (c === "\n" || c === "\r" || c === "") return finish();
				if (c === "") process.exit(1); // Ctrl+C
				if (c === "") {
					input = input.slice(0, -1); // backspace
					continue;
				}
				input += c;
			}
		};
		stdin.on("data", onData);
		stdin.on("end", finish); // pipe habis tanpa newline penutup
	});
}

const email = argValue("--email");
const displayName = argValue("--name");
if (!email || !displayName) {
	console.error(
		'pakai: bun run user:create-admin -- --email <email> --name "<nama>"',
	);
	process.exit(1);
}

const password = await promptPassword("Password: ");
if (password.length < 8) {
	console.error("password minimal 8 karakter");
	process.exit(1);
}

const config = await loadAppConfig().catch((e: unknown) => {
	if (e instanceof ConfigError) {
		console.error(e.message);
		process.exit(1);
	}
	throw e;
});

const db = connect(config.database);
try {
	if (await findUserByEmail(db, email)) {
		console.error(`user dengan email ${email} sudah ada`);
		process.exit(1);
	}
	await createUser(db, {
		email,
		passwordHash: await hashPassword(password),
		displayName,
		role: "admin",
	});
	console.log(`admin ${email} dibuat`);
} finally {
	await close(db);
}
