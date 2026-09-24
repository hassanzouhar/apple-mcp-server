import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqlLiteral, readonlyUri, querySqlite } from "./sqlite.js";

test("sqlLiteral escapes strings, passes numbers, maps null", () => {
  assert.equal(sqlLiteral("plain"), "'plain'");
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral("'; DROP TABLE x; --"), "'''; DROP TABLE x; --'");
  assert.equal(sqlLiteral(42), "42");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(undefined), "NULL");
  assert.throws(() => sqlLiteral(Infinity));
});

test("readonlyUri encodes spaces and builds an immutable URI", () => {
  assert.equal(
    readonlyUri("/Users/x/Library/Mail/V10/MailData/Envelope Index"),
    "file:/Users/x/Library/Mail/V10/MailData/Envelope%20Index?mode=ro&immutable=1",
  );
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
