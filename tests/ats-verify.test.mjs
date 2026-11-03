/**
 * Tests for ats-verify.mjs.
 *
 * Run: node tests/ats-verify.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  verify,
  extractRequiredTerms,
  hasTerm,
  findSections,
  sectionBody,
  lines,
  normalize,
  renderReport,
} from "../src/tailor/ats-verify.mjs";

/** A resume that should pass every check. */
const GOOD_RESUME = `
Jane Developer
jane.developer@example.com | +1 (555) 010-2030 | Austin, TX | linkedin.com/in/janedev

Summary
Senior software engineer with eight years of experience building data platforms.

Experience
Acme, Inc. - Senior Software Engineer - January 2021 - March 2024
- Built Python data pipelines processing 2TB per day and cut ETL cost by 40%.
- Led migration of twelve services to Kubernetes and PostgreSQL.

Globex LLC - Software Engineer - April 2018 - December 2020
- Built an AWS event pipeline serving 50 requests per second.

Education
State University - BS Computer Science - May 2018

Skills
Python, Kubernetes, PostgreSQL, AWS, TypeScript
`.trim();

const JD = `
We are hiring a Senior Python Engineer.

Requirements:
- 5+ years of Python
- Kubernetes experience
- PostgreSQL
- Strong communication skills
`.trim();

test("normalize collapses whitespace but keeps line structure", () => {
  const out = normalize("a   b\n\n\n\nc");
  assert.equal(out, "a b\n\nc");
});

test("findSections locates conventional headings", () => {
  const s = findSections(lines(GOOD_RESUME));
  assert.ok(s.has("summary"));
  assert.ok(s.has("experience"));
  assert.ok(s.has("education"));
  assert.ok(s.has("skills"));
});

test("sectionBody stops at the next heading", () => {
  const ls = lines(GOOD_RESUME);
  const s = findSections(ls);
  const body = sectionBody(ls, s, "experience").join("\n");
  assert.ok(body.includes("Acme, Inc."));
  assert.ok(!body.includes("State University"));
});

test("a good resume scores high and passes every check", () => {
  const r = verify({ text: GOOD_RESUME, raw: GOOD_RESUME }, { description: JD });
  assert.equal(r.score, 100, `expected 100, got ${r.score}: ${JSON.stringify(r.checks, null, 2)}`);
  for (const c of r.checks) {
    assert.ok(c.pass, `check failed: ${c.name} — ${c.detail}`);
  }
});

test("extractRequiredTerms pulls requirement lines and years-of-X", () => {
  const terms = extractRequiredTerms(JD);
  assert.ok(terms.some((t) => /python/i.test(t)), `expected python, got ${JSON.stringify(terms)}`);
  assert.ok(terms.some((t) => /kubernetes/i.test(t)), `expected kubernetes, got ${JSON.stringify(terms)}`);
  assert.ok(terms.some((t) => /postgresql/i.test(t)), `expected postgresql, got ${JSON.stringify(terms)}`);
});

test("hasTerm matches exact, plural and parenthetical forms", () => {
  assert.ok(hasTerm("I know Kubernetes", "kubernetes"));
  assert.ok(hasTerm("Built pipelines", "pipeline"));
  assert.ok(hasTerm("Kubernetes (K8s) in production", "Kubernetes"));
  assert.ok(hasTerm("K8s operator", "Kubernetes (K8s)"));
  assert.ok(!hasTerm("I know Go", "rust"));
});

test("missing contact details in the body is penalised", () => {
  const noContact = GOOD_RESUME.replace("jane.developer@example.com | +1 (555) 010-2030 | Austin, TX | linkedin.com/in/janedev", "");
  const r = verify({ text: noContact }, { description: JD });
  const check = r.checks.find((c) => c.name === "contactInBody");
  assert.equal(check.pass, false);
  assert.ok(r.score < 100);
  assert.ok(r.notes.some((n) => /contact details in the document body/i.test(n)));
});

test("a multi-column header is detected", () => {
  const twoCol = `Jane Developer
jane@example.com +1 555 010 2030

Summary    Experience    Education    Skills
Senior engineer with eight years of data platform experience.`;
  const r = verify({ text: twoCol, raw: twoCol }, { description: JD });
  const check = r.checks.find((c) => c.name === "singleColumn");
  assert.equal(check.pass, false);
  assert.ok(r.notes.some((n) => /multi-column/i.test(n)));
});

test("mixed date formats are penalised", () => {
  const mixed = GOOD_RESUME.replace("January 2021 - March 2024", "01/2021 - 03/2024");
  const r = verify({ text: mixed }, { description: JD });
  const check = r.checks.find((c) => c.name === "consistentDates");
  assert.equal(check.pass, false);
});

test("apostrophe years are penalised", () => {
  const apos = GOOD_RESUME.replace("January 2021 - March 2024", "Jan '21 - Mar '24");
  const r = verify({ text: apos }, { description: JD });
  const check = r.checks.find((c) => c.name === "consistentDates");
  assert.equal(check.pass, false);
});

test("a missing required term is reported by name", () => {
  const noK8s = GOOD_RESUME.replace(/Kubernetes, /, "").replace(
    "Led migration of twelve services to Kubernetes and PostgreSQL.",
    "Led migration of twelve services to the cloud."
  );
  const r = verify({ text: noK8s }, { description: JD });
  assert.ok(r.missingTerms.some((t) => /kubernetes/i.test(t)), JSON.stringify(r.missingTerms));
  assert.ok(r.notes.some((n) => /exact wording/i.test(n)));
  assert.ok(r.score < 100);
});

test("a qualification stated only in the summary is flagged as bodyPlacement", () => {
  // Put PostgreSQL only in the summary; remove it from the Skills line.
  const summaryOnly = GOOD_RESUME
    .replace("building data platforms.", "building PostgreSQL data platforms.")
    .replace(/PostgreSQL, /, "")
    .replace("Kubernetes and PostgreSQL.", "Kubernetes and managed databases.");
  const r = verify({ text: summaryOnly }, { description: JD });
  const check = r.checks.find((c) => c.name === "bodyPlacement");
  assert.equal(check.pass, false, JSON.stringify(r.checks, null, 2));
  assert.ok(r.notes.some((n) => /only in the summary/i.test(n)));
});

test("an empty document is a parse failure", () => {
  const r = verify({ text: "" }, { description: JD });
  const check = r.checks.find((c) => c.name === "parsesAsText");
  assert.equal(check.pass, false);
  assert.ok(r.score < 50);
});

test("the report says it is not a predicted ATS score", () => {
  const r = verify({ text: GOOD_RESUME }, { description: JD });
  const report = renderReport(r);
  assert.ok(/not a predicted ATS score/i.test(report));
  assert.ok(/score \d+\/100/.test(report));
});
