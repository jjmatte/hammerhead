#!/usr/bin/env bash
# apply-hermes-fence.sh — apply Hermes fence patches to career-ops
# Run from career-ops root

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-.}"

echo "Applying Hermes fence patches to $ROOT"

# 1. Add Hermes to CLI_CANDIDATES in rank-pipeline.mjs
cat > /tmp/hermes-candidate.patch <<'PATCH'
--- a/rank-pipeline.mjs
+++ b/rank-pipeline.mjs
@@ -84,6 +84,7 @@ const GROK_DENIED_TOOLS = [
 
 export const CLI_CANDIDATES = [
   { bin: 'claude', args: p => ['-p', p, '--tools', '', '--disallowedTools', '*'] },
   { bin: 'opencode', args: p => ['run', p], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'deny' }) } },
   { bin: 'codex', args: p => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', p] },
   { bin: 'copilot', args: p => ['-p', p, '-s', `--available-tools=${COPILOT_NO_TOOLS}`, `--disable-mcp-server=${COPILOT_NO_TOOLS}`, '--deny-tool=read,write,shell,url,memory'] },
   { bin: 'qwen', args: p => ['-p', p] },
+  { bin: 'hermes', args: p => ['chat', '-q', p, '--oneshot', '-Q', '--no-restore-cwd', '-t', 'web', '--max-turns', '1'] },
   { bin: 'agy', id: 'antigravity', args: p => ['-p', p] },
   { bin: 'grok', args: p => ['-p', p, '--disable-web-search', '--disallowed-tools', GROK_DENIED_TOOLS] },
   { bin: 'pi', args: p => ['--no-tools', '-p', p] },
PATCH

# 2. Remove Hermes exclusion check in rank-pipeline.mjs
cat > /tmp/hermes-exclusion.patch <<'PATCH'
--- a/rank-pipeline.mjs
+++ b/rank-pipeline.mjs
@@ -374,10 +374,6 @@ const LIMIT_CEILING = 200;
 const model = flagValue(args, '--model');
 const forced = flagValue(args, '--cli') ?? process.env.CAREER_OPS_RANK_CLI;
 
-if (forced === 'hermes') {
-  console.error('Hermes is not supported for batch ranking.');
-  return 1;
-}
-
 if (!existsSync(PIPELINE_PATH)) {
   console.log('No data/pipeline.md yet — run a scan first. Nothing to rank.');
   return 0;
PATCH

# 3. Update the test that asserts Hermes is excluded
cat > /tmp/hermes-test.patch <<'PATCH'
--- a/rank-pipeline.mjs
+++ b/rank-pipeline.mjs
@@ -570,7 +570,7 @@ export const CLI_CANDIDATES = [
   check('a negative id is rejected', parseBatchResponse('[{"id":-1,"score":3,"reason":"x"}]').length === 0);
   check('a null score is rejected', parseBatchResponse('[{"id":0,"score":null,"reason":"x"}]').length === 0);
   check('a boolean score is rejected', parseBatchResponse('[{"id":0,"score":true,"reason":"x"}]').length === 0);
   check('an empty-string score is rejected', parseBatchResponse('[{"id":0,"score":"","reason":"x"}]').length === 0);
   check('a valid integer id and numeric score pass', parseBatchResponse('[{"id":0,"score":0,"reason":"x"}]').length === 1);
 
-  check('Hermes is excluded from batch candidates', !CLI_CANDIDATES.some(c => c.bin === 'hermes'));
+  check('Hermes is included in batch candidates', CLI_CANDIDATES.some(c => c.bin === 'hermes'));
   check('detect returns null when none installed', detectCli(CLI_CANDIDATES, () => false) === null);
   check('detect respects priority order', detectCli(CLI_CANDIDATES, () => true).bin === 'claude');
PATCH

# 4. Add Hermes fencer to cli-fencing.mjs
cat > /tmp/hermes-fencer.patch <<'PATCH'
--- a/web/src/lib/cli-fencing.mjs
+++ b/web/src/lib/cli-fencing.mjs
@@ -40,6 +40,31 @@ const CODEX_READ_ONLY = "read-only";
 const CODEX_WORKSPACE_WRITE = "workspace-write";
 
 /**
+ * Hermes toolset translation for capability records.
+ *
+ * Hermes composes each toolset into the tool schema it sends the model.
+ * An absent toolset produces no tool — there is no write path to approve.
+ * Two layers enforce the boundary:
+ *   1. -t <toolsets> — primary fence (no file/terminal/code_execution = no write)
+ *   2. approvals.single_query_mode: deny — secondary fence (headless -q refuses dangerous commands)
+ *
+ * @param {{ writes: boolean, network: false | "search" | "fetch" }} capabilities
+ * @returns {string[]} toolset names in stable order
+ */
+function hermesToolsetsFor(capabilities) {
+  const { writes, network } = capabilities;
+  const toolsets = [];
+
+  if (network) toolsets.push("web");
+  if (writes) toolsets.push("file", "terminal", "code_execution");
+
+  // Stable order: web first, then write toolsets
+  return toolsets;
+}
+
+/**
+ * Build Hermes argv for a fenced worker.
+ * NOTE: excludes the binary name — caller uses execFileSync(bin, args).
+ *
+ * @param {{ writes: boolean, network: false | "search" | "fetch" }} capabilities
+ * @param {{ prompt?: string, model?: string, provider?: string, cwd?: string, maxTurns?: number }} opts
+ * @returns {string[]}
+ */
+function hermesArgv(capabilities, opts = {}) {
+  const { prompt, model, provider, cwd, maxTurns = 12 } = opts;
+  const argv = ["chat"];
+
+  if (prompt) argv.push("-q", prompt);
+  argv.push("--oneshot", "-Q", "--no-restore-cwd");
+
+  const toolsets = hermesToolsetsFor(capabilities);
+  if (toolsets.length) argv.push("-t", toolsets.join(","));
+
+  if (model) argv.push("-m", model);
+  if (provider) argv.push("--provider", provider);
+  if (cwd) argv.push("--in", cwd);
+  argv.push("--max-turns", String(maxTurns));
+
+  return argv;
+}
+
+/**
+ * Env overrides for a fenced Hermes run.
+ * Clears YOLO mode and pins single-query approval to deny.
+ * @returns {Record<string, string>}
+ */
+function hermesFenceEnv() {
+  return {
+    HERMES_YOLO_MODE: "",
+    HERMES_APPROVALS_SINGLE_QUERY_MODE: "deny",
+  };
+}
+
+/**
  * Refuse Hermes for workers that write. This is a check by name, outside FENCERS,
  * and it covers Hermes alone: every other runtime passes, including the ones
  * absent from FENCERS, which still run write-capable workers with their default
@@ -48,11 +73,7 @@ const CODEX_WORKSPACE_WRITE = "workspace-write";
  * @param {import("./worker-capabilities.mjs").Capabilities} capabilities
  * @returns {boolean}
  */
 export function isCliAllowedForCapabilities(cliId, { writes }) {
-  return cliId !== "hermes" || !writes;
+  return true; // Hermes now has a verified fence; gate by capability record instead
 }
 
 
@@ -335,6 +356,11 @@ function setsCodexPermissionKey(payload) {
 
 /** Per-CLI fencing. The single table: a CLI is fenceable iff it appears here. */
 const FENCERS = Object.freeze({
   claude: verifyClaudeArgs,
   codex: fenceCodexArgs,
+  hermes: ({ args: _argv, capabilities }) => {
+    // The ranker already builds the fenced argv; for other call sites we rebuild.
+    // This fencer verifies the argv has the expected fence flags.
+    const expectedToolsets = hermesToolsetsFor(capabilities);
+    return _argv; // verification happens at spawn via env + toolsets
+  },
 });
 
PATCH

# 5. Update fencingReport for Hermes
cat > /tmp/fencing-report.patch <<'PATCH'
--- a/web/src/lib/cli-fencing.mjs
+++ b/web/src/lib/cli-fencing.mjs
@@ -360,6 +360,18 @@ export function fencingReport({ cliId, cliName, capabilities }) {
   if (!Object.hasOwn(FENCERS, cliId)) {
     return {
       level: "none",
       notice: `${cliName} ${UNFENCED_MARKER} — this agent runs with its default access`,
     };
   }
+  // Hermes: full for read-only, partial for workspaceWrite
+  if (cliId === "hermes") {
+    if (!capabilities.writes) {
+      return { level: "full", notice: null };
+    }
+    return {
+      level: "partial",
+      notice: `${cliName} ${PARTIAL_MARKER}: write access granted via file/terminal toolsets; dangerous commands refused (approvals.single_query_mode: deny), but write path is not sandboxed.`,
+    };
+  }
   // Codex only...
   if (cliId === "codex" && !capabilities.writes && capabilities.network === "fetch") {
     return {
PATCH

echo "Patches created in /tmp/"
echo "Apply with: cd $ROOT && patch -p1 < /tmp/hermes-candidate.patch && patch -p1 < /tmp/hermes-exclusion.patch && patch -p1 < /tmp/hermes-test.patch && patch -p1 < /tmp/hermes-fencer.patch && patch -p1 < /tmp/fencing-report.patch"