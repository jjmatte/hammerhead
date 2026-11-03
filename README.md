# hammerhead

Job-application automation research and building blocks for **Hermes Agent**.

This repo exists because of a question, not because of a product plan: *how do I
find jobs, decide which ones to apply for, and tailor a resume and cover letter
so it survives automated screening — using LLM models and my Hermes agent?*

- **[RESEARCH.md](RESEARCH.md)** — the findings. Job data sources, what ATS
  screening actually does, the open-source landscape, what Hermes contributes,
  and the gaps worth filling. Every claim is cited; 29 sources verified live on
  2026-11-03.
- **[PLAN.md](PLAN.md)** — the decision document. What to build, in what order,
  what to skip, and the five decisions that are yours to make.

## The short version

**A project that already does almost all of this exists, is MIT-licensed, and
is pushed daily: [`career-ops-hq/career-ops`](https://github.com/career-ops-hq/career-ops)
(~79.8k stars).** It has 130 job-source providers, a 1–5 fit rubric with a
"do not apply" bucket, ATS-tailored CV and cover-letter generation, an ATS
structural verifier, a fact gate that blocks fabricated claims, an application
tracker — and it already documents Hermes Agent integration.

So this repo is not a parallel pipeline. It holds the parts that are worth
building, and the evidence for why.

## What is here

| Path | What it is | Status |
|---|---|---|
| `src/fence/` | Translates a job-worker's capability record (`{writes, network}`) into Hermes' own permission vocabulary | 9 unit tests + 5 live behavioural checks, all passing |
| `src/sources/` | Job discovery from employer ATS board APIs (Greenhouse, Lever, Ashby, Workable) | 9 unit tests; 1,635 live postings fetched, zero errors |
| `src/tailor/` | Deterministic ATS structural verification, weighted from cited evidence | 14 unit tests; 32/32 passing overall |
| `scripts/` | Live verification of the fence and of prompt-injection resistance; a harness for the upstream PR | Executed and passing |
| `tests/` | Unit tests, no network required | 32 passing |

### The Hermes fence

career-ops refuses to use Hermes for write-capable workers or batch ranking,
because "there is no verified way to translate that record into Hermes' own
approval/sandbox controls" (`web/src/lib/cli-fencing.mjs`). This is that
translation — and it is verified against a running agent, not asserted:

- **`-t <toolsets>`** — Hermes composes each toolset into the tool schema it
  sends the model, so an absent toolset produces no tool at all. A read-only
  worker asked to write a file has no way to.
- **`approvals.single_query_mode: deny`** — Hermes' default for headless `-q`
  sessions. A dangerous command is refused, and the model is told no human is
  present to approve it.

Together those are an enforced boundary rather than a flag that merely looks
like one.

Verified end-to-end against the real `rank-pipeline.mjs`: with the adapter
wired in, Hermes scored 3 of 3 postings against a CV. A prompt-injection
payload planted in a posting title was recognised as an injection attempt
*and* could not create a file.

## Running it

```bash
npm test                                   # 32 unit tests, no network
./scripts/verify-fence.sh                  # 5 live checks against a running Hermes
./scripts/verify-injection.sh <co-path>    # untrusted posting text cannot write
```

Requires Node 22.13+ and a working Hermes install with a configured provider.

## Status

Nothing here is committed or published. The research is complete and the
building blocks are verified; **the plan in `PLAN.md` is the deliverable, and
Phase 1 of it (use career-ops for a day before building anything) may well
dissolve the rest.**

## Licence

MIT.
