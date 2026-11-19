import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { consolidatedShape, parseAction } from "./dispatch.js";

const Delete = z.object({ id: z.string().min(1), confirm: z.literal(true) }).strict();
const Create = z.object({ title: z.string(), limit: z.number().default(5) }).strict();

test("consolidatedShape keeps action required and makes every other field optional", () => {
  const action = z.enum(["create", "delete"]);
  const outer = z.object(consolidatedShape(action, [Delete, Create]));

  assert.ok(outer.safeParse({ action: "create" }).success);
  assert.ok(outer.safeParse({ action: "delete", id: "1" }).success);
  assert.ok(!outer.safeParse({}).success, "action must be required");
  assert.ok(!outer.safeParse({ action: "nope" }).success);
  assert.deepEqual(Object.keys(outer.shape).sort(), ["action", "confirm", "id", "limit", "title"]);
});

test("parseAction strips action and returns parsed data with defaults", () => {
  const out = parseAction(Create, { action: "create", title: "t" });
  assert.deepEqual(out, { title: "t", limit: 5 });
});

test("parseAction enforces required fields and the confirm literal", () => {
  assert.throws(() => parseAction(Delete, { action: "delete", id: "1" }), /confirm/);
  assert.throws(() => parseAction(Delete, { action: "delete", id: "1", confirm: false }), /confirm/);
  assert.throws(() => parseAction(Delete, { action: "delete", id: "1", confirm: "true" }), /confirm/);
  assert.throws(() => parseAction(Delete, { action: "delete", confirm: true }), /id/);
  assert.deepEqual(parseAction(Delete, { action: "delete", id: "1", confirm: true }), {
    id: "1",
    confirm: true,
  });
});

test("parseAction error names the action and rejects unknown keys (.strict)", () => {
  assert.throws(
    () => parseAction(Create, { action: "create", title: "t", bogus: 1 }),
    /Invalid parameters for action "create"/,
  );
});
