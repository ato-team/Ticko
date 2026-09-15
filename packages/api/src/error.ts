import { assertNever } from "@ticko/domain";

// Satu-satunya tempat error jadi respons HTTP (CONVENTIONS §3). Domain dan
// storage tidak tahu-menahu soal status code; mereka melempar/mengembalikan
// AppError, package ini yang memetakan ke JSON seragam.

export type AppError =
	| { kind: "unauthorized" }
	| { kind: "invalid_credentials" }
	| { kind: "internal"; cause?: unknown };

function json(status: number, code: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export function toResponse(e: AppError): Response {
	switch (e.kind) {
		case "unauthorized":
			return json(401, "UNAUTHORIZED", "Silakan login");
		case "invalid_credentials":
			return json(401, "INVALID_CREDENTIALS", "Email atau password salah");
		case "internal":
			return json(500, "INTERNAL", "Terjadi kesalahan");
		default:
			return assertNever(e);
	}
}
