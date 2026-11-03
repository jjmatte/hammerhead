# Plan: Job-Application Automation with Hermes Agent

Companion to `RESEARCH.md`. This is the decision document: what to do, in what order, and what to skip.

---

## The decision in one paragraph

**Don't build the pipeline — use `career-ops` as the engine and build only the layers it structurally cannot provide.** It already does sourcing (130 providers), selection (1–5 rubric with a "do not apply" bucket), JD-driven tailoring, ATS verification, a fact gate, and tracking — MIT-licensed, pushed daily, with Hermes integration already documented. The one genuinely open, well-specified gap is that career-ops **refuses to use Hermes for write-capable workers and batch ranking**, because nobody had verified a permission boundary for Hermes. I verified one. That's the most defensible thing to contribute, and it came with a working end-to-end test.

---

## Three phases

### Phase 1 — Use it before you build it *(1 day)*

This phase may dissolve Phase 3. Do it first.

```bash
git clone https://github.com/career-ops-hq/career-ops.git
cd career-ops
npm install
```

Point Hermes at the checkout and trust its skill:

```bash
hermes skills trust          # one-time; project skills are not auto-loaded
hermes                        # start a session IN the checkout
```

Two things to get right:
- **Start a new chat after `cd`.** Project rules load once at session start.
- `hermes skills trust` is required. Without it the pipeline still works (the prompt files are ordinary files the agent can read), but you have to name the task yourself instead of letting the router pick it.

Configure `portals.yml` with your target employers using the ATS board endpoints (research §2), then run the **zero-token scan** — no LLM tokens, no cost:

```bash
node scan.mjs --dry-run --json     # preview
node scan.mjs --verify             # drop dead postings before they cost anything
```

Measured on 5 aggregator boards: **2,609 postings found, 498 duplicates removed, zero errors, zero LLM tokens.**

Then exercise the real workflow on 3–5 postings you would actually apply to:

| Ask | What happens |
|---|---|
| "evaluate this posting: <link>" | Full A–H evaluation against your CV, written to `reports/` |
| "tailor my resume for report 001" | CV aimed at that posting, rendered to PDF |
| "write a cover letter for #1" | Drafted from the evaluation report |
| "prep me for the interview for #1" | Interview plan with stories and questions |

**Go/no-go question after Phase 1:** is the generated resume + cover letter good enough that you'd send it? If yes, you may need only Phase 2. If no, find out *which* part fails — that's the actual gap to build.

---

### Phase 2 — Contribute the Hermes fencer *(1–2 days)*

career-ops will not use Hermes for write-capable workers or batch ranking:

> "Hermes stays out: rank prompts contain untrusted posting text and Hermes has no verified child-permission boundary." — `rank-pipeline.mjs`

> "career-ops has no verified way to translate that record into Hermes's own approval/sandbox controls." — `web/src/lib/cli-fencing.mjs`

**I have the missing boundary, and it is verified against a live agent:**

| Capability record | Hermes translation |
|---|---|
| `localReadOnly` | no write toolset loaded |
| `webSearchOnly` / `networkReadOnly` | `web` toolset only |
| `workspaceWrite` | `file`, `terminal`, `code_execution` + approval mode `deny` |

Two layers do the work:
1. **`-t <toolsets>`** — Hermes composes each toolset into the tool schema it sends the model. An absent toolset produces no tool, so there is no write path to approve. Verified: a read-only worker asked to write a file refused and no file appeared; a write worker did write.
2. **`approvals.single_query_mode: deny`** — Hermes's default for headless `-q` sessions. Verified: `rm -rf` on a directory was refused, and the model declined to route around the check.

Also verified end-to-end: with the adapter wired in, Hermes scored 3 of 3 postings through the real `rank-pipeline.mjs`; a prompt-injection payload planted in a posting title was recognized as an injection attempt *and* could not create a file.

**The PR** (against `career-ops-hq/career-ops`):
- `src/fence/hermes-fence.mjs` — the capability-record → toolset translation
- `src/fence/hermes-rank-adapter.mjs` — the `CLI_CANDIDATES` entry + untrusted-content preamble
- `tests/fence.test.mjs` — 9 unit tests over the translation
- `scripts/verify-fence.sh` — 5 live behavioural checks against a running agent
- `scripts/verify-injection.sh` — proves untrusted posting text cannot reach the filesystem

The upstream maintainer's stance in issue #1137 was: *"career-ops is AI-agnostic… if you hit a Hermes-specific snag, open an issue with the details and we'll help."* This is precisely that snag, with a solution.

Open the issue first; the PR follows.

---

### Phase 3 — Your own repo *(only after Phase 1's go/no-go)*

Build only what career-ops structurally cannot do. Four candidates, ranked:

#### 3.1 A deterministic, versioned selection model *(highest value)*

career-ops keeps its 1–5 rubric and "do not apply" bucket in **markdown mode files**, not in unit-tested code. Your requirement — *"select which ones I want to apply for"* — lives exactly here.

Shape: a model taking `(resume, job, comp, estimated_effort, strategic_value)` and returning a calibrated ranking with a defensible "do not apply" threshold, plus golden fixtures.

Deliverables: versioned rubric, golden fixture set, unit tests, a CLI that reads a job store and emits a ranked shortlist.

#### 3.2 ATS verification as a published contract

`verify-ats.mjs`, `ats-reader`, naavik's validator, and rendercv's empirical test each assert ATS-safety in isolation with ad-hoc rules. Nobody publishes a shared schema, and nobody closes `generate → parse back → score → auto-repair → regenerate until passing`.

`src/tailor/ats-verify.mjs` in this repo is a first implementation, weighted from the research (§3) — 8 checks, 32 passing tests, and it refuses to emit a fake match percentage.

Deliverables: a versioned JSON schema, a CI conformance suite, a closed repair loop with a score floor.

#### 3.3 An outcome-feedback instrument

Every tool ends at "resume produced / form filled." Nothing tracks `applied → viewed → screen → interview → offer` and feeds it back into the fit model — so the rubric can never be calibrated against reality.

Deliverables: outcome capture, tracker export, a calibration report showing which rubric signals predicted which outcomes.

#### 3.4 An ATS-first source ladder with a published provider contract

career-ops has the most complete source layer in existence (130 providers) but it's embedded in a JS repo with a bespoke `portals.yml` and no published provider API.

`src/sources/ats-sources.mjs` is a working instance: 4 ATS families, 9 unit tests, 1,635 live postings fetched in ~6 seconds with full JD text.

Deliverables: a documented provider interface, the priority ladder (API → RSS → HTML → browser), and per-provider attribution compliance.

---

## Architecture

```
cron (--script --no-agent)  →  zero-token scan + ATS fetch
                            →  writes jobs to the store
cron (--skill job-search)   →  score, rank, pick the top N
                            →  deliver to Telegram / Discord
webhook (--cron-job)        →  a new posting fires immediately,
                               not at the next tick
human                       →  selects which to apply for
tailor                      →  resume + cover letter, ATS-verified
human                       →  review, submit
```

**Human-in-the-loop is a requirement, not a politeness.** career-ops' own rule: *"career-ops prepares, you decide. No session will submit an application, send an email, or click anything on your behalf."*

That is also how you stay clear of the ToS problem: you are not scraping at scale and you are not auto-submitting. You are reading postings you chose to apply to.

**Hermes primitives to use**

| Need | Hermes feature |
|---|---|
| Poll on a schedule | `hermes cron create "0 7 * * *" "…" --script scan.sh --no-agent` (zero-token) |
| React to a new posting | `hermes webhook subscribe … --cron-job "<id>"` |
| Run the workflow | Project skill at `.hermes/skills/`, enabled by `hermes skills trust` |
| Distribute it | `hermes skills publish skills/x --to github --repo owner/repo` |
| Expose the tracker | MCP server via a portable plugin (`plugin.json` + `skills/*/SKILL.md` + `mcp.json`) |
| Fan out per posting | `delegate_task(tasks=[…])` — but process-local, not durable |
| Fill a portal with no API | `browser_exec` with `browser.use_real_profile` for logged-in sessions |

**Safety defaults**

```yaml
approvals:
  mode: smart
  single_query_mode: deny
  unattended_mode: deny
```

Plus: a dedicated application mailbox (never a personal inbox), outbound mail only after human confirmation, and the source of truth in your own store rather than Hermes memory.

---

## What to skip, and why

| Skip | Why |
|---|---|
| **Scraping LinkedIn / Indeed** | Indeed's ToS bans using its data to train or fine-tune any third-party ML model — exactly what a tailoring pipeline does. LinkedIn's UA §8.2 forbids scraping outright. Keep any such script local and uncommitted. |
| **Auto-submitting applications** | Breaches most ATS terms, and it's the step where the risk actually is. |
| **A "beat the ATS" score** | No public tool can see the employer's account or saved filters. Emit a structural-validity report instead. |
| **Keyword stuffing** | Documented to hurt: candidates who got interviews emphasized *fewer* skills. A resume that overclaims outlives the pipeline. |
| **Rebuilding career-ops** | It's MIT, pushed daily, 130 providers, and has the parts you were about to write. |
| **A "master resume" format from scratch** | srbhr/Resume-Matcher (Apache-2.0) already has a good master-resume + JD document model. Reuse the idea, not the code. |
| **pyresparser, open-resume, naavik** | GPL-3.0 / AGPL-3.0, and pyresparser is abandoned since 2019. A permissive-licensed project must avoid them. |

---

## Repository shape

```
.
├── RESEARCH.md                 ← this repo's evidence base
├── PLAN.md                     ← this file
├── src/
│   ├── fence/                  ← Hermes permission adapter (§6.1)
│   ├── sources/                ← ATS board providers (§6.5)
│   └── tailor/                 ← ATS structural verification (§6.3)
├── tests/                      ← unit tests, no network
├── scripts/                    ← live verification + upstream patch harness
└── .hermes/skills/             ← the workflow, installable by others
```

Ship as:
1. **A Hermes skill** — `hermes skills publish skills/job-search --to github --repo owner/repo`; users install with `hermes skills install owner/repo/skills/job-search`
2. **A portable Agent Plugins package** — `plugin.json` + `skills/*/SKILL.md` + `mcp.json`, installed via `hermes plugins install owner/repo --no-enable`

---

## Decisions you need to make

These change the work; they aren't mine to assume.

1. **US-only, or multi-market?** US tech is where ATS filtering matters most and where the ATS board APIs give clean coverage. Chinese (BOSS直聘, Liepin), Russian (hh.ru) and European boards are underserved and mostly MIT-licensed — real ground, but it multiplies the work.
2. **One person's job search, or a tool for others?** A public repo changes the legal posture ("personal non-commercial use" stops being a defense) and the license obligations.
3. **What is your role and target?** The selection model (§3.1) needs your archetypes. career-ops ships 8 golden fixtures for archetypes like "forward-deployed vs architect" — yours will differ.
4. **Which LLM?** The tailoring quality question is unresolved by my research. A/B the same posting through two models before committing to an engine.
5. **Resume format.** If yours is a .docx, structural changes are easy. If it's a designed .pdf, §6.3's repair loop is harder and a human-reviewed source document matters more.

---

## If you only do one thing

Clone career-ops, point Hermes at it, `hermes skills trust`, and run the scan. Then evaluate three postings you would genuinely apply to and read the output. That one afternoon tells you whether this project is about closing a gap or about polishing something that already works.
