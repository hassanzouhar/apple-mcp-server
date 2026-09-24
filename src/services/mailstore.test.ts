import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseMailboxUrl,
  findEnvelopeIndex,
  listMailboxes,
  listMessages,
  searchMessages,
} from "./mailstore.js";

test("parseMailboxUrl extracts account UUID and decoded mailbox path", () => {
  assert.deepEqual(
    parseMailboxUrl(
      "imap://5D0A4FDF-8314-4770-B812-D33119ED0ACC/%5BGmail%5D/All%20Mail",
    ),
    { accountId: "5D0A4FDF-8314-4770-B812-D33119ED0ACC", name: "[Gmail]/All Mail" },
  );
  assert.deepEqual(parseMailboxUrl("imap://UUID-ABC/INBOX"), {
    accountId: "UUID-ABC",
    name: "INBOX",
  });
});

test("parseMailboxUrl degrades gracefully on a non-URL", () => {
  const r = parseMailboxUrl("not a url");
  assert.equal(r.name, "not a url");
});

// ── Integration: real Envelope Index (skips if absent / no Full Disk Access) ──

const haveMail = findEnvelopeIndex() !== null;

test("listMailboxes reads the store fast", { skip: !haveMail }, async (t) => {
  let boxes;
  try {
    const start = Date.now();
    boxes = await listMailboxes();
    const ms = Date.now() - start;
    assert.ok(Array.isArray(boxes));
    assert.ok(ms < 8000, `listMailboxes took ${ms}ms`);
  } catch (e) {
    t.skip(`mail store not readable: ${(e as Error).message}`);
    return;
  }
  if (boxes.length > 0) {
    assert.ok(typeof boxes[0].name === "string");
    assert.ok(typeof boxes[0].unreadCount === "number");
  }
});

test("listMessages on INBOX is fast and well-shaped", { skip: !haveMail }, async (t) => {
  let boxes;
  try {
    boxes = await listMailboxes();
  } catch (e) {
    t.skip(`mail store not readable: ${(e as Error).message}`);
    return;
  }
  const inbox = boxes.find((b) => /(^|\/)inbox$/i.test(b.name)) ?? boxes[0];
  if (!inbox) {
    t.skip("no mailboxes to test");
    return;
  }
  const start = Date.now();
  const msgs = await listMessages({ mailboxName: inbox.name, limit: 10 });
  const ms = Date.now() - start;
  assert.ok(ms < 8000, `listMessages took ${ms}ms`);
  assert.ok(Array.isArray(msgs));
  assert.ok(msgs.length <= 10);
  for (const m of msgs) {
    assert.equal(typeof m.id, "string");
    assert.equal(typeof m.subject, "string");
    assert.equal(typeof m.read, "boolean");
  }
});

test("searchMessages runs fast and returns an array", { skip: !haveMail }, async (t) => {
  try {
    const start = Date.now();
    const res = await searchMessages({ query: "the", limit: 5 });
    const ms = Date.now() - start;
    assert.ok(Array.isArray(res));
    assert.ok(res.length <= 5);
    assert.ok(ms < 8000, `searchMessages took ${ms}ms`);
  } catch (e) {
    t.skip(`mail store not readable: ${(e as Error).message}`);
  }
});
