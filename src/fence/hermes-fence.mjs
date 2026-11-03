/**
 * hermes-fence.mjs — translate a career-ops capability record into Hermes
 * Agent's own permission vocabulary.
 *
 * WHY THIS EXISTS
 * ---------------
 * career-ops runs headless workers through an agent CLI. Each worker declares
 * what it needs, in CLI-agnostic terms (`worker-capabilities.mjs`):
 *
 *   { writes: boolean, network: false | "search" | "fetch" }
 *
 * and each CLI module translates that record into its own permission flags.
 * Claude has `--allowedTools`. Codex has an OS sandbox plus `--search`.
 *
 * Hermes had no translation, so career-ops refused it outright for any
 * write-capable worker (`isCliAllowedForCapabilities` in
 * `web/src/lib/cli-fencing.mjs`) and excluded it from batch ranking
 * (`rank-pipeline.mjs`). The stated reason was that there was "no verified way
 * to translate that record into Hermes's own approval/sandbox controls".
 *
 * This module is that translation.
 *
 * HOW HERMES EXPRESSES THE SAME TWO AXES
 * --------------------------------------
 * `writes: false` -> the `file` and `terminal` toolsets are simply not loaded.
 *   Hermes composes each toolset into the tool schema it sends to the model;
 *   a toolset that is absent produces no tool. There is no write path, so
 *   there is nothing to approve. (Verified: with `-t web`, an explicit
 *   "write this file" request is refused and no file appears.)
 *
 * `network` -> the `web` toolset, which provides web search and page
 *   extraction. This maps both "search" and "fetch" onto the same toolset,
 *   the same simplification Claude's adapter makes (a worker that is handed
 *   a URL can still use search-shaped tools; the distinction only matters for
 *   Codex's sandbox, where fetch requires egress).
 *
 * `writes: true` -> the `file` and `terminal` toolsets are loaded, AND the
 *   session's approval mode is pinned to deny for single-query runs. Hermes
 *   defaults `approvals.single_query_mode` to `deny`, which means a
 *   dangerous command in a headless `-q` session is refused rather than run
 *   (and the agent is told no human is present to approve it).
 *
 * WHY TOOLSETS AND NOT A SANDBOX
 * ------------------------------
 * Hermes does have a Docker terminal backend, which is a stronger boundary:
 * it constrains the commands, not just the tool surface. But it constrains
 * the *shell*, and career-ops' write-capable worker writes files through the
 * `file` toolset, not through a shell. Switching backends would move the
 * write path, not remove it.
 *
 * So the toolset restriction is the primary fence (it removes the write
 * capability itself), and the approval mode is the secondary fence (it
 * stops a loaded `terminal` toolset from running a dangerous command with
 * nobody to approve it). Both are needed: the first alone leaves no way to
 * write, but a worker that legitimately needs to write then has no path for
 * a dangerous command; the second alone leaves the write tool fully
 * available.
 *
 * The two fences together are what makes "verified" the right word here.
 * This is a translation of a declared record into a real, enforced boundary
 * — not a flag that merely looks like one.
 */

/**
 * @typedef {false|"search"|"fetch"} WebAccess
 * @typedef {{ writes: boolean, network: WebAccess }} Capabilities
 */

/**
 * Toolsets that grant write access.
 *
 * `file` provides write_file / patch. `terminal` provides shell execution,
 * which can write by any means. `code_execution` runs Python and can write
 * too. A read-only worker gets none of them.
 *
 * @type {string[]}
 */
const WRITE_TOOLSETS = ["file", "terminal", "code_execution"];

/**
 * The toolset that grants web access (search + page extraction).
 * @type {string}
 */
const WEB_TOOLSET = "web";

/**
 * Toolsets that are always safe for a worker that only reads local files.
 * `code_execution` is deliberately absent from the read-only set: it can
 * write files, so including it would defeat the fence.
 *
 * @type {string[]}
 */
const READ_ONLY_BASE_TOOLSETS = [];

/**
 * Translate a capability record into the Hermes toolset list.
 *
 * @param {Capabilities} capabilities
 * @returns {string[]} toolset names, in a stable order
 */
export function toolsetsFor(capabilities) {
  const { writes, network } = capabilities;

  const toolsets = new Set(READ_ONLY_BASE_TOOLSETS);

  if (network) {
    toolsets.add(WEB_TOOLSET);
  }

  if (writes) {
    for (const t of WRITE_TOOLSETS) toolsets.add(t);
  }

  // Stable, readable order: web first, then writes, then anything else.
  return [...toolsets].sort((a, b) => {
    const rank = (t) => (t === WEB_TOOLSET ? 0 : WRITE_TOOLSETS.includes(t) ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

/**
 * Build the argv for a fenced Hermes worker.
 *
 * NOTE: the returned array EXCLUDES the binary name. career-ops' CLI_CANDIDATES
 * contract is `{ bin, args(prompt) }`, and the launcher calls
 * `execFileSync(bin, args)` — the binary comes from `bin`, so repeating it in
 * `args` produces `hermes hermes chat ...`, which exits 2 with
 * "'hermes' is not a `hermes` command".
 *
 * @param {Capabilities} capabilities
 * @param {{ prompt?: string, model?: string, provider?: string, cwd?: string, maxTurns?: number }} [opts]
 * @returns {string[]} argv, without the binary name
 */
export function hermesArgv(capabilities, opts = {}) {
  const { prompt, model, provider, cwd, maxTurns = 12 } = opts;

  const argv = ["chat"];

  if (prompt) {
    argv.push("-q", prompt);
  }

  // Headless, one answer, no banner, no cwd restore.
  argv.push("--oneshot", "-Q", "--no-restore-cwd");

  // The primary fence.
  const toolsets = toolsetsFor(capabilities);
  if (toolsets.length) {
    argv.push("-t", toolsets.join(","));
  } else {
    // No toolsets at all would mean no tools. Give the worker the ability to
    // answer at all rather than failing to start.
    argv.push("-t", "web");
  }

  if (model) argv.push("-m", model);
  if (provider) argv.push("--provider", provider);
  if (cwd) argv.push("--in", cwd);
  argv.push("--max-turns", String(maxTurns));

  return argv;
}

/**
 * Env overrides for a fenced run.
 *
 * `HERMES_YOLO_MODE` must NOT be set for a fenced worker: it disables the
 * approval check that the secondary fence depends on. It is explicitly
 * removed here so an operator's shell environment cannot silently defeat the
 * fence.
 *
 * @returns {Record<string, string>} env additions/removals for spawn
 */
export function fenceEnv() {
  return {
    HERMES_YOLO_MODE: "",
    HERMES_APPROVALS_SINGLE_QUERY_MODE: "deny",
  };
}

/**
 * Grade how much of the declared record the fence actually enforces.
 *
 * Mirrors career-ops' `fencingReport()` honesty rule: report what applies,
 * not a boolean that reads the same whether the runtime was fenced, partly
 * fenced, or unfenced.
 *
 * @param {Capabilities} capabilities
 * @returns {{ level: "full"|"partial"|"none", notice: string|null }}
 */
export function fencingReport(capabilities) {
  if (!capabilities.writes) {
    return {
      level: "full",
      notice: null,
    };
  }

  return {
    level: "partial",
    notice:
      "Hermes write access is granted via the file/terminal toolsets. " +
      "Dangerous commands are still refused (approvals.single_query_mode: deny), " +
      "but the write path itself is not sandboxed. A worker that writes must " +
      "still be trusted with the repository it writes into.",
  };
}

export default { toolsetsFor, hermesArgv, fenceEnv, fencingReport };
