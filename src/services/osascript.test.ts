import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { OsaScriptError, runJxa, runOsascript } from "./osascript.js";

const macOnly = { skip: process.platform !== "darwin" };
const payload = {
  body: 'BODY_CANARY_9812 "quoted"\nline two\r\n日本語 🌍\u0000\u2028\u2029',
  bcc: ["BCC_CANARY_9812@example.invalid"],
  note: "NOTE_CANARY_9812 '); throw new Error('executed'); // \\ end",
};
const canaries = ["BODY_CANARY_9812", "BCC_CANARY_9812", "NOTE_CANARY_9812"];

test("private payload round-trips as data and is absent from child argv and environment", macOnly, async () => {
  const result = await runJxa<{
    input: typeof payload; argv: string[]; environment: Record<string, string>;
  }>({
    args: payload,
    script: `return {
      input: INPUT,
      argv: ObjC.deepUnwrap($.NSProcessInfo.processInfo.arguments),
      environment: ObjC.deepUnwrap($.NSProcessInfo.processInfo.environment)
    };`,
  });
  assert.deepEqual(result.input, payload);
  assert.deepEqual(result.argv, ["/usr/bin/osascript", "-l", "JavaScript", "-"]);
  for (const canary of canaries) {
    assert.ok(!JSON.stringify(result.argv).includes(canary));
    assert.ok(!JSON.stringify(result.environment).includes(canary));
  }
});

test("live macOS process inspection cannot see synthetic private payloads", macOnly, async () => {
  // A disposable script that touches no applications or personal data.
  const pending = runJxa({ args: payload, script: "delay(2); return INPUT;" });
  try {
    let pid: string | undefined;
    for (let attempt = 0; attempt < 40 && !pid; attempt++) {
      const processes = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
      pid = processes.split("\n").map(line => line.trim().split(/\s+/))
        .find(parts => parts[1] === String(process.pid) && parts[2] === "/usr/bin/osascript")?.[0];
      if (!pid) await delay(25);
    }
    assert.ok(pid, "fixture child must be visible during inspection");
    const inspection = execFileSync("/bin/ps", ["eww", "-p", pid, "-o", "command="], { encoding: "utf8" });
    assert.match(inspection, /osascript -l JavaScript -/);
    for (const canary of canaries) assert.ok(!inspection.includes(canary));
  } finally {
    assert.deepEqual(await pending, payload);
  }
});

test("private pipe handles large payloads and omitted arguments", macOnly, async () => {
  const large = { text: "quoted \" 🌍\n".repeat(100_000) };
  assert.deepEqual(await runJxa({ script: "return INPUT;", args: large }), large);
  assert.equal(await runJxa({ script: "return INPUT;" }), null);
});

test("script errors and timeouts still reject cleanly", macOnly, async () => {
  await assert.rejects(runJxa({ script: "throw new Error('fixture failure');" }), /fixture failure/);
  await assert.rejects(runJxa({ script: "delay(5);", timeoutMs: 100 }), /timed out/);
  // Exit before reading a payload larger than the pipe buffer.
  await assert.rejects(runOsascript("not valid javascript !!!", {
    argsJson: JSON.stringify({ body: "x".repeat(1_000_000) }),
  }), OsaScriptError);
});
