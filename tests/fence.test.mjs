/**
 * Tests for hermes-fence.mjs.
 *
 * These are unit tests over the translation. The behavioural guarantees that
 * matter (a read-only worker really cannot write) are verified by the
 * integration script in `scripts/verify-fence.sh`, which drives a real Hermes
 * session and checks the filesystem afterwards.
 *
 * Run: node tests/fence.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  toolsetsFor,
  hermesArgv,
  fenceEnv,
  fencingReport,
} from "../src/fence/hermes-fence.mjs";

/** The four capability records career-ops defines. */
const CAPS = {
  localReadOnly: { writes: false, network: false },
  webSearchOnly: { writes: false, network: "search" },
  networkReadOnly: { writes: false, network: "fetch" },
  workspaceWrite: { writes: true, network: "fetch" },
};

test("read-only worker gets no write-capable toolset", () => {
  const toolsets = toolsetsFor(CAPS.localReadOnly);
  assert.ok(!toolsets.includes("file"), "file toolset must not be loaded");
  assert.ok(!toolsets.includes("terminal"), "terminal toolset must not be loaded");
  assert.ok(!toolsets.includes("code_execution"), "code_execution must not be loaded");
});

test("read-only worker that needs the web gets the web toolset", () => {
  for (const cap of [CAPS.webSearchOnly, CAPS.networkReadOnly]) {
    const toolsets = toolsetsFor(cap);
    assert.ok(toolsets.includes("web"), `web toolset expected for ${JSON.stringify(cap)}`);
    assert.ok(!toolsets.includes("file"));
    assert.ok(!toolsets.includes("terminal"));
  }
});

test("write worker gets file, terminal and code_execution", () => {
  const toolsets = toolsetsFor(CAPS.workspaceWrite);
  assert.ok(toolsets.includes("file"));
  assert.ok(toolsets.includes("terminal"));
  assert.ok(toolsets.includes("code_execution"));
  assert.ok(toolsets.includes("web"));
});

test("unknown capability shape fails closed to read-only", () => {
  // career-ops resolves an unrecognized kind to the least-capable record.
  // A malformed record must not be treated as writable.
  const toolsets = toolsetsFor({ writes: undefined, network: "fetch" });
  assert.ok(!toolsets.includes("file"));
  assert.ok(!toolsets.includes("terminal"));
});

test("argv carries the fence flags", () => {
  const argv = hermesArgv(CAPS.networkReadOnly, { prompt: "hello" });
  assert.equal(argv[0], "chat", "argv starts with the subcommand, not the binary");
  assert.ok(!argv.includes("hermes"), "the binary must not be repeated in argv");
  assert.ok(argv.includes("--oneshot"));
  assert.ok(argv.includes("-Q"));
  assert.ok(argv.includes("--no-restore-cwd"));

  const toolsetsIdx = argv.indexOf("-t");
  assert.ok(toolsetsIdx > -1, "-t must be present");
  const declared = argv[toolsetsIdx + 1].split(",");
  assert.deepEqual(declared, toolsetsFor(CAPS.networkReadOnly));
  assert.ok(!declared.includes("file"));
  assert.ok(!declared.includes("terminal"));
});

test("argv never carries --yolo", () => {
  for (const cap of Object.values(CAPS)) {
    const argv = hermesArgv(cap, { prompt: "x" });
    assert.ok(!argv.includes("--yolo"), "--yolo would defeat the approval fence");
  }
});

test("fence env clears YOLO mode and pins single-query approval to deny", () => {
  const env = fenceEnv();
  assert.equal(env.HERMES_YOLO_MODE, "");
  assert.equal(env.HERMES_APPROVALS_SINGLE_QUERY_MODE, "deny");
});

test("fencing report is full for read-only and partial for writers", () => {
  assert.equal(fencingReport(CAPS.localReadOnly).level, "full");
  assert.equal(fencingReport(CAPS.networkReadOnly).level, "full");
  assert.equal(fencingReport(CAPS.workspaceWrite).level, "partial");
  assert.ok(fencingReport(CAPS.workspaceWrite).notice);
});

test("toolsets are deterministic and stable across calls", () => {
  const a = toolsetsFor(CAPS.workspaceWrite);
  const b = toolsetsFor(CAPS.workspaceWrite);
  assert.deepEqual(a, b);
});
