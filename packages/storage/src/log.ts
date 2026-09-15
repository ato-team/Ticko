import pino from "pino";

// Logger JSON satu baris per entri (CONVENTIONS §7). Tinggal di storage karena
// ini paket IO terendah yang dipakai api, worker, dan agent; domain tidak boleh
// bergantung pada pino.
//
// Redaction hanya jaring pengaman: jangan log objek utuh yang bisa membawa
// field sensitif yang belum terdaftar di sini.
const REDACT = [
	"password",
	"passwordHash",
	"token",
	"botToken",
	"apiKey",
	"api_key",
	"secret",
	"webhookSecret",
	"authorization",
	"cookie",
].flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";
export type Logger = pino.Logger;

export function createLogger(
	level: LogLevel,
	destination?: pino.DestinationStream,
): Logger {
	return pino(
		{
			level,
			base: null,
			timestamp: pino.stdTimeFunctions.isoTime,
			formatters: { level: (label) => ({ level: label }) },
			redact: { paths: REDACT, censor: "[redacted]" },
		},
		destination,
	);
}
