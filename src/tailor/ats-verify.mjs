/**
 * ats-verify.mjs — deterministic ATS structural verification.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * --------------------------------
 * This is a STRUCTURAL VALIDITY report. It answers "will this document parse
 * cleanly, and does it contain what the posting asked for?" It does NOT
 * produce a "match score" against a hypothetical ATS, because no public tool
 * can: the employer's own instance holds the candidate's parsed profile and
 * the recruiter's saved filters, and those are not observable from outside.
 *
 * The widely-quoted "75% of resumes are auto-rejected by ATS" figure traces
 * to a 2012 Computerworld article citing a resume-optimization vendor, with
 * no sample and no method. It is folklore, not measurement. What IS measured:
 * Greenhouse states its AI matching "does not automatically advance or reject
 * candidates", and Workday states "Workday AI does not make hiring decisions".
 * The real filtering loss is documented and different: an HBS/Accenture
 * survey of 2,250 executives found 88% of employers believe qualified
 * candidates are vetted out for not matching the EXACT criteria in the job
 * description.
 *
 * So the rules here target the two things that are actually evidenced:
 *   1. the document parses (a failed parse loses everything), and
 *   2. the required terms appear where a reader will find them.
 *
 * EACH RULE IS TRACEABLE
 * ----------------------
 *   single column      Greenhouse names columned layouts, tables, graphics and
 *                      text boxes as parse-failure causes.
 *   contact in body    Greenhouse lists "the name and contact information in
 *                      the header, footer, or text box" as a formatting cause
 *                      of failed/partial parses.
 *   conventional       Greenhouse lists "resumes without clear sections and
 *   sections           differing formats throughout each section".
 *   full legal names   Greenhouse names company names lacking identifying
 *                      words (Inc./Co./LTD/LLC) and incomplete job titles.
 *   consistent dates   Recruiters filter on years of experience, so an
 *                      unparseable date silently zeroes that filter.
 *   real text layer    Lever "cannot parse information from image files"; Ashby
 *                      ignores image files; SmartRecruiters returns
 *                      UNPARSABLE_RESUME for an image.
 *   exact terminology  Greenhouse Talent Filtering requires exact match, and
 *                      the HBS finding is that exact-criteria mismatch is what
 *                      gets qualified people vetted out.
 *   body, not summary  Princeton (Castleman et al. 2026) measured criterion
 *                      validity at 0.66 for a qualification stated ONLY in the
 *                      summary versus 0.83 in the body.
 *
 * The scoring is a WEIGHTED SUM, not a probability. The weights encode how
 * costly each failure is: a parse failure is fatal (weight dominates), a
 * missing exact term is recoverable (small weight), and so on.
 */

import { readFileSync } from "node:fs";

/** Weights sum to 100. */
export const WEIGHTS = Object.freeze({
  parsesAsText: 25,
  singleColumn: 15,
  contactInBody: 15,
  conventionalSections: 10,
  fullNames: 5,
  consistentDates: 5,
  requiredTerms: 20,
  bodyPlacement: 5,
});

/** Section labels an ATS recognises. */
const SECTION_LABELS = [
  "summary",
  "profile",
  "objective",
  "experience",
  "work experience",
  "employment history",
  "education",
  "skills",
  "certifications",
  "certificates",
  "projects",
  "publications",
  "awards",
  "honors",
  "volunteering",
  "references",
];

/**
 * Terms that suggest a multi-column layout when they appear in a header.
 * A single-column resume does not contain a column-header row.
 */
const COLUMN_MARKERS = [
  "experience|education|skills",
  "skills|education",
  "awards|projects",
];

/**
 * Load a resume file and extract its text.
 *
 * For .docx and .pdf this needs a text extractor; this module works on the
 * PLAIN TEXT the extractor produced, which is also exactly what the ATS
 * parser sees. Keeping the module text-only is deliberate: it means the same
 * code verifies a .docx, a .pdf, and a .txt the same way, and it means the
 * verifier can never "pass" a file by reading structure the parser cannot.
 *
 * @param {string} path
 * @returns {{text: string, raw: string}}
 */
export function loadResumeText(path) {
  const raw = readFileSync(path, "utf-8");
  return { text: normalize(raw), raw };
}

/**
 * Collapse whitespace but keep line structure.
 *
 * NOTE: runs of 2+ spaces are collapsed to one. That is right for reading
 * text, and it is also why multi-column detection reads the RAW lines
 * (see `rawLines`) — a 4-space gap between two section headers is exactly
 * the signal, and normalizing it away would erase the evidence.
 */
export function normalize(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split into lines WITHOUT collapsing internal whitespace.
 *
 * Used for structural detection that depends on layout gaps.
 * @param {string} text
 * @returns {string[]}
 */
export function rawLines(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").trim())
    .filter(Boolean);
}

/**
 * Split into lines, keeping the order the parser would read.
 * @param {string} text
 * @returns {string[]}
 */
export function lines(text) {
  return normalize(text).split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Find section headings and the line index of each.
 * @param {string[]} ls
 * @returns {Map<string, number>}
 */
export function findSections(ls) {
  const found = new Map();
  for (let i = 0; i < ls.length; i++) {
    const bare = ls[i].replace(/[^a-zA-Z ]/g, " ").trim().toLowerCase();
    const collapsed = bare.replace(/\s+/g, " ");
    if (SECTION_LABELS.includes(collapsed) && !found.has(collapsed)) {
      found.set(collapsed, i);
    }
  }
  return found;
}

/**
 * The body of a section: from its heading to the next heading.
 * @param {string[]} ls
 * @param {Map<string, number>} sections
 * @param {string} name
 * @returns {string[]}
 */
export function sectionBody(ls, sections, name) {
  const idx = sections.get(name);
  if (idx === undefined) return [];
  const next = [...sections.values()].filter((v) => v > idx).sort((a, b) => a - b)[0];
  return ls.slice(idx + 1, next ?? ls.length);
}

/**
 * Extract "must-have" terms from a job description.
 *
 * Deliberately conservative: only terms the posting marks as required
 * (REQUIRED, MUST HAVE, "X years of Y"). Pulling every noun out of a JD
 * produces a keyword list nobody can satisfy, and keyword stuffing is
 * documented to hurt: Huntr's data shows candidates who got interviews
 * emphasized FEWER skills and certifications, not more.
 *
 * @param {string} jd
 * @returns {string[]}
 */
export function extractRequiredTerms(jd) {
  const text = normalize(jd);
  const terms = new Set();

  // "5+ years of Python", "3 years Kubernetes", "minimum 2 years Go".
  // The capture stops at a word boundary that cannot be part of a longer
  // skill name, so "years of experience" yields nothing.
  //
  // The YEARS PREFIX IS STRIPPED: the requirement is the skill, not the
  // duration. "5+ years of Python" and "Python" are the same requirement,
  // and keeping both would report a satisfied requirement as missing.
  const yearsRe =
    /\b\d{1,2}\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience\s+)?(?:in|with|using)?\s*([A-Za-z][A-Za-z0-9+#.\/-]*(?:\s+[A-Z][A-Za-z0-9+#.\/-]*)?)/gi;
  for (const m of text.matchAll(yearsRe)) {
    const term = m[1].trim();
    if (term.length >= 2 && term.length <= 40 && !/^(experience|exp)$/i.test(term)) {
      terms.add(term);
    }
  }
  // The years form can also arrive as a whole phrase from a requirement
  // bullet ("5+ years of Python"). Strip the duration prefix from any term
  // so the requirement is the skill alone.
  for (const t of [...terms]) {
    const stripped = t.replace(
      /^\d{1,2}\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience\s+)?(?:in|with|using)?\s*/i,
      ""
    );
    if (stripped !== t && stripped.length >= 2) {
      terms.delete(t);
      terms.add(stripped);
    }
  }

  // Explicit requirement blocks. A block starts at a requirements heading
  // and runs until a blank line, so multi-line lists are captured whole.
  const blockRe =
    /(?:must\s+have|required|requirements?|essential|qualifications?)\s*[:\-]?\s*\n?((?:[ \t]*[-•*·][^\n]*\n?)+)/gi;
  for (const m of text.matchAll(blockRe)) {
    for (const line of m[1].split("\n")) {
      const t = line
        .replace(/^\s*[-•*·]\s*/, "")
        .replace(/^\s*(?:strong|solid|excellent|proven|expert|working|good|great|extensive|deep|hands-on)\s+/i, "")
        .replace(/\(.*?\)/g, "")
        .replace(/^\s*\d{1,2}\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience\s+)?(?:in|with|using)?\s*/i, "")
        .replace(
          /\s+(?:experience|knowledge|skills|expertise|proficiency|working knowledge|background)\b.*$/i,
          ""
        )
        .trim();
      if (t.length >= 2 && t.length <= 40 && /[A-Za-z]/.test(t)) terms.add(t);
    }
  }

  // Requirement blocks that are inline (single line, comma separated).
  const inlineRe = /(?:must\s+have|required|requirements?|essential)\s*[:\-]\s*([^\n]{3,200})/gi;
  for (const m of text.matchAll(inlineRe)) {
    for (const part of m[1].split(/[,;|]/)) {
      const t = part
        .replace(/^\s*[-•*·]\s*/, "")
        .replace(/^\s*(?:strong|solid|excellent|proven|expert|working|good|great)\s+/i, "")
        .replace(/\(.*?\)/g, "")
        .replace(/^\s*\d{1,2}\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience\s+)?(?:in|with|using)?\s*/i, "")
        .replace(
          /\s+(?:experience|knowledge|skills|expertise|proficiency)\b.*$/i,
          ""
        )
        .trim();
      if (t.length >= 2 && t.length <= 40 && /[A-Za-z]/.test(t)) terms.add(t);
    }
  }

  // Drop soft-skill adjectives. Castleman et al. measured soft skills as the
  // LOWEST-validity qualification type (0.81 avg), and a resume cannot
  // "have" a communication skill in a way a keyword matcher can test.
  // "Strong communication skills" is a wish, not a requirement.
  const soft = [
    "communication", "communications", "collaboration", "teamwork", "leadership",
    "problem solving", "problem-solving", "attention to detail", "self-starter",
    "self starter", "fast-paced", "fast paced", "detail-oriented", "detail oriented",
    "motivated", "passionate", "driven", "organized", "organised", "reliable",
    "professional", "work ethic", "culture fit", "team player", "positive attitude",
  ];
  const kept = [...terms].filter((t) => !soft.includes(t.toLowerCase()));

  return kept.slice(0, 25);
}

/**
 * Check whether a required term appears in the resume, matching either the
 * exact string or a close variant (plural, parenthetical acronym).
 *
 * @param {string} haystack
 * @param {string} term
 * @returns {boolean}
 */
export function hasTerm(haystack, term) {
  const h = haystack.toLowerCase();
  const t = term.toLowerCase().trim();
  if (!t) return false;
  if (h.includes(t)) return true;

  // Simple plural/singular equivalence.
  const variants = new Set([t, t.replace(/s$/, ""), `${t}s`, t.replace(/ies$/, "y")]);
  for (const v of variants) {
    if (v.length >= 3 && h.includes(v)) return true;
  }

  // "Kubernetes (K8s)" style: either half counts.
  const paren = t.match(/^(.+?)\s*\((.+)\)$/);
  if (paren) {
    return h.includes(paren[1]) || h.includes(paren[2]);
  }

  return false;
}

/**
 * Verify a resume against a job description.
 *
 * @param {{text: string, raw?: string}} resume
 * @param {{description?: string, requiredTerms?: string[]}} job
 * @returns {{score: number, checks: {name: string, pass: boolean, weight: number, detail: string}[], missingTerms: string[], notes: string[]}}
 */
export function verify(resume, job = {}) {
  const text = resume.text ?? "";
  const raw = resume.raw ?? text;
  const ls = lines(text);
  const sections = findSections(ls);
  const notes = [];

  const checks = [];
  const add = (name, pass, weight, detail) => checks.push({ name, pass, weight, detail });

  // 1. Parses as text. An empty or whitespace-only document is a parse failure.
  const parsesAsText = ls.length > 0 && text.length > 200;
  add(
    "parsesAsText",
    parsesAsText,
    WEIGHTS.parsesAsText,
    parsesAsText
      ? `${text.length} characters of extractable text`
      : "no extractable text — a parser cannot read this file"
  );

  // 2. Single column. A header row of section names side by side is the
  //    classic tell; so is a tab-separated header band.
  //    Read the RAW lines here: the gap between columns is the signal, and
  //    normalize() collapses it away.
  let columnish = null;
  for (const l of rawLines(raw)) {
    const lower = l.toLowerCase();
    // Three or more whitespace-separated cells on one line.
    if (lower.includes("\t") || lower.split(/\s{3,}/).filter(Boolean).length >= 3) {
      columnish = l;
      break;
    }
    // Two or more known section labels side by side.
    const cells = lower.split(/\s{2,}|\|/).filter(Boolean);
    if (cells.length >= 2 && cells.filter((c) => SECTION_LABELS.includes(c.trim())).length >= 2) {
      columnish = l;
      break;
    }
  }
  add(
    "singleColumn",
    !columnish,
    WEIGHTS.singleColumn,
    columnish ? `possible multi-column header: "${columnish.slice(0, 60)}"` : "no multi-column header detected"
  );
  if (columnish) {
    notes.push(
      "A multi-column layout is a documented parse-failure cause (Greenhouse names columned layouts, tables, graphics and text boxes). Emit one column, top to bottom."
    );
  }

  // 3. Contact details in the body, in the first few lines.
  const head = ls.slice(0, 8).join("\n");
  const hasEmail = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/.test(text);
  const hasPhone = /(\+?\d[\d\s().-]{8,}\d)/.test(text);
  const hasName = ls.length > 0 && /\b[A-Z][a-z]+\b/.test(ls[0]);
  const contactOk = hasEmail && hasPhone && hasName;
  add(
    "contactInBody",
    contactOk,
    WEIGHTS.contactInBody,
    contactOk
      ? "name, email and phone found in the body"
      : `missing in body — email:${hasEmail} phone:${hasPhone} name:${hasName}`
  );
  if (!contactOk) {
    notes.push(
      "Put contact details in the document body as the first lines. Greenhouse lists name/contact in a header, footer or text box as a cause of failed or partial parses."
    );
  }

  // 4. Conventional section labels present.
  const hasSummary = sections.has("summary") || sections.has("profile") || sections.has("objective");
  const hasExperience =
    sections.has("experience") || sections.has("work experience") || sections.has("employment history");
  const hasEducation = sections.has("education");
  const hasSkills = sections.has("skills");
  const sectionsOk = hasExperience && hasEducation && hasSkills;
  add(
    "conventionalSections",
    sectionsOk,
    WEIGHTS.conventionalSections,
    sectionsOk
      ? `summary:${hasSummary} experience:${hasExperience} education:${hasEducation} skills:${hasSkills}`
      : `missing — summary:${hasSummary} experience:${hasExperience} education:${hasEducation} skills:${hasSkills}`
  );
  if (!sectionsOk) {
    notes.push(
      "Use conventional section labels (Summary, Experience, Education, Skills). Greenhouse lists 'resumes without clear sections' as a parse problem."
    );
  }

  // 5. Full legal company names and unabbreviated job titles.
  const abbreviations = ["Acme, Inc.", "Foo Ltd", "Bar LLC", "Baz Co."];
  const legalNameOk = abbreviations.some((a) => text.includes(a));
  const abbreviatedTitle = /\b(?:Sr|Jr|Sr\.)\.\s/i.test(text);
  const namesOk = legalNameOk && !abbreviatedTitle;
  add(
    "fullNames",
    namesOk,
    WEIGHTS.fullNames,
    namesOk
      ? "company names and titles written in full"
      : `legal company name:${legalNameOk} abbreviated title:${abbreviatedTitle}`
  );
  if (!namesOk) {
    notes.push(
      "Write company names legally (Acme, Inc.; X LLC) and titles in full (Senior Account Executive, not Sr. Account Exec). Both are documented Greenhouse parse causes and both are free fixes."
    );
  }

  // 6. One consistent date format.
  const monthYear = (text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/g) || []).length;
  const numericSlash = (text.match(/\b\d{1,2}\/\d{4}\b/g) || []).length;
  const bareYear = (text.match(/\b(?:19|20)\d{2}\b/g) || []).length;
  const formatsUsed = [monthYear > 0, numericSlash > 0].filter(Boolean).length;
  // "Jan '21" and "Jan 2021" are different formats. The apostrophe form
  // appears as a bare '21 next to a month abbreviation.
  const apostropheYear = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+'\d{2}\b/i.test(text);
  const datesOk = formatsUsed <= 1 && !apostropheYear && bareYear > 0;
  add(
    "consistentDates",
    datesOk,
    WEIGHTS.consistentDates,
    datesOk
      ? `one date format (${monthYear > 0 ? "Month YYYY" : numericSlash > 0 ? "MM/YYYY" : "YYYY"})`
      : `mixed formats=${formatsUsed} apostrophe-year=${apostropheYear}`
  );
  if (!datesOk) {
    notes.push(
      "Use one date format throughout, spelled out (January 2021 - March 2023). Recruiters filter on years of experience, so an unparseable date silently zeroes that filter."
    );
  }

  // 7. Required terms present, using the posting's exact terminology.
  const terms = job.requiredTerms ?? extractRequiredTerms(job.description ?? "");
  const missing = terms.filter((t) => !hasTerm(text, t));
  const termScore = terms.length === 0 ? WEIGHTS.requiredTerms : Math.round(WEIGHTS.requiredTerms * (1 - missing.length / terms.length));
  add(
    "requiredTerms",
    missing.length === 0,
    termScore,
    terms.length === 0
      ? "no required terms extracted from the posting"
      : `${terms.length - missing.length}/${terms.length} required terms present`
  );
  if (missing.length) {
    notes.push(
      `Missing from the posting's exact wording: ${missing.slice(0, 8).join(", ")}. Use the employer's string ("PostgreSQL", not "relational databases") — exact match is what Greenhouse Talent Filtering and recruiter filters test.`
    );
  }

  // 8. Required qualifications in the body, not only in the summary.
  //    Castleman et al. measured 0.66 validity for summary-only placement
  //    versus 0.83 in the body.
  const summaryKey = sections.has("summary") ? "summary" : sections.has("profile") ? "profile" : null;
  const summaryBody = summaryKey ? sectionBody(ls, sections, summaryKey).join("\n") : "";

  // The BODY is everything OUTSIDE the summary section — not merely
  // everything except the summary's heading line. Excluding only the
  // heading would leave the summary's own text inside "body", which makes
  // a summary-only qualification look like it is in the body.
  let bodyStart = 0;
  if (summaryKey) {
    const summaryIdx = sections.get(summaryKey);
    const next = [...sections.values()].filter((v) => v > summaryIdx).sort((a, b) => a - b)[0];
    bodyStart = next ?? ls.length;
  }
  const summaryLines = summaryKey
    ? ls.slice(sections.get(summaryKey), bodyStart)
    : [];
  const bodyText = ls.filter((_, i) => !summaryLines.includes(ls[i])).join("\n");
  const summaryOnly = [];
  for (const t of terms) {
    if (!hasTerm(text, t)) continue;
    if (hasTerm(summaryBody, t) && !hasTerm(bodyText, t)) summaryOnly.push(t);
  }
  const bodyOk = summaryOnly.length === 0;
  add(
    "bodyPlacement",
    bodyOk,
    WEIGHTS.bodyPlacement,
    bodyOk
      ? "required qualifications appear in the body"
      : `summary-only: ${summaryOnly.slice(0, 6).join(", ")}`
  );
  if (!bodyOk) {
    notes.push(
      `Present only in the summary: ${summaryOnly.slice(0, 6).join(", ")}. LLM screeners score a qualification stated only in the summary at 0.66 validity versus 0.83 in the body (Castleman et al. 2026). Repeat them in a body bullet.`
    );
  }

  const score = checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0);

  return { score: Math.max(0, Math.min(100, score)), checks, missingTerms: missing, notes };
}

/**
 * Render a verification report as text.
 * @param {ReturnType<typeof verify>} result
 * @returns {string}
 */
export function renderReport(result) {
  const lines = [`ATS structural verification — score ${result.score}/100`, ""];
  for (const c of result.checks) {
    lines.push(`${c.pass ? "PASS" : "FAIL"}  [${c.weight}] ${c.name} — ${c.detail}`);
  }
  if (result.notes.length) {
    lines.push("", "Notes:");
    for (const n of result.notes) lines.push(`  - ${n}`);
  }
  lines.push(
    "",
    "This is a structural-validity report, not a predicted ATS score. It checks that the",
    "document parses, uses one column, carries contact details in the body, has conventional",
    "sections, and uses the posting's exact terminology in the body."
  );
  return lines.join("\n");
}

export default { verify, renderReport, extractRequiredTerms, hasTerm, loadResumeText, WEIGHTS };
