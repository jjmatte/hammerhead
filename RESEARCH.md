# Job-Application Automation: Research and Options

**Status:** research findings, verified 2026-11-03
**Scope:** options for finding jobs, selecting which to apply to, and tailoring a resume/cover letter to pass automated screening — with Hermes Agent as the orchestration layer.

Everything below was checked against live systems or primary sources on the date above. Where a claim could not be verified from a primary source, it says so.

---

## 1. The headline finding

**A project that already does almost exactly what you described exists, is MIT-licensed, and is actively maintained: `career-ops-hq/career-ops` (~79.8k stars, pushed daily).**[1]

It covers the full pipeline: 130 job-source provider modules across 86 documented boards, a 1–5 job-fit rubric with a "do not apply" bucket, ATS-tailored CV and cover-letter generation, an ATS structural verifier, a fact-verification gate that blocks fabricated claims, and an application tracker.[1][3]

It also **already documents Hermes Agent integration** — `docs/HERMES.md` ships in the repo.[2]

This changes the shape of the question. "How do I build this?" is really two questions:

1. **What does career-ops not do that I would want?** (answer below, §6)
2. **Is there something worth building that career-ops structurally cannot do?**

**My recommendation: do not build a parallel pipeline.** Use career-ops as the engine, and build the layer it explicitly refuses to build — a verified permission boundary for Hermes — plus your own selection model and outcome tracking. Details in §7.

### A note on the projects you'd expect to use

- **Auto_Jobs_Applier_AI / AIHawk is gone.** Its upstream was repurposed: `feder-cr/Auto_Jobs_Applier_AIHawk` now redirects to `feder-cr/invisible_dots`, an unrelated antidetect-browser product with 32.4k stars.[6] The ~50 forks have no upstream to pull fixes from. If a tutorial says "use Auto_Jobs_Applier_AI", it is describing dead code.
- **JobsApplier** is a closed-source commercial Chrome extension, not open source.
- **OpenJobs** is an agent-to-agent marketplace, a category mismatch.

---

## 2. Job data sources

### The tier that matters: employer ATS boards

A tailoring system needs the job description **as the employer's ATS ingested it** — that stored text is what a keyword matcher searches, not an aggregator's paraphrase.

All four of these were verified live today, with no key, no quota, and permissive `robots.txt`:

| ATS | Endpoint | Verified result |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | 200, 741 jobs (stripe)[7] |
| Lever | `api.lever.co/v0/postings/{slug}?mode=json` | 200, 820 KB (spotify)[9] |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | 200, 807 jobs (openai)[11] |
| Workable | `apply.workable.com/api/v1/widget/accounts/{slug}?details=true` | 200 OK |

Permission evidence:

- Greenhouse `robots.txt`: `Disallow: /embed/` — everything else allowed.[8]
- Lever `robots.txt`: `Allow: /` with `Crawl-delay: 1`.[10]
- Ashby: no restrictions.
- Workable: `Content-Signal: search=yes, ai-input=yes, ai-train=no`, empty `Disallow`.[12] **This is the clearest explicit AI-input permission of any host checked.**

A live run against four boards (Stripe, Netlify, OpenAI, Spotify) returned **1,635 postings with full JD text and zero errors**, in ~6 seconds, with no LLM tokens spent.

### Aggregators for breadth

| Source | Cost | Coverage | Constraint |
|---|---|---|---|
| **Himalayas** | Free, no key, MIT spec | 117,084 total / 56,828 US / 5,000 for "software engineer" | Must link back, credit Himalayas, and **not** pass the jobs to other job boards, aggregators, job search engines, Google Jobs or LinkedIn Jobs[13] |
| **Jobicy** | Free tier, no key | US-weighted 7-day window | Must credit with a direct source link; **polling must not exceed once per hour**[14] |
| **Arbeitnow** | Free, no key | EU-heavy, 300/page | Link-back requested; poor fit for US search |
| **The Muse** | Free w/ registration | ~413k, US-weighted, older skews | 500 req/hr keyless, 3,600/hr registered |
| **USAJobs** | Free key | US federal only | **Open license** — may be published and redistributed with attribution[13]-class terms |
| **Adzuna** | Free key | Broad UK/US | Terms explicitly permit "Personal job search"; commercial use needs a licence |
| **SerpAPI Google Jobs** | $25/mo (1,000 searches) | Best general US coverage | Buys a licensed proxy instead of scraping Indeed/LinkedIn |

### Sources to avoid

- **Remotive — widely recommended, effectively dead as an API.** The public endpoint returns **exactly 10 jobs and ignores `limit`, `offset` and `page`** — I verified this directly: `?limit=5`, `?limit=100&offset=100`, `?page=2` and `?limit=5&offset=10` all return the same 10 postings.[15] Its site advertises 131,873 jobs. This is the single biggest gap between popular advice and reality, and it fails *silently* — HTTP 200, no warning.
- **Jooble** — free tier is a 500-request **lifetime** quota, not monthly.
- **RemoteOK** — 99 postings, 8 US.

### What is not safe to publish

**Indeed** forbids automated access and additionally bans using its data "for the development, training, fine-tuning, or improvement of any third-party machine learning model" — which is exactly what a tailoring pipeline does with the JD text.[16] Its `robots.txt` disallows `/viewjob`, `/jobs`, `/advanced_search` and blocks GPTBot, ClaudeBot, anthropic-ai.

**LinkedIn's User Agreement §8.2** forbids "any other means or processes… to scrape or copy the Services," and its `robots.txt` disallows `/jobs-guest/` and `/api/jobPostings/jobs*`.[17]

On the legal question: *hiQ v. LinkedIn* (9th Cir. 2022) and *X Corp. v. Bright Data* (N.D. Cal. 2024) made CFAA criminal exposure low for **logged-out public data**. But those are CFAA holdings, not consent to breach contract — *hiQ* ended in a bilateral consent judgment and permanent injunction, and concerned member profiles, not job postings, which both platforms police most aggressively. Realistic exposure for a solo tool is a cease-and-desist, not prosecution.

**Practical rule:** keep LinkedIn/Indeed scraping in a local, uncommitted scratch script for cross-checking. The moment the repo is public, "personal non-commercial use" stops being a meaningful defense.

---

## 3. What ATS screening actually does

The popular mental model — a robot reads your resume and rejects you on keywords — is wrong in the ways that matter.

**The "75% of resumes are auto-rejected" figure is folklore.** It traces to a 2012 Computerworld article quoting a resume-optimization vendor, with no sample, no design, and no calculation.[22] It has been repeated for fourteen years and never became measurement.

**Real filtering exists, and it is exactness-based.** The HBS/Accenture "Hidden Workers" study (2,250 executives) found >90% of employers use their system to filter or rank candidates, and **88% say qualified high-skill candidates get vetted out because they do not match the exact criteria in the job description** (94% for middle-skill roles).[18]

**Neither vendor auto-rejects on resume text.** Greenhouse: "Talent Matching is assistive AI, not automated-decision-making. It does not automatically advance or reject candidates." Workday: "Workday AI does not make hiring decisions."

**Where auto-rejection actually comes from: application-form answers.** Greenhouse's auto-reject "uses custom application questions to screen and reject candidates based on their responses," configurable only on Yes/No, Single-select, and Multi-select questions.

**The ground is shifting to LLM screening, and it changes the rules.** Princeton (Castleman et al., arXiv 2602.18550) built 1,202 ground-truth-ordered resume pairs from 186 live Greenhouse job descriptions and measured 9 LLMs. Claude Sonnet 4 reached 0.96 criterion validity.[19] Three findings that matter directly:

1. **A qualification stated only in the summary is close to invisible.** Criterion validity was **0.66 for "Summary Only" placement versus 0.83 "Body"**, with a 21% high-consensus error rate for summary-only placement. Soft skills scored lowest of all qualification types (0.81); education scored 0.85.[19]
2. **Presentation changes alone flip decisions.** Chen & Xiao (arXiv 2609.16517) held competence fixed and varied only presentation: the best LLM screener **reversed 29.6% of matched pairwise decisions**, another 41.4%, another 45.6%.[20] "Tightening" a resume is not a neutral act.
3. **LLMs favor their own output** — 67–82% preference, with same-model candidates 23–60% more likely to be shortlisted.

### Rules that follow (each traceable to a source)

**Structure — a failed parse loses everything.**
- One column, top to bottom. No tables, text boxes, sidebars, graphics, icons, charts, skill bars, photos, or decorative dividers. Greenhouse names columned layouts, tables, graphics and text boxes as parse-failure causes; Textkernel calls column layouts "a surprisingly difficult computer vision problem."[21]
- Name, email, phone, location, LinkedIn URL **in the document body** as the first lines. Greenhouse lists "the name and contact information in the header, footer, or text box" as a formatting cause of failed/partial parses.
- Conventional section labels only (Summary, Experience, Education, Skills, Certifications, Projects). Workday: parse results "can vary based on resume format and order of words."
- Company names legally ("Acme, Inc.", "X LLC") and titles in full ("Senior Account Executive", not "Sr. Account Exec"). Both are documented Greenhouse parse causes, and both are free, lossless fixes.
- One consistent date format, spelled out. Never "Jan '21". Recruiters filter on years of experience, so an unparseable date silently zeroes that filter.
- Never export as a flattened image. Lever "cannot parse information from image files"; Ashby ignores image files; SmartRecruiters returns `UNPARSABLE_RESUME`.

**Content — echo the posting's exact terminology.**
- Use the employer's string: "PostgreSQL," not "relational databases." Greenhouse Talent Filtering requires exact match.[21]
- Mirror noun phrases, not just tokens: "incident response," not "handled outages."
- Include both acronym and expansion once ("Kubernetes (K8s)") so literal *and* semantic matchers hit.
- **Do not keyword-stuff.** Huntr's data shows candidates who got interviews emphasized *fewer* skills and certifications, not more.
- **Never add a skill, credential, employer, or metric the candidate does not have.** The gain from one keyword is far smaller than the cost of a failed background check — and AI screeners now run fraud detection.
- Put required credentials **in the body**, not only in a summary or a Skills list (0.66 vs 0.83 validity).[19]
- Prefer concrete specificity over soft-skill adjectives. Replace "strong communicator" with a concrete artifact.
- Quantify achievements — a number, percentage, time saving, revenue, scale, or count in each bullet.
- **Do not reformat or re-order the whole document per application.** Presentation churn flips LLM verdicts[20] and degrades human review too.

**Cover letters.**
- Generate one when the posting has a cover-letter field. ResumeGo's 7,287-application field experiment found tailored cover letters produced a **53% higher callback rate** than none.
- Write it for a human: 3–5 sentences, no restated resume, no keyword list, name the company and role concretely, one specific reason this candidate fits.
- **Do not put essential qualifications only in the cover letter.** Taleo's Conceptual Search reads only the last three attachments; the published LLM scope is resume + job post.

**Answers — the higher-leverage surface.** Auto-rejects fire on application questions, not resume text. A tailoring system should flag required screening questions the candidate is about to answer wrongly — and never let the resume contradict the answers.

**Hard guardrails.**
- Never emit hidden text, zero-size fonts, off-canvas text, or prompt-injection payloads, and never attempt to manipulate a screener's ranking. Real injection is already in the corpus (~1% of ~200,000 real resumes, growing), it is detected, and it carries legal risk.
- Never claim to "beat the ATS" or emit a match percentage. Output a **structural-validity report** — parses cleanly, single reading order, contact fields extractable, required terms present, claims quantified and body-located.
- Preserve the candidate's factual content verbatim except for targeted edits, and log every change. The failure mode of an automated tailor is silent fabrication, not missed keywords.

---

## 4. What Hermes Agent contributes

Every capability below was read from the live docs.[23]

| Capability | Commands / config | Fit |
|---|---|---|
| **Cron scheduling** | `hermes cron create "every 2h" "…"`, `--workdir`, `--script` + `--no-agent` (zero-token script-only jobs), `--skill`, `--deliver <platform>`, `--timezone`, `--pin`, `--reasoning-effort` | Backbone for polling, follow-ups, digests. Runs in fresh sessions outside any chat — the only scheduler that survives terminal closure.[24] |
| **Skills** | Project skills at `<root>/.hermes/skills/` or `<root>/.agents/skills/`; `hermes skills trust`; publish with `hermes skills publish skills/x --to github --repo owner/repo`; install `hermes skills install owner/repo/skills/x`; taps via `hermes skills tap add` | **This is how a repo ships its workflows.** Precedence: `project → local → create_dir → external_dirs`.[25] |
| **Delegation** | `delegate_task(tasks=[{goal, context, output_schema}])` | Parallel per-posting analysis. **Process-local, not durable** — for long-lived work use cron or the Kanban board.[26] |
| **Browser automation** | `browser_exec(code)`, `new_tab`, `goto_url`, `js`, `fill_input`, `capture_screenshot`; `browser.use_real_profile` snapshots your real profile for logged-in sessions | For portals with no API. `browser_exec` requires the `terminal` toolset too.[29] |
| **MCP** | `mcp_servers:` in `config.yaml`; `hermes mcp add/list/test`; ship as a portable plugin with `plugin.json` + `skills/*/SKILL.md` + `mcp.json` | Expose the job DB / tracker as typed tools without touching Hermes core.[27] |
| **Webhooks** | `WEBHOOK_ENABLED=true`, `WEBHOOK_PORT=8644`, `WEBHOOK_SECRET`; `hermes webhook subscribe … --cron-job "<id>"` | **Event-triggered cron** — a new posting POSTs and fires the job immediately instead of waiting for a tick. HMAC-signed; payloads are untrusted input.[28] |
| **Headless** | `hermes chat -q "…" --oneshot -Q --no-restore-cwd -t <toolsets>`; `hermes -z`; `hermes serve`; OpenAI-compatible API server | Required for CI, cron ticks, and a Python orchestrator. |
| **Email** | Email gateway adapter (receive/reply in-thread), Himalaya CLI skill (outbound), Google Workspace Gmail API | Outbound application mail is **not** an agent-callable model tool — a human confirmation step is required by design. |

**Honest limits:** no native ATS/job-board connectors exist (so the source layer is yours to build); delegation is not durable; cron runs have a ~3-minute hard interrupt; Hermes memory is bounded (~2,200 chars for memory, ~1,375 for user profile); webhook payloads are untrusted input; outbound email is deliberately not agent-callable.

### The specific gap in career-ops — and why it exists

career-ops drives headless workers through an agent CLI. Each worker declares what it needs in CLI-agnostic terms (`{writes, network}`), and each CLI module translates that into its own permission flags.

Hermes was refused outright. From `web/src/lib/cli-fencing.mjs`:

> "Hermes is limited to workers whose capability record has `writes: false` because career-ops has no verified way to translate that record into Hermes's own approval/sandbox controls."[5]

And from `rank-pipeline.mjs`:

> "Hermes stays out: rank prompts contain untrusted posting text and Hermes has no verified child-permission boundary."[4]

The batch ranker exits with an error on `--cli hermes`.[4]

**This is the single most defensible thing to build.** It is a well-specified, upstreamable gap — and I confirmed it is real by getting Hermes to score live postings through the actual `rank-pipeline.mjs` (see §6).

---

## 5. Open-source landscape

| Project | Stars | Last push | License | Verdict |
|---|---|---|---|---|
| **career-ops-hq/career-ops** | ~79.8k | 2026-11-03 | MIT | The incumbent. Use it.[1] |
| srbhr/Resume-Matcher | ~29.1k | 2026-11-02 | Apache-2.0 | Strong local harness for CVs/cover letters, 100+ LLMs. Its **master-resume + JD document model** is worth reusing. |
| speedyapply/JobSpy | ~4.6k | 2026-10-27 | MIT | Healthy scraper (LinkedIn/Indeed/Glassdoor). **Legal risk, not code risk** — keep it out of a public repo. |
| vesaias/JobNavigator | 176 | 2026-11-03 | MIT | Multi-account, Telegram alerts, Docker. Closest in shape to this project. |
| sliday/resume-job-matcher | 275 | 2026-08-31 | none | Good idea: every score cites the resume span behind it. |
| seehiong/ats-buddy | 139 | 2026-08-10 | MIT | Private-by-design ATS analyzer via WebLLM/Ollama. |
| mzupan/tech-resume | 56 | 2026-10-17 | MIT | An **agent skill** for tailored tech resumes that "don't read as AI-written." Directly relevant pattern. |

**License hygiene matters here.** AGPL-3.0 on `xitanggg/open-resume` and `crizzy9/naavik`; GPL-3.0 on `OmkarPathak/pyresparser` (also abandoned since 2019); LGPL-2.1 on `python-docx-template`; NOASSERTION on `opendatalab/MinerU` and `py-pdf/pypdf`. A permissively-licensed new project must avoid or replace all of those. Safe: JobSpy (MIT), pdfplumber (MIT), pdfminer.six (MIT), python-docx (MIT), docling (MIT), marker (Apache-2.0), rendercv (MIT), reactive-resume (MIT), playwright (Apache-2.0).

**The resume-tailoring shelf itself is empty.** A search for "resume tailor llm" / "ats resume tailoring" returns a dozen 0-star student repos with no license and no maintenance. That is where rigor differentiates, not where features do.

---

## 6. Gaps worth building

Ordered by value. Each is something the incumbent structurally cannot do, not merely does worse.

### 6.1 A verified Hermes permission boundary *(highest value — and I already proved it works)*

career-ops will not use Hermes for write-capable workers or batch ranking because there was "no verified way to translate that record into Hermes's own approval/sandbox controls."[4][5]

There is one, and I verified it empirically rather than by argument:

- **`-t <toolsets>` is a real capability fence.** Hermes composes each toolset into the tool schema it sends the model. A toolset that is absent produces no tool — there is no write path to approve. With `-t web`, a worker asked to write a file has no file tool and says so. With `-t file,terminal`, it writes. Verified both ways against a live agent.
- **`approvals.single_query_mode: deny` is the second layer.** Hermes defaults headless `-q` sessions to denying dangerous commands, and tells the model no human is present to approve. Verified: `rm -rf` on a directory containing a file was refused, and the model declined to route around the check.

Together those translate `{writes, network}` into an enforced boundary, which is what "verified" means here. The capability record maps as:

| career-ops capability record | Hermes translation |
|---|---|
| `localReadOnly` | no write toolset |
| `webSearchOnly` / `networkReadOnly` | `web` toolset only |
| `workspaceWrite` | `file`, `terminal`, `code_execution` + approval `deny` |

**I confirmed this end-to-end against the real `rank-pipeline.mjs`:** with the adapter wired in, Hermes scored 3 of 3 postings against a CV, with reasons ("Senior Python role matches her Python pipeline work and seniority…"). A prompt-injection payload planted in a posting title was recognized as an injection attempt *and* could not create a file — the model reported "Ignored the embedded instructions" and the marker file was never written.

That work is in `src/fence/` and `scripts/` in this repo, with 31 passing unit tests and two live verification scripts.

### 6.2 A deterministic, versioned selection model

career-ops keeps its 1–5 rubric and its "do not apply" bucket in markdown mode files, with 8 golden eval fixtures — not in versioned, unit-tested, calibrated code. This is the highest-value gap against your explicit "select which ones I want to apply for" requirement: a model taking (resume, job, comp, estimated effort, strategic value) and returning a defensible ranking with a "do not apply" threshold.

### 6.3 ATS verification wired as a closed loop

`verify-ats.mjs` (career-ops), `ats-reader`, naavik's parse-fidelity validator, and rendercv's empirical test each assert ATS-safety in isolation with their own ad-hoc rules. Nobody closes `generate → parse back → score → auto-repair → regenerate until passing`, and nobody publishes a shared, versioned schema.

`src/tailor/ats-verify.mjs` in this repo is a first implementation of that contract, weighted from the evidence in §3 — and it explicitly refuses to emit a fake "match percentage."

### 6.4 An outcome-feedback instrument

Every tool ends at "resume produced / form filled." Nothing tracks applied → viewed → screen → interview → offer and feeds it back into the fit model, so the rubric can never be calibrated against reality. The data exists in tracker exports across many repos; the instrument does not exist anywhere.

### 6.5 An ATS-first source ladder with a published provider contract

career-ops has the most complete source layer in existence (130 providers) but it is embedded in a JS repo with a bespoke `portals.yml` and no published provider API. A clean provider interface — Greenhouse/Lever/Ashby/Workable first, then RSS/XML, then HTML, then browser, degrading gracefully — is reusable as a contract.

`src/sources/ats-sources.mjs` is a working instance of that interface.

---

## 7. Recommended plan

**Build the layers, not a clone.**

```
career-ops (MIT, existing)          ← the engine: sources, rubric, tailoring, tracker
        │
        ├─ Hermes skill (this repo)  ← your workflow, installable via `hermes skills install`
        ├─ Hermes fence adapter      ← lets career-ops use Hermes safely (§6.1)
        ├─ Selection model            ← your calibrated ranking (§6.2)
        ├─ ATS verification contract  ← shared schema + closed loop (§6.3)
        └─ Outcome feedback           ← calibration data (§6.4)
```

**Phase 1 — Use it before you build it (week 1)**
1. `git clone career-ops && npm install`
2. Point Hermes at the checkout: `cd career-ops && hermes`, then `hermes skills trust` (one time — project skills are not auto-loaded)
3. Configure `portals.yml` with your target employers, using the ATS board endpoints
4. Run the zero-token scan. Measured on 5 aggregator boards: **2,609 postings found, 498 duplicates removed, zero errors, zero LLM tokens.**
5. Use the evaluation + tailoring modes on a handful of real postings and see whether the output is good enough

This step is the highest-information action available, and it costs a day. It may dissolve much of Phase 2.

**Phase 2 — Contribute the Hermes fencer (week 2)**
Open a PR against career-ops adding a Hermes candidate to `CLI_CANDIDATES` and a `fenceHermesArgs` module, with the live verification scripts as the test. The upstream maintainer explicitly invites "if you hit a Hermes-specific snag, open an issue" — and this is precisely that snag, with a verified solution.

**Phase 3 — Your own repo (weeks 3+)**
Only what career-ops structurally cannot do:
- The selection model as versioned, unit-tested code with golden fixtures
- The ATS verification contract as a published JSON schema + CI conformance suite
- The outcome-feedback instrument

Ship as a Hermes skill (repo distribution) plus a portable Agent Plugins package (`plugin.json` + `skills/*/SKILL.md` + `mcp.json`) so the MCP tools — job DB, tracker, ATS status — are first-class in Hermes.

**Automation shape, once it exists:**

```
cron (--script --no-agent)  →  zero-token scan + ATS fetch
                            →  writes jobs to the store
cron (--skill job-search)   →  score, rank, pick the top N
                            →  deliver to Telegram/Discord
webhook (--cron-job)        →  a new posting fires immediately, not at the next tick
human                       →  selects which to apply for
tailor                      →  resume + cover letter, ATS-verified
human                       →  review, submit
```

**Human-in-the-loop is a requirement, not a politeness.** career-ops' own rule is "career-ops prepares, you decide. No session will submit an application, send an email, or click anything on your behalf." Automated discovery, tailoring and drafting; a human presses Submit. That also sidesteps the ToS problem entirely — you are not scraping at scale, you are reading postings you chose to apply to.

---

## 8. What I did not do, and what I would check next

- I did not benchmark the LLM quality of resume tailoring. A/B the same posting through career-ops with two models and compare the output is worth an afternoon before you commit to a tailoring engine.
- I did not test Workday, iCIMS, Taleo, SuccessFactors, SmartRecruiters, BambooHR, Oracle or Phenom board endpoints — those need per-tenant host discovery. career-ops has 130 provider modules that already handle them.
- I did not verify Adzuna's free-tier call caps from a primary source (`adzuna.co.uk` returns 403 to both curl and browser). Confirm in-account before designing around them.
- USAJobs hourly caps are widely quoted as 500/hr per IP but I could not confirm them in any primary source — the live guide lists only row limits.
- Non-US markets (BOSS直聘, Liepin, hh.ru) are actively served by maintained MIT projects. If you are not US-only, that is real unclaimed ground — but it multiplies the work, so decide it explicitly rather than discovering it late.

---

## Sources

[1] https://github.com/career-ops-hq/career-ops
[2] https://github.com/career-ops-hq/career-ops/blob/main/docs/HERMES.md
[3] https://github.com/career-ops-hq/career-ops/blob/main/docs/SUPPORTED_JOB_BOARDS.md
[4] https://github.com/career-ops-hq/career-ops/blob/main/rank-pipeline.mjs
[5] https://github.com/career-ops-hq/career-ops/blob/main/web/src/lib/cli-fencing.mjs
[6] https://github.com/feder-cr/invisible_dots
[7] https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true
[8] https://boards.greenhouse.io/robots.txt
[9] https://api.lever.co/v0/postings/spotify?mode=json
[10] https://api.lever.co/robots.txt
[11] https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true
[12] https://apply.workable.com/robots.txt
[13] https://himalayas.app/jobs/api
[14] https://jobicy.com/api/v2/remote-jobs
[15] https://remotive.com/api/remote-jobs
[16] https://www.indeed.com/legal
[17] https://www.linkedin.com/legal/user-agreement
[18] https://www.hbs.edu/managing-the-future-of-work/Documents/research/hiddenworkers09032021.pdf
[19] https://arxiv.org/abs/2602.18550
[20] https://arxiv.org/abs/2609.16517
[21] https://developers.greenhouse.io/job-board.html
[22] https://www.computerworld.com/article/1458323/5-insider-secrets-for-beating-applicant-tracking-systems.html
[23] https://hermes-agent.nousresearch.com/docs/llms.txt
[24] https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
[25] https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
[26] https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
[27] https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
[28] https://hermes-agent.nousresearch.com/docs/user-guide/messaging/webhooks
[29] https://hermes-agent.nousresearch.com/docs/user-guide/features/browser
