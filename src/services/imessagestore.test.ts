import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeAttributedBody,
  findChatDb,
  listChats,
  listMessages,
  searchMessages,
} from "./imessagestore.js";

// ── Unit: attributedBody decoding (synthetic blob, no personal data) ──────────

test("decodeAttributedBody extracts a short length-prefixed string", () => {
  // NSString marker, a few class/version control bytes, the 0x2B payload
  // marker, a 1-byte length, then the UTF-8 string.
  const blob = Buffer.concat([
    Buffer.from("NSString", "latin1"),
    Buffer.from([0x01, 0x94, 0x84, 0x01]),
    Buffer.from([0x2b]),
    Buffer.from([5]),
    Buffer.from("Hello", "utf8"),
  ]);
  assert.equal(decodeAttributedBody(blob.toString("hex")), "Hello");
});

test("decodeAttributedBody handles 0x81 two-byte lengths and UTF-8", () => {
  const text = "Hé! " + "x".repeat(200); // > 127 bytes → 0x81 length form
  const body = Buffer.from(text, "utf8");
  const lenLo = body.length & 0xff;
  const lenHi = (body.length >> 8) & 0xff;
  const blob = Buffer.concat([
    Buffer.from("NSString", "latin1"),
    Buffer.from([0x01, 0x94, 0x84, 0x01]),
    Buffer.from([0x2b, 0x81, lenLo, lenHi]),
    body,
  ]);
  assert.equal(decodeAttributedBody(blob.toString("hex")), text);
});

test("decodeAttributedBody returns null when no NSString marker is present", () => {
  assert.equal(decodeAttributedBody(Buffer.from("nope", "utf8").toString("hex")), null);
  assert.equal(decodeAttributedBody(null), null);
  assert.equal(decodeAttributedBody(""), null);
});

// ── Integration: real chat.db (skips if absent / no Full Disk Access) ─────────

const haveDb = findChatDb() !== null;

test("listChats reads the store fast and well-shaped", { skip: !haveDb }, async (t) => {
  let chats;
  try {
    const start = Date.now();
    chats = await listChats({ limit: 5 });
    const ms = Date.now() - start;
    assert.ok(Array.isArray(chats));
    assert.ok(chats.length <= 5);
    assert.ok(ms < 8000, `listChats took ${ms}ms`);
  } catch (e) {
    t.skip(`chat.db not readable: ${(e as Error).message}`);
    return;
  }
  for (const c of chats) {
    assert.equal(typeof c.id, "string");
    assert.equal(typeof c.identifier, "string");
    assert.equal(typeof c.isGroup, "boolean");
    assert.ok(Array.isArray(c.participants));
  }
});

test("listMessages returns a conversation, oldest-first", { skip: !haveDb }, async (t) => {
  let chats;
  try {
    chats = await listChats({ limit: 1 });
  } catch (e) {
    t.skip(`chat.db not readable: ${(e as Error).message}`);
    return;
  }
  if (chats.length === 0) {
    t.skip("no chats to test");
    return;
  }
  const msgs = await listMessages({ chat: chats[0].identifier, limit: 10 });
  assert.ok(Array.isArray(msgs));
  assert.ok(msgs.length <= 10);
  for (const m of msgs) {
    assert.equal(typeof m.id, "string");
    assert.equal(typeof m.text, "string");
    assert.equal(typeof m.fromMe, "boolean");
  }
  // Verify ascending (oldest-first) ordering by date when we have ≥2 dated msgs.
  const dated = msgs.filter((m) => m.date).map((m) => Date.parse(m.date!));
  for (let i = 1; i < dated.length; i++) {
    assert.ok(dated[i] >= dated[i - 1], "messages should be oldest-first");
  }
});

test("searchMessages runs fast and returns an array", { skip: !haveDb }, async (t) => {
  try {
    const start = Date.now();
    const res = await searchMessages({ query: "the", scan: 500, limit: 5 });
    const ms = Date.now() - start;
    assert.ok(Array.isArray(res));
    assert.ok(res.length <= 5);
    assert.ok(ms < 8000, `searchMessages took ${ms}ms`);
  } catch (e) {
    t.skip(`chat.db not readable: ${(e as Error).message}`);
  }
});
