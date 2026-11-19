import { test } from "node:test";
import assert from "node:assert/strict";

import { isoDateField, limitField, optionalIsoDateField, responseFormatField } from "./common.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import { ResponseFormat } from "../services/format.js";

test("limitField defaults and bounds", () => {
  assert.equal(limitField.parse(undefined), DEFAULT_LIMIT);
  assert.equal(limitField.parse(1), 1);
  assert.equal(limitField.parse(MAX_LIMIT), MAX_LIMIT);
  for (const bad of [0, -1, MAX_LIMIT + 1, 1.5, "5"]) {
    assert.ok(!limitField.safeParse(bad).success, String(bad));
  }
});

test("isoDateField accepts ISO dates/datetimes and rejects other formats", () => {
  for (const ok of [
    "2026-05-26",
    "2026-05-26T14:00",
    "2026-05-26T14:00:00",
    "2026-05-26T14:00:00.123",
    "2026-05-26T14:00:00Z",
    "2026-05-26T14:00:00+02:00",
    "2026-05-26T14:00:00-0500",
  ]) {
    assert.ok(isoDateField.safeParse(ok).success, ok);
  }
  for (const bad of [
    "26.05.2026",
    "2026/05/26",
    "tomorrow",
    "2026-5-26",
    "2026-05-26 14:00",
    "",
    "2026-02-30",
    "2026-13-45",
    "2026-05-26T25:00",
    "2026-05-26T14:60:00",
  ]) {
    assert.ok(!isoDateField.safeParse(bad).success, bad);
  }
});

test("optionalIsoDateField allows undefined but still validates", () => {
  assert.ok(optionalIsoDateField.safeParse(undefined).success);
  assert.ok(!optionalIsoDateField.safeParse("nope").success);
});

test("responseFormatField defaults to markdown and accepts json", () => {
  assert.equal(responseFormatField.parse(undefined), ResponseFormat.MARKDOWN);
  assert.equal(responseFormatField.parse("json"), ResponseFormat.JSON);
  assert.ok(!responseFormatField.safeParse("xml").success);
});
