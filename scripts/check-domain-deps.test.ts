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

test("import di komentar dan string bukan import", () => {
	const src = `export const n = 1
// data diambil from 'cache'
/*
 import pg from "pg" */
const s = "import x from 'instring'";
export type Foo = string;
export const o = { type: 1 };`;
	expect(importSpecifiers(src)).toEqual([]);
});

test("menangkap import yang tidak diawali baris baru", () => {
	const src = `import a from "./a"; import pg from "pg";
/* x */ import { S } from "postgres";
const t = await import(\`ioredis\`);`;
	expect(importSpecifiers(src)).toEqual(["./a", "pg", "postgres", "ioredis"]);
});

test("menangkap import yang hanya berisi tipe", () => {
	const src = `import type Def from "a";
import { type B, type C as D } from "b";
export type { E } from "c";
export type * from "d";
import type from "e";`;
	expect(importSpecifiers(src)).toEqual(["a", "b", "c", "d", "e"]);
});

test("JSX dihitung sebagai ketergantungan pada react", () => {
	expect(
		importSpecifiers(`import pg from "pg"; const x = <div />;`, "tsx"),
	).toEqual(["pg", "react/jsx-dev-runtime", "react"]);
});
