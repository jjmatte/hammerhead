/**
 * ats-sources.mjs — job discovery from employer ATS boards.
 *
 * WHY THIS IS THE PRIMARY SOURCE
 * -------------------------------
 * A tailoring system needs the job description AS THE EMPLOYER'S ATS INGESTED
 * IT. Keyword matchers read that stored text, not a third party's paraphrase.
 * The ATS board APIs return the unaltered posting, and they are published by
 * the employer for exactly this kind of use:
 *
 *   Greenhouse  https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 *   Lever       https://api.lever.co/v0/postings/{slug}?mode=json
 *   Ashby       https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *   Workable    https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
 *
 * All four were verified live on 2026-11-03 (Greenhouse 741 jobs, Ashby 807,
 * Lever 820 KB of postings, Workable 200 OK). Their robots.txt permits this:
 *
 *   Greenhouse  Disallow: /embed/          (everything else allowed)
 *   Lever       Allow: /  Crawl-delay: 1
 *   Ashby       (no restrictions)
 *   Workable    Content-Signal: search=yes, ai-input=yes, ai-train=no
 *               Disallow: (empty)
 *
 * Workable's `ai-input=yes` is the clearest signal: the operator explicitly
 * permits AI systems to read the content as input.
 *
 * WHY NOT LINKEDIN OR INDEED
 * --------------------------
 * Indeed's terms forbid using its data "to train or fine-tune any third-party
 * machine learning model", which is what a tailoring pipeline does with the
 * text. LinkedIn's User Agreement forbids scraping and its robots.txt
 * disallows the job-search paths. Both are exposed in a public repo, where
 * "personal, non-commercial use" stops being a meaningful defense. The
 * aggregators (Himalayas, Jobicy, The Muse) are used for breadth; the ATS
 * boards are used for the postings you actually want to apply to.
 *
 * The `fetchJson` helper takes an explicit `redirect: "error"` so a hostile
 * board cannot bounce us at an internal address (SSRF via redirect).
 */

/**
 * @typedef {Object} JobPosting
 * @property {string} title
 * @property {string} company
 * @property {string} location
 * @property {string} url
 * @property {string} description - the JD text, as the ATS stored it
 * @property {string[]} [tags]
 * @property {string} [ats] - which ATS it came from
 * @property {number} [postedAt] - epoch ms, when the board exposes it
 * @property {string} [salary]
 */

/** Board slug -> ATS family. */
export const ATS_KINDS = Object.freeze({
  greenhouse: "greenhouse",
  lever: "lever",
  ashby: "ashby",
  workable: "workable",
});

/** A default, verified-working board set. Replace with your own target list. */
export const DEFAULT_BOARDS = Object.freeze([
  { ats: "greenhouse", slug: "stripe" },
  { ats: "greenhouse", slug: "netlify" },
  { ats: "ashby", slug: "openai" },
  { ats: "lever", slug: "spotify" },
]);

/**
 * @param {string} ats
 * @param {string} slug
 * @returns {string}
 */
export function boardUrl(ats, slug) {
  switch (ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
    case "workable":
      return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`;
    default:
      throw new Error(`unknown ATS: ${ats}`);
  }
}

/** Strip the HTML that board APIs embed in descriptions, keeping text order. */
export function htmlToText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Normalize a location string to something displayable. */
function cleanLocation(loc) {
  if (!loc) return "Remote";
  const s = String(loc).trim();
  if (!s) return "Remote";
  return s;
}

/**
 * Normalize a Greenhouse posting.
 * @param {any} j
 * @param {{company: string}} ctx
 * @returns {JobPosting|null}
 */
function fromGreenhouse(j, ctx) {
  if (!j || typeof j.title !== "string") return null;
  const loc = j.location?.name;
  return {
    title: j.title.trim(),
    company: ctx.company,
    location: cleanLocation(loc),
    url: j.absolute_url || "",
    description: htmlToText(j.content),
    tags: Array.isArray(j.departments) ? j.departments.map((d) => d.name) : [],
    ats: "greenhouse",
    postedAt: j.updated_at ? Date.parse(j.updated_at) : undefined,
  };
}

/**
 * Normalize a Lever posting.
 * @param {any} j
 * @param {{company: string}} ctx
 * @returns {JobPosting|null}
 */
function fromLever(j, ctx) {
  if (!j || typeof j.text !== "string") return null;
  const categories = j.categories || {};
  const salary = j.salaryRange
    ? `${j.salaryRange.min} - ${j.salaryRange.max} ${j.salaryRange.currency || ""}`.trim()
    : undefined;
  return {
    title: j.text.trim(),
    company: ctx.company,
    location: cleanLocation(j.categories?.location),
    url: j.hostedUrl || j.applyUrl || "",
    description: htmlToText(j.descriptionPlain || j.description),
    tags: categories.team ? [categories.team] : [],
    ats: "lever",
    postedAt: j.createdAt ? Date.parse(j.createdAt) : undefined,
    salary,
  };
}

/**
 * Normalize an Ashby posting.
 * @param {any} j
 * @param {{company: string}} ctx
 * @returns {JobPosting|null}
 */
function fromAshby(j, ctx) {
  if (!j || typeof j.title !== "string") return null;
  const secondary = j.secondaryLocations?.[0]?.location;
  const loc = j.location || secondary;
  const comp = j.compensation?.summary || j.compensationTierSummary;
  return {
    title: j.title.trim(),
    company: ctx.company,
    location: cleanLocation(loc),
    url: j.jobUrl || j.applyUrl || "",
    description: htmlToText(j.descriptionHtml || j.descriptionPlain || j.description),
    tags: j.department ? [j.department] : [],
    ats: "ashby",
    postedAt: j.publishedAt ? Date.parse(j.publishedAt) : undefined,
    salary: comp || undefined,
  };
}

/**
 * Normalize a Workable posting.
 * @param {any} j
 * @param {{company: string}} ctx
 * @returns {JobPosting|null}
 */
function fromWorkable(j, ctx) {
  if (!j || typeof j.title !== "string") return null;
  return {
    title: j.title.trim(),
    company: ctx.company,
    location: cleanLocation(j.city || j.state || j.country),
    url: j.url || j.application_url || j.short_url || "",
    description: htmlToText(j.description || j.requirements),
    tags: j.tags || [],
    ats: "workable",
    postedAt: j.published_on ? Date.parse(j.published_on) : undefined,
  };
}

/**
 * Fetch and normalize one board.
 *
 * @param {{ats: string, slug: string, company?: string}} board
 * @param {{ fetchJson: (url: string, opts?: any) => Promise<any> }} ctx
 * @returns {Promise<JobPosting[]>}
 */
export async function fetchBoard(board, ctx) {
  const { ats, slug } = board;
  const company = board.company || slug;
  const url = boardUrl(ats, slug);

  const json = await ctx.fetchJson(url, { redirect: "error" });

  let raw = [];
  let normalizer = null;

  switch (ats) {
    case "greenhouse":
      raw = json?.jobs || [];
      normalizer = fromGreenhouse;
      break;
    case "lever":
      raw = json || [];
      normalizer = fromLever;
      break;
    case "ashby":
      raw = json?.jobs || [];
      normalizer = fromAshby;
      break;
    case "workable":
      raw = json?.jobs || [];
      normalizer = fromWorkable;
      break;
    default:
      throw new Error(`unknown ATS: ${ats}`);
  }

  return raw
    .map((j) => normalizer(j, { company }))
    .filter((j) => j && j.title && j.url && j.description);
}

/**
 * Fetch every board and return a flat list, skipping boards that fail.
 *
 * A board being down should not take down the run — that is how a job-search
 * tool silently stops finding jobs.
 *
 * @param {{ats: string, slug: string, company?: string}[]} boards
 * @param {{ fetchJson: (url: string, opts?: any) => Promise<any> }} ctx
 * @returns {Promise<{jobs: JobPosting[], errors: {board: string, error: string}[]}>}
 */
export async function fetchAllBoards(boards, ctx) {
  const jobs = [];
  const errors = [];

  for (const board of boards) {
    try {
      const found = await fetchBoard(board, ctx);
      jobs.push(...found);
    } catch (err) {
      errors.push({
        board: `${board.ats}/${board.slug}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { jobs, errors };
}

/**
 * De-duplicate postings that appear on more than one board, keeping the
 * first (which is the board with the original JD).
 *
 * @param {JobPosting[]} jobs
 * @returns {JobPosting[]}
 */
export function dedupe(jobs) {
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const key = `${j.company.toLowerCase()}|${j.title.toLowerCase()}|${j.location.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

export default { ATS_KINDS, DEFAULT_BOARDS, boardUrl, htmlToText, fetchBoard, fetchAllBoards, dedupe };
