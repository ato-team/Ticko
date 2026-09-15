// Satu-satunya tempat yang boleh memanggil Bun.password (AGENTS.md, B-1.7).
// Ditegakkan lewat test packages/api/tests/password.test.ts yang menggrep src/.
// argon2id: dipilih Bun sebagai default, tahan GPU cracking lebih baik dari bcrypt.

export function hashPassword(password: string): Promise<string> {
	return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPassword(
	password: string,
	hash: string,
): Promise<boolean> {
	return Bun.password.verify(password, hash);
}
