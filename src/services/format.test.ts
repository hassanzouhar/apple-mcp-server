import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ResponseFormat,
  buildResult,
  errorResult,
  describeError,
  clip,
  humanDate,
} from "./format.js";
import { OsaScriptError } from "./osascript.js";
import { CHARACTER_LIMIT } from "../constants.js";

test("clip truncates with ellipsis and passes short strings through", () => {
  assert.equal(clip("hello", 80), "hello");
  assert.equal(clip("", 80), "");
  assert.equal(clip(null), "");
  assert.equal(clip("abcdef", 4), "abc…");
});

test("humanDate renders ISO and degrades gracefully", () => {
  assert.equal(humanDate(null), "—");
  assert.equal(humanDate(undefined), "—");
  assert.equal(humanDate("not-a-date"), "not-a-date");
  assert.match(humanDate("2026-06-09T08:30:00Z"), /2026/);
});

test("buildResult returns markdown or JSON per format", () => {
  const md = buildResult(ResponseFormat.MARKDOWN, "# Title", { a: 1 });
  assert.equal(md.content[0].text, "# Title");
  assert.equal(md.structuredContent, undefined, "markdown must not send the data twice");

  const json = buildResult(ResponseFormat.JSON, "# Title", { a: 1 });
  assert.equal(json.content[0].text, JSON.stringify({ a: 1 }));
  assert.deepEqual(json.structuredContent, { a: 1 });
});

test("buildResult wraps non-object structured payloads", () => {
  const r = buildResult(ResponseFormat.JSON, "x", [1, 2, 3]);
  assert.deepEqual(r.structuredContent, { value: [1, 2, 3] });
});

test("oversized JSON stays parseable and within the limit", () => {
  const events = Array.from({ length: 2000 }, (_, i) => ({ id: i, summary: "x".repeat(50) }));
  const list = buildResult(ResponseFormat.JSON, "", { count: 2000, events });
  const parsed = JSON.parse(list.content[0].text);
  assert.ok(list.content[0].text.length <= CHARACTER_LIMIT);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.omitted_items, 2000 - parsed.events.length);
  assert.deepEqual(list.structuredContent, parsed);

  const mail = buildResult(ResponseFormat.JSON, "", { id: "1", content: "æ\n".repeat(40_000) });
  assert.ok(mail.content[0].text.length <= CHARACTER_LIMIT);
  assert.equal(JSON.parse(mail.content[0].text).truncated, true);
});

test("buildResult truncates oversized text with a hint", () => {
  const huge = "x".repeat(30_000);
  const r = buildResult(ResponseFormat.MARKDOWN, huge, { n: huge.length });
  assert.ok(r.content[0].text.length <= 25_000);
  assert.match(r.content[0].text, /Response truncated/);
});

test("errorResult sets isError and includes a hint", () => {
  const r = errorResult(new Error("boom"), "try again");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /boom/);
  assert.match(r.content[0].text, /try again/);
});

test("describeError translates the macOS authorization family", () => {
  const denied = new OsaScriptError(
    "x",
    "Error: Not authorized to send Apple events to Calendar.",
    1,
  );
  assert.match(describeError(denied), /macOS denied access/);

  const notRunning = new OsaScriptError("y", "Application isn't running.", 1);
  assert.match(describeError(notRunning), /not running/);

  assert.equal(describeError(new Error("plain")), "plain");
  assert.equal(describeError("stringy"), "stringy");
});
