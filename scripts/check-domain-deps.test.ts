import { expect, test } from "bun:test";
import { importSpecifiers } from "./check-domain-deps";

test("menangkap semua bentuk import", () => {
	const src = `import { z } from "zod";
import type { Sql } from 'postgres';
import {
	readFile,
} from "node:fs/promises";
import "reflect-metadata";
export { DateTime } from "luxon";
export * from "./entity.ts";
const redis = await import("ioredis");
const pg = require("pg");`;
	expect(importSpecifiers(src)).toEqual([
		"zod",
		"postgres",
		"node:fs/promises",
		"reflect-metadata",
		"luxon",
		"./entity.ts",
		"ioredis",
		"pg",
	]);
});

test("pemanggilan bernama from/import bukan import", () => {
	const src = `export const a = Array.from("abc");
const b = Buffer.from('xyz');
export function f() { return Array.from("def"); }
const reimport = (s: string) => s;
reimport("nope");
// data diambil from 'cache'`;
	expect(importSpecifiers(src)).toEqual([]);
});
