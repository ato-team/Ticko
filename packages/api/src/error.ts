import { assertNever } from "@ticko/domain";

// Satu-satunya tempat error jadi respons HTTP (CONVENTIONS §3). Domain dan
// storage tidak tahu-menahu soal status code; mereka melempar/mengembalikan
// AppError, package ini yang memetakan ke JSON seragam.

export type AppError =
	| { kind: "unauthorized" }
	| { kind: "invalid_credentials" }
	| { kind: "not_found" }
	| { kind: "bad_request" }
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
		case "not_found":
			return json(404, "NOT_FOUND", "Tidak ditemukan");
		case "bad_request":
			return json(400, "BAD_REQUEST", "Parameter permintaan tidak valid");
		case "internal":
			return json(500, "INTERNAL", "Terjadi kesalahan");
		default:
			return assertNever(e);
	}
}
