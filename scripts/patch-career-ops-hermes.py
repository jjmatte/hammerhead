#!/usr/bin/env python3
"""Apply the proposed Hermes adapter to a career-ops checkout.

This simulates the upstream PR that would land the Hermes fencer, so the
adapter can be exercised against the real rank-pipeline rather than a
reimplementation of it. Nothing here is upstream code; it is a test harness.
"""
import re
import sys
import pathlib

repo = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
rank = repo / "rank-pipeline.mjs"

original = rank.read_text()

# 1. Remove the explicit Hermes rejection.
block = """  if (forced === 'hermes') {
    console.error('Hermes is not supported for batch ranking.');
    return 1;
  }
"""
if block not in original:
    print("ERROR: hermes rejection block not found (upstream changed?)")
    sys.exit(1)
patched = original.replace(block, "")

# 2. Add a Hermes candidate to CLI_CANDIDATES.
pi_line = "  { bin: 'pi', args: p => ['--no-tools', '-p', p] },"
if pi_line not in patched:
    print("ERROR: pi candidate not found")
    sys.exit(1)
hermes_line = (
    "  { bin: 'hermes', args: (p) => hermesRankArgs(p), "
    "env: { HERMES_YOLO_MODE: '', HERMES_APPROVALS_SINGLE_QUERY_MODE: 'deny' } },"
)
patched = patched.replace(pi_line, pi_line + "\n" + hermes_line)

# 3. Import the adapter.
anchor = "export const CLI_CANDIDATES = ["
helper = (
    "// Hermes adapter (proposed upstream integration).\n"
    "import { hermesRankArgs } from './hermes-rank-args.mjs';\n\n"
)
patched = patched.replace(anchor, helper + anchor)

rank.write_text(patched)
print(f"patched {rank}")
print(f"removed hermes rejection: {block not in patched}")
print(f"added hermes candidate: {hermes_line[:40] in patched}")
