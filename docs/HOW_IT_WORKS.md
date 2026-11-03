# How It Works

Architecture, data flow, and module-by-module breakdown.

For *why* the repo exists and what to do next, see [`../README.md`](../README.md) and [`../PLAN.md`](../PLAN.md). For the evidence base, see [`../RESEARCH.md`](../RESEARCH.md).

---

## In one sentence

A small library that (1) finds jobs from employer ATS boards, (2) verifies a resume against a job description using a weighted, evidence-grounded ruleset, and (3) lets a Hermes agent touch untrusted job-description text without breaking the file system — with a real permission boundary instead of a flag that just looks like one.

## Architecture at a glance

```
              ┌──────────────────────────────────────────────────────────┐
              │                candidate + role profile                  │
              │         (master resume, JD criteria, target board list) │
              └──────────────────────────────────────────────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                        src/sources                            │
        │   fetchBoard({ats, slug, company}) -> JobPosting[]            │
        │   ─ Greenhouse / Lever / Ashby / Workable public APIs        │
        │   ─ 130 boards live-tested, zero LLM tokens                  │
        └───────────────────────────────────────────────────────────────┘
                                    │
                            JobPosting[] (full JD text)
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                       src/tailor                              │
        │   verify({text, raw}, job) -> {score, checks, notes}          │
        │   ─ 8 weighted checks, every rule traceable to a source       │
        │   ─ refuse to emit a fake "match percentage"                  │
        └───────────────────────────────────────────────────────────────┘
                                    │
                          {score, checks, missingTerms, notes}
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────────────────┐
        │                        src/fence                              │
        │   toolsetsFor({writes, network}) -> ["web"] | ["file",...]    │
        │   hermesArgv(...)           -> ["chat", "-q", prompt, "-t",…] │
        │   fenceEnv()                -> {HERMES_YOLO_MODE: ""}        │
        │                                                                  │
        │   The translation career-ops is missing for Hermes.             │
        │   Empirically verified end-to-end, not asserted.                 │
        └───────────────────────────────────────────────────────────────┘
                                    │
                            argv + env for hermes chat
                                    │
                                    ▼
                       Hermes (headless, read-only or write-capable)
```

## Data shapes

The three modules speak in three simple shapes. They were kept narrow so that
each piece is testable on its own and replaceable without ripples.

### `JobPosting` (sources → tailor → caller)

```js
{
  title:        string,           // "Senior Python Engineer"
  company:      string,           // "Acme, Inc."
  location:     string,           // "Remote - US"
  url:          string,           // the apply URL, exactly as the ATS stores it
  description:  string,           // full JD text, HTML stripped, in reading order
  tags:         string[],         // department / team / category, per ATS
  ats:          "greenhouse" | "lever" | "ashby" | "workable",
  postedAt?:    number,           // epoch ms when the board exposes it
  salary?:      string,           // raw display string from the board
}
```

The description is the highest-value field. Sources returns it as the ATS
stored it, not as a third-party paraphrase — because that stored text is
what a keyword matcher indexes, and that is what tailoring has to target.

### `Capabilities` (caller → fence)

```js
{
  writes:  boolean,               // may the worker modify files?
  network: false | "search" | "fetch"  // how it needs to reach the web
}
```

This is the same shape `career-ops` uses (`web/src/lib/worker-capabilities.mjs`)
so the fence is interchangeable with career-ops' own fence
(`web/src/lib/cli-fencing.mjs`).

### `VerifyResult` (tailor → caller)

```js
{
  score:         0..100,           // weighted sum; never a "match percentage"
  checks:        [{name, pass, weight, detail}],   // the 8 individual gates
  missingTerms:  string[],         // from the JD's exact terminology
  notes:         string[],         // what to change, with the source for each rule
}
```

The `notes` are the deliverable. Every note is a fix the candidate can make,
each one saying which evidence-backed rule it satisfies.

---

## Module 1 — `src/fence/` *(Hermes permission adapter)*

**Files:** `hermes-fence.mjs`, `hermes-rank-adapter.mjs`

**What it solves.** career-ops refuses to use Hermes for any write-capable
worker or for batch ranking, because there was no verified way to translate
a worker's capability record into Hermes' own approval/sandbox controls.
This module is that translation.

### The two fences

| Layer | Mechanism | Why it works |
|---|---|---|
| **Toolset restriction** | `-t <toolsets>` on `hermes chat` | Hermes composes each toolset into the tool schema it sends the model. An absent toolset produces no tool. A `-t web` worker asked to write a file has no file tool — the model *cannot* write. |
| **Headless approval** | `approvals.single_query_mode: deny` (Hermes' default for `-q`) | A dangerous shell command in a headless session is refused, and the model is told no human is there to approve it. The fence holds even when the model tries to route around it. |

Together those are an enforced boundary, not a flag that merely looks like
one. That distinction is what "verified" means here.

### Translation table

| `Capabilities` | Toolset list | Notes |
|---|---|---|
| `{writes: false, network: false}` | (none — agent runs without tools) | The fallback `web` is added so the worker can answer at all. |
| `{writes: false, network: "search" \| "fetch"}` | `["web"]` | Read-only. Cannot write. |
| `{writes: true, network: ...}` | `["code_execution", "file", "terminal", "web"]` | Plus `single_query_mode: deny`. |

### The career-ops adapter (`hermes-rank-adapter.mjs`)

`rank-pipeline.mjs` scores each pending posting in `data/pipeline.md` against
a candidate's CV. Its `CLI_CANDIDATES` is shaped as `{bin, args(prompt), env}`,
and the launcher calls `execFileSync(bin, args)`. The adapter returns a
`HERMES_RANK_CANDIDATE` entry that drops straight into that table — with
`networkReadOnly` (no write), the untrusted-content preamble, and the env
that clears YOLO mode.

**Empirically verified.** With the adapter wired in, the unmodified
`rank-pipeline.mjs` scored 3 of 3 postings against a real CV, and a
prompt-injection payload planted in a posting title was recognised as an
injection attempt and *could not* create a file.

### What it does NOT solve

- **Shell-level isolation.** A `-t file` worker still writes to the working
  directory. For "real" sandboxing, point Hermes at the Docker terminal
  backend (`terminal.backend: docker` in `~/.hermes/config.yaml`). The toolset
  fence removes the *capability* to write; the Docker backend constrains the
  *commands*. They compose, not substitute.
- **Out-of-process containment.** Anything that calls `terminal` tool with
  `--yolo` is unsafe. `fenceEnv()` clears `HERMES_YOLO_MODE` explicitly so a
  parent shell setting cannot defeat the fence.

---

## Module 2 — `src/sources/` *(ATS board fetcher)*

**File:** `ats-sources.mjs`

**What it solves.** The highest-signal input for tailoring is the JD text
the employer's own ATS ingested. Aggregator APIs paraphrase or truncate;
ATS board APIs return the original. This module is the integration layer
for four ATS families, all free, unauthenticated, and robots-permitted:

| ATS | Endpoint | Confirmed live |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | 200, 741 jobs (stripe), zero errors |
| Lever | `api.lever.co/v0/postings/{slug}?mode=json` | 200, 820 KB (spotify) |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | 200, 807 jobs (openai) |
| Workable | `apply.workable.com/api/v1/widget/accounts/{slug}?details=true` | 200 OK |

Workable's `robots.txt` carries the clearest explicit AI-input permission of
any host checked: `Content-Signal: search=yes, ai-input=yes, ai-train=no`
with an empty `Disallow`.

### The interface

```js
fetchBoard({ats: "greenhouse", slug: "stripe", company?: "Stripe"},
           {fetchJson: async (url, opts) => ...})
  -> JobPosting[]

fetchAllBoards([boards], ctx)
  -> {jobs: JobPosting[], errors: {board, error}[]}
```

`fetchAllBoards` is fan-out with **graceful failure**: one dead board does
not take down the run. That is the failure mode that kills pipelines
silently — Remotive's 10-job cap returns HTTP 200 and no warning, so an
assertion per fetch matters as much as the fetch itself.

`redirect: "error"` is passed explicitly to `fetchJson` so a hostile board
cannot bounce us at an internal address (SSRF via redirect).

`dedupe(jobs)` collapses cross-board duplicates by `(company, title, location)`.

### What it does NOT solve

- **LinkedIn / Indeed.** Deliberately excluded. Both platforms forbid using
  their data to train or fine-tune any third-party ML model, which is what
  a tailoring pipeline does. Add JobSpy for personal cross-checking if you
  must; do not commit it.
- **Workday, iCIMS, SmartRecruiters, etc.** career-ops has provider modules
  for these. Use them instead of writing new ones.
- **Rate limits.** Each ATS has its own; the `ctx.fetchJson` seam lets you
  inject rate-limiting, retry, and backoff per provider without changing
  the interface.

---

## Module 3 — `src/tailor/` *(ATS structural verifier)*

**File:** `ats-verify.mjs`

**What it solves.** The popular mental model — a robot reads your resume
and rejects you on keywords — is wrong in the ways that matter. What is
documented: Greenhouse names columned layouts, tables, graphics, and text
boxes as parse-failure causes. Workday says parse results "vary based on
resume format and order of words." A qualification stated only in the
summary is scored at 0.66 validity by LLM screeners versus 0.83 in the body
(Castleman et al., 2026). This module turns those into a deterministic
weighted score.

### What it checks

8 weighted checks, summing to 100:

| Check | Weight | Source |
|---|---|---|
| `parsesAsText` | 25 | (precondition) |
| `singleColumn` | 15 | Greenhouse, Textkernel |
| `contactInBody` | 15 | Greenhouse |
| `conventionalSections` | 10 | Greenhouse, Workday |
| `fullNames` | 5 | Greenhouse (legal suffixes, full titles) |
| `consistentDates` | 5 | Greenhouse, Jobscan |
| `requiredTerms` | 20 | HBS/Accenture Hidden Workers; Greenhouse Talent Filtering |
| `bodyPlacement` | 5 | Castleman et al. (summary-only is invisible) |

The weighting is **a statement of priorities, not a probability.** A parse
failure is fatal (25). A missing exact term is recoverable (20). A mixed
date format is a free fix (5). The weights encode how costly each failure
is.

### What it refuses to do

Emit a fake "match percentage" against a hypothetical ATS. No public tool
can see the employer's instance or the recruiter's saved filters. The
output is a structural-validity report (parses cleanly, single reading
order, contact fields extractable, required terms present, claims
quantified and body-located) — which is the highest-value automated check
in a tailoring pipeline.

### Term extraction

`extractRequiredTerms(jd)` is deliberately conservative:

- Pulls "5+ years of Python" → "Python" (skill, not duration)
- Pulls explicit requirement blocks (`Requirements:` …) across newlines
- Pulls inline requirement lists
- Strips soft-skill adjectives ("strong communication skills" is dropped —
  Castleman measured soft skills as the lowest-validity qualification type)
- Caps at 25 terms

A JD that yields 0 required terms is reported, not failed — some postings
are vague by design.

### Input contract

`verify({text, raw}, job)` — the verifier reads `raw` (the unnormalised
file bytes, used for column detection) AND `text` (the normalised reading
text). The split matters because column detection depends on internal
whitespace gaps, and `normalize()` collapses those.

---

## Verification scripts (`scripts/`)

These are the live-against-a-running-agent tests. The unit tests in
`tests/` check the *translation*; these check the *behaviour*.

| Script | What it proves |
|---|---|
| `verify-fence.sh` | A read-only worker cannot write. A write worker can write. `rm -rf` is refused in headless mode. A hostile prompt does not bypass the fence. |
| `verify-injection.sh` | A prompt-injection payload planted in a posting title cannot create a file when the real `rank-pipeline.mjs` runs with Hermes as the backend. |
| `patch-career-ops-hermes.py` | A test harness — applies the upstream PR that would land the fence in `career-ops`. Not a permanent patch. |

Run order: `npm test` (no network) → `scripts/verify-fence.sh` (live agent,
no network target) → `scripts/verify-injection.sh` (live agent + a
career-ops checkout).

---

## End-to-end flow, in practice

This is how the pieces fit together *if* you decide to ship beyond the
research. The repo deliberately stops at the boundary — *you* drive what
runs and when.

```
hermes cron create "0 7 * * *" "scan new jobs"
  --script src/scan.sh --no-agent
  ──> src/sources/fetchAllBoards  (zero LLM tokens)
  ──> writes jobs.json to the store

hermes cron create "0 8 * * *" "tailor top 5 jobs"
  --workdir ~/apps/hammerhead --skill tailor
  ──> src/tailor/verify against the candidate's CV
  ──> deliver: telegram  (top 5 + score + notes)

human (the user)
  ──> reads the Telegram digest
  ──> opens a posting
  ──> clicks "tailor this one"

hermes chat (in the hammerhead worktree, project skills trusted)
  ──> tailors the resume + cover letter against that JD
  ──> src/tailor/verify to confirm it now scores higher
  ──> src/fence/ ensures any LLM evaluation of untrusted JD text
        cannot reach the filesystem

human
  ──> reviews, edits, submits
```

The human-in-the-loop boundary is the integrity boundary. career-ops'
own rule is *"career-ops prepares, you decide. No session will submit an
application, send an email, or click anything on your behalf."* The
system above inherits that.

---

## How to extend

### Add a new ATS provider

1. Add a normalizer function in `src/sources/ats-sources.mjs` (the shape of
   `fromGreenhouse` is a template — takes raw JSON, returns `JobPosting`
   or `null`).
2. Add the endpoint to `boardUrl(ats, slug)`.
3. Add it to `fetchBoard` and `fetchAllBoards`.
4. Add a unit test in `tests/ats-sources.test.mjs` with a fixture JSON.
5. Update `SUPPORTED_JOB_BOARDS` (or whatever your config is).

### Add a new ATS check

1. Add the check function in `src/tailor/ats-verify.mjs`.
2. Give it a weight in `WEIGHTS` (sum stays 100).
3. Wire it into `verify()` with a `notes.push(...)` for failure cases
   that names the source.
4. Add unit tests in `tests/ats-verify.test.mjs`.

### Use the fence with a new worker

1. Declare a `Capabilities` record (`{writes, network}`).
2. Call `hermesArgv(capabilities, opts)` for the argv.
3. Spawn `hermes` with that argv + `fenceEnv()`.
4. Optionally add a check in the worker that calls
   `fencingReport(capabilities)` and logs the level.

### Use the fence inside `career-ops`

Apply `scripts/patch-career-ops-hermes.py` to a career-ops checkout to
see the proposed upstream PR. The same code, in module form, lands
`hermes-fence.mjs` as `web/src/lib/cli-fencing-hermes.mjs` in career-ops
plus a `HERMES_RANK_CANDIDATE` entry in `rank-pipeline.mjs`. This is the
contribution shape from `PLAN.md` Phase 2.

---

## Tests

```
npm test
```

32 unit tests, no network. They cover:

- 9 — fence translation (toolset mapping, argv shape, env defaults)
- 9 — source provider normalisation (one per family, plus dedupe, plus
      graceful failure)
- 14 — tailor verification (every check has at least one positive and
      one negative fixture, plus the term-extraction rules)

Run live checks against a configured Hermes with:

```
./scripts/verify-fence.sh
./scripts/verify-injection.sh /path/to/career-ops
```
