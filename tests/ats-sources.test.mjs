/**
 * Tests for ats-sources.mjs — normalization and dedupe, with no network.
 *
 * Run: node tests/ats-sources.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boardUrl,
  htmlToText,
  fetchBoard,
  fetchAllBoards,
  dedupe,
  DEFAULT_BOARDS,
} from "../src/sources/ats-sources.mjs";

test("boardUrl builds the documented endpoints", () => {
  assert.equal(
    boardUrl("greenhouse", "acme"),
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"
  );
  assert.equal(
    boardUrl("lever", "acme"),
    "https://api.lever.co/v0/postings/acme?mode=json"
  );
  assert.equal(
    boardUrl("ashby", "acme"),
    "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true"
  );
  assert.equal(
    boardUrl("workable", "acme"),
    "https://apply.workable.com/api/v1/widget/accounts/acme?details=true"
  );
});

test("boardUrl rejects an unknown ATS", () => {
  assert.throws(() => boardUrl("monster", "acme"), /unknown ATS/);
});

test("htmlToText keeps text order and strips markup", () => {
  const html = "<p>Build <strong>pipelines</strong>.</p><ul><li>Python</li><li>AWS</li></ul>";
  const text = htmlToText(html);
  assert.ok(text.includes("Build pipelines."));
  assert.ok(text.includes("- Python"));
  assert.ok(text.includes("- AWS"));
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes("&nbsp;"));
});

test("htmlToText decodes entities", () => {
  assert.equal(htmlToText("A &amp; B &lt;x&gt;"), "A & B <x>");
});

test("greenhouse posting normalizes to the shared shape", async () => {
  const ctx = {
    fetchJson: async () => ({
      jobs: [
        {
          title: "Senior Engineer",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          location: { name: "Remote - US" },
          content: "<p>Do the thing.</p>",
          updated_at: "2026-10-01T00:00:00Z",
          departments: [{ name: "Eng" }],
        },
      ],
    }),
  };
  const jobs = await fetchBoard({ ats: "greenhouse", slug: "acme", company: "Acme" }, ctx);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, "Acme");
  assert.equal(jobs[0].title, "Senior Engineer");
  assert.equal(jobs[0].description, "Do the thing.");
  assert.equal(jobs[0].ats, "greenhouse");
  assert.deepEqual(jobs[0].tags, ["Eng"]);
});

test("posting without a description is dropped", async () => {
  const ctx = {
    fetchJson: async () => ({
      jobs: [{ title: "No JD", absolute_url: "https://x/1", location: { name: "Remote" } }],
    }),
  };
  const jobs = await fetchBoard({ ats: "greenhouse", slug: "acme" }, ctx);
  assert.equal(jobs.length, 0, "a posting with no JD text cannot be tailored to");
});

test("one failing board does not fail the run", async () => {
  const ctx = async (url) => {
    if (url.includes("bad")) throw new Error("boom");
    return { jobs: [{ title: "T", absolute_url: "https://x/1", content: "D", location: { name: "R" } }] };
  };
  const { jobs, errors } = await fetchAllBoards(
    [
      { ats: "greenhouse", slug: "good" },
      { ats: "greenhouse", slug: "bad" },
    ],
    { fetchJson: ctx }
  );
  assert.equal(jobs.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].board, /bad/);
});

test("dedupe collapses the same role from two boards", () => {
  const jobs = [
    { company: "Acme", title: "Engineer", location: "Remote", description: "a", url: "1" },
    { company: "acme", title: "engineer", location: "REMOTE", description: "b", url: "2" },
    { company: "Other", title: "Engineer", location: "Remote", description: "c", url: "3" },
  ];
  assert.equal(dedupe(jobs).length, 2);
});

test("default boards are all a known ATS kind", () => {
  for (const b of DEFAULT_BOARDS) {
    assert.ok(["greenhouse", "lever", "ashby", "workable"].includes(b.ats));
    assert.ok(b.slug && typeof b.slug === "string");
  }
});
