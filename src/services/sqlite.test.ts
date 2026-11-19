import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { containsGlob, sqlLiteral, readonlyUri, querySqlite } from "./sqlite.js";

test("sqlLiteral escapes strings, passes numbers, maps null", () => {
  assert.equal(sqlLiteral("plain"), "'plain'");
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral("'; DROP TABLE x; --"), "'''; DROP TABLE x; --'");
  assert.equal(sqlLiteral(42), "42");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(undefined), "NULL");
  assert.throws(() => sqlLiteral(Infinity));
});

test("readonlyUri encodes spaces and only opts in to immutable", () => {
  const path = "/Users/x/Library/Mail/V10/MailData/Envelope Index";
  assert.equal(readonlyUri(path), "file:/Users/x/Library/Mail/V10/MailData/Envelope%20Index?mode=ro");
  assert.equal(
    readonlyUri(path, true),
    "file:/Users/x/Library/Mail/V10/MailData/Envelope%20Index?mode=ro&immutable=1",
  );
});

test("containsGlob folds non-ASCII case and escapes GLOB metacharacters", () => {
  assert.equal(containsGlob("Øy"), "*[øØ][yY]*");
  assert.equal(containsGlob("a*?["), "*[aA][*][?][[]*");
  assert.equal(containsGlob("ß1"), "*ß1*");
});

// Hermetic integration test: build a tiny db, query it through our wrapper.
let dir: string;
let dbPath: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "amcp-sqlite-"));
  dbPath = join(dir, "test.db");
  execFileSync("/usr/bin/sqlite3", [
    dbPath,
    "CREATE TABLE t(id INTEGER, name TEXT); " +
      "INSERT INTO t VALUES (1,'alice'),(2,'bob'),(3,'O''Brien');",
  ]);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("querySqlite returns parsed rows", async () => {
  const rows = await querySqlite<{ id: number; name: string }>(
    dbPath,
    "SELECT id, name FROM t ORDER BY id;",
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { id: 1, name: "alice" });
  assert.equal(rows[2].name, "O'Brien");
});

test("querySqlite returns [] for an empty result set", async () => {
  const rows = await querySqlite(dbPath, "SELECT * FROM t WHERE id = 999;");
  assert.deepEqual(rows, []);
});

test("querySqlite + sqlLiteral resists injection in a value", async () => {
  const evil = "'; DROP TABLE t; --";
  const rows = await querySqlite(
    dbPath,
    `SELECT count(*) AS n FROM t WHERE name = ${sqlLiteral(evil)};`,
  );
  assert.deepEqual(rows, [{ n: 0 }]);
  // Table still intact:
  const all = await querySqlite(dbPath, "SELECT count(*) AS n FROM t;");
  assert.equal((all[0] as { n: number }).n, 3);
});

test("querySqlite sees uncheckpointed WAL commits from a live writer", async () => {
  const walDb = join(dir, "live.db");
  const writer = spawn("/usr/bin/sqlite3", [walDb], { stdio: ["pipe", "pipe", "inherit"] });
  writer.stdin.write(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;" +
      "CREATE TABLE t(x); INSERT INTO t VALUES (1); SELECT 'ready';\n",
  );
  // Keep the writer alive: closing it would checkpoint the WAL into the main file.
  await new Promise<void>((resolve) => {
    let seen = "";
    writer.stdout.on("data", (chunk) => {
      seen += String(chunk);
      if (seen.includes("ready")) resolve();
    });
  });
  try {
    assert.deepEqual(await querySqlite(walDb, "SELECT count(*) AS n FROM t;"), [{ n: 1 }]);
  } finally {
    writer.kill();
    await once(writer, "close").catch(() => {});
  }
});

test("querySqlite keeps multi-byte characters intact across stdout chunks", async () => {
  const rows = await querySqlite<{ s: string }>(
    dbPath,
    "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 40000) SELECT 'æøå😀' AS s FROM c;",
  );
  assert.equal(rows.length, 40000);
  assert.ok(rows.every((r) => r.s === "æøå😀"));
});

test("containsGlob matches Norwegian letters in either case through SQLite", async () => {
  const lit = sqlLiteral(containsGlob("Østby"));
  const rows = await querySqlite<{ a: number; b: number; c: number }>(
    dbPath,
    `SELECT 'hei østby' GLOB ${lit} AS a, 'ØSTBY' GLOB ${lit} AS b, 'ostby' GLOB ${lit} AS c;`,
  );
  assert.deepEqual(rows, [{ a: 1, b: 1, c: 0 }]);
});
