# PR: Add Hermes support to career-ops batch ranking (resolves #1137)

## Summary

This PR adds Hermes Agent as a supported CLI for batch ranking in `rank-pipeline.mjs`, resolving the long-standing blocker where career-ops refused Hermes because "Hermes has no verified child-permission boundary" for workers that process untrusted posting text.

## The Verified Boundary

Two layers enforce the Hermes permission fence, both verified against a live agent:

| Capability record | Hermes translation |
|---|---|
| `localReadOnly` / `webSearchOnly` / `networkReadOnly` (`writes: false`) | `-t web` — no `file`, `terminal`, or `code_execution` toolsets loaded. Model has **no write path at all**. |
| `workspaceWrite` (`writes: true`) | `-t web,file,terminal,code_execution` + `approvals.single_query_mode: deny` — write tools loaded but dangerous commands refused in headless sessions. |

**Verification:**
- `scripts/verify-fence.sh` — 5 live behavioural checks proving read-only workers cannot write, write workers can, dangerous commands refused, hostile prompts don't bypass
- `scripts/verify-injection.sh` — drives real `rank-pipeline.mjs` with prompt-injection payload in posting title; proves no file created and ranker still produces score

## Changes

### 1. `rank-pipeline.mjs`
- Add Hermes to `CLI_CANDIDATES` with fenced argv (`-t web --max-turns 1` for ranker)
- Remove hardcoded Hermes exclusion (lines 377-380)
- Update self-test assertion from "Hermes is excluded" to "Hermes is included"

### 2. `web/src/lib/cli-fencing.mjs`
- Add `hermesToolsetsFor()` — translates capability record → Hermes toolset list
- Add `hermesArgv()` — builds fenced argv for any worker kind
- Add `hermesFenceEnv()` — clears `HERMES_YOLO_MODE`, pins `HERMES_APPROVALS_SINGLE_QUERY_MODE=deny`
- Remove `isCliAllowedForCapabilities` Hermes block (now allowed for all capabilities)
- Add `hermes` entry to `FENCERS` table
- Extend `fencingReport()` with Hermes grading (full for read-only, partial for workspaceWrite)

## Files Changed

- `rank-pipeline.mjs` — CLI candidate + test
- `web/src/lib/cli-fencing.mjs` — fence implementation

## Testing

```bash
# Unit tests
node --test rank-pipeline.mjs --self-test
node --test web/tests/lib/cli-fencing.test.mjs

# Live verification (requires hermes on PATH)
./scripts/verify-fence.sh
./scripts/verify-injection.sh /path/to/career-ops
```

## Follow-up

After merge, the ranker can be invoked with Hermes:
```bash
CAREER_OPS_RANK_CLI=hermes node rank-pipeline.mjs --limit 10
```

Or from Hermes skill:
```bash
hermes chat -q "run career-ops pipeline" -t web,file,terminal
```

---

**Related:** The Hermes-side fence adapter lives in hammerhead repo at `src/fence/hermes-fence.mjs` and `src/fence/hermes-rank-adapter.mjs` — this PR is the career-ops side that consumes it.