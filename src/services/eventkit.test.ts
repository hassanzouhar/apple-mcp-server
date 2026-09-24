import { test, before } from "node:test";
import assert from "node:assert/strict";

import { runHelper, isoDaysFromNow, EventKitError } from "./eventkit.js";

test("isoDaysFromNow returns a valid ISO string offset", () => {
  const now = Date.parse(isoDaysFromNow(0));
  const past = Date.parse(isoDaysFromNow(-10));
  const future = Date.parse(isoDaysFromNow(10));
  assert.ok(!Number.isNaN(now) && !Number.isNaN(past) && !Number.isNaN(future));
  assert.ok(past < now && now < future);
});

// ── Integration against the compiled helper (skips if unavailable/denied) ──

let helperOk = false;
let calendarsAuthorized = false;
let remindersAuthorized = false;

before(async () => {
  try {
    const status = await runHelper<{ events: number; reminders: number }>(
      "auth-status",
    );
    helperOk = true;
    // 3 = authorized (legacy), 4 = fullAccess (macOS 14+)
    calendarsAuthorized = status.events === 3 || status.events === 4;
    remindersAuthorized = status.reminders === 3 || status.reminders === 4;
  } catch (e) {
    if (!(e instanceof EventKitError)) throw e;
    helperOk = false;
  }
});

test("auth-status returns numeric statuses", async (t) => {
  if (!helperOk) {
    t.skip("eventkit-helper not built/available");
    return;
  }
  const status = await runHelper<{ events: number; reminders: number }>(
    "auth-status",
  );
  assert.equal(typeof status.events, "number");
  assert.equal(typeof status.reminders, "number");
});

test("list-calendars is fast and well-shaped", async (t) => {
  if (!helperOk || !calendarsAuthorized) {
    t.skip("calendars not authorized");
    return;
  }
  const start = Date.now();
  const cals = await runHelper<{ id: string; name: string }[]>("list-calendars");
  const ms = Date.now() - start;
  assert.ok(Array.isArray(cals));
  assert.ok(ms < 8000, `list-calendars took ${ms}ms`);
  for (const c of cals) {
    assert.equal(typeof c.id, "string");
    assert.equal(typeof c.name, "string");
  }
});

test("list-reminders today is fast", async (t) => {
  if (!helperOk || !remindersAuthorized) {
    t.skip("reminders not authorized");
    return;
  }
  const start = Date.now();
  const rems = await runHelper<unknown[]>("list-reminders", {
    includeCompleted: false,
    limit: 25,
  });
  const ms = Date.now() - start;
  assert.ok(Array.isArray(rems));
  assert.ok(ms < 8000, `list-reminders took ${ms}ms`);
});

// Opt-in write round-trip (mutates the real store). Enable with AMCP_TEST_WRITES=1.
test(
  "reminder write round-trip: create → read → complete → delete",
  { skip: process.env.AMCP_TEST_WRITES !== "1" },
  async (t) => {
    if (!helperOk || !remindersAuthorized) {
      t.skip("reminders not authorized");
      return;
    }
    const lists = await runHelper<{ id: string; name: string }[]>(
      "list-reminder-lists",
    );
    if (lists.length === 0) {
      t.skip("no reminder lists");
      return;
    }
    const listName = lists[0].name;
    const title = `amcp-test-${Date.now()}`;
    const created = await runHelper<{ id: string }>("create-reminder", {
      listName,
      name: title,
    });
    assert.ok(created.id);
    try {
      const found = await runHelper<{ id: string; name: string }[]>(
        "list-reminders",
        { query: title, includeCompleted: true, limit: 5 },
      );
      assert.ok(found.some((r) => r.id === created.id && r.name === title));
      const done = await runHelper<{ completed: boolean }>("complete-reminder", {
        id: created.id,
        completed: true,
      });
      assert.equal(done.completed, true);
    } finally {
      const del = await runHelper<{ deleted: boolean }>("delete-reminder", {
        id: created.id,
      });
      assert.equal(del.deleted, true);
    }
  },
);
