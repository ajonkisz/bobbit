# CLF Wave 3/4 — observe-mode telemetry report

Evidence gathered for the AJ-decision list at the end of this PR's summary
(whether/how to flip the F14 thinking-router and tool-approve heuristic into
enforce mode, and whether to revisit model-tiering). Two parts: (1) an honest
attempt to mine this machine's REAL recorded decisions, and (2) a synthetic-
but-real fallback evaluation since (1) came back empty.

## Part 1 — real usage mining (result: zero recorded decisions)

Every `ContextTraceStore` (`session-context-trace/`) on this machine was
located and checked for any `TraceEntry.decisions[]` content:

| Location | Trace files | Size | Decisions found |
|---|---|---|---|
| `~/Documents/dev/bobbit/.bobbit/state/session-context-trace` (AJ's actual daily-driver checkout, upstream `G-Research/bobbit`, branch `gr-aj-current`) | 1,265 | 5.1 MB | **0** |
| `~/Documents/dev/bobbit-aj/.bobbit/state/*` (this fork's own dev instance) | n/a — `session-context-trace/` directory doesn't exist at all | — | **0** (the directory is created lazily on first `appendTrace`; it has never been created, meaning `LifecycleHub.dispatch()` has never run against this checkout) |
| Every other `~/Documents/dev/bobbit*` worktree | — | — | **0** (checked via `find … -name session-context-trace`; only the one directory above exists anywhere on the machine) |

Root cause, not a bug: the CLF classifiers (thinking-router W1b, tool-approve
heuristic W2.5) only exist in the `bobbit-aj` (`ajonkisz/bobbit`) fork's
codebase — the Fable program's experimental lane. AJ's actual daily-driver
Bobbit instance runs the upstream `G-Research/bobbit` checkout, which doesn't
have this code at all, so its 1,265 real trace files (real usage, June 17 –
July 4) predate/exclude the classifiers entirely. The fork's own dev instance
has a real `.bobbit/state/` (bg-processes, tool-guard, etc. all populated),
but no `session-context-trace/` directory ever got created — meaning even
`dispatch()` (the pre-existing, harmless context-provider fan-out, not the
decision seam) has never run in this fork's own daily dev usage, most likely
because the default project has no context providers installed (matches
`transparency-panel.spec.ts`'s own comment: "the default E2E test project has
no context providers").

Also checked and ruled out as alternate real-data sources:
- `~/.pi/agent/sessions/` (pi's own transcript store) — two project
  directories exist, both empty (0 files).
- `.bobbit/state/tool-guard/<id>/` — per-session compiled tool-guard
  extension instances (`guard.ts`), not a permission-grant/deny audit log.
- `.bobbit/state/session-prompts/` (594 files, 55 MB) — prompt-inspector
  section dumps (system prompt, role, tools, goal, AGENTS.md, skills), not
  per-turn verbatim user text; no "User Message" section exists in this
  format, so it can't be grepped for `ultrathink`/`think harder` occurrences.
- `.bobbit/state/claude-code-transcripts/` — only 4 sessions, and the sampled
  file is session *metadata* (title/model/role), not the conversation body.

**Conclusion: there is no real per-decision telemetry to mine on this
machine.** This is itself a useful finding — it means Wave 1(b)/2.5 shipped
genuinely dark from a data standpoint, not just from a behavior standpoint.

## Part 2 — synthetic-but-real evaluation

Per the fallback instruction, since no real transcript-replay mechanism had
data: ran the REAL, unmodified classifier functions
(`classifyThinkingLevel`, `classifyToolApprove`, `classifyModelTier`) against
a small hand-authored corpus modeled on genuinely typical Bobbit usage
patterns (bug fixes, refactors, verification-harness reviewer roles,
tool-guard categories). This is labeled synthetic throughout — it is NOT
claimed to be mined from logs.

### Thinking router — 14 prompts

| Prompt | Verdict |
|---|---|
| "fix this typo in the README" | abstain |
| "the login button is misaligned on mobile, can you fix it" | abstain |
| "ultrathink: redesign the entire auth flow and session model" | **select xhigh** |
| "please refactor the payment module end to end, think harder about edge cases" | **select xhigh** |
| "add a unit test for the new endpoint" | abstain |
| "why is this test flaky" | abstain |
| "rewrite the whole state management layer from scratch, this is a huge architectural change" | abstain |
| "bump the version number" | abstain |
| "investigate this deep race condition across three services and propose a fix" | abstain |
| "update the changelog" | abstain |
| "ultrathink about whether this migration is safe under concurrent writes" | **select xhigh** |
| "can you rename this variable" | abstain |
| "design a new caching strategy for the entire API layer" | abstain |
| "fix the off-by-one error in the pagination logic" | abstain |

**3/14 select, 11/14 abstain.** Notably: "rewrite the whole state management
layer from scratch" and "design a new caching strategy for the entire API
layer" — both clearly high-effort asks — correctly ABSTAIN rather than guess,
exactly per the classifier's own "no prompt-shape heuristic tiers" discipline.
This is the classifier working as designed, not a gap: catching those would
require a model-backed tiebreak the design doc explicitly defers past this
wave, not a bigger regex.

### Tool-approve heuristic — 13 tool asks

| Tool (group) | Verdict |
|---|---|
| read (File System) | select allow |
| ls (File System) | select allow |
| grep (File System) | select allow |
| find (File System) | select allow |
| edit (File System) | abstain |
| write (File System) | abstain |
| bash (Shell) | abstain |
| bash_bg (Shell) | abstain |
| team_dismiss (Team) | select deny |
| goal_archive_child (Children) | select deny |
| readonly_bash (PR Walkthrough) | select deny |
| web_search (Web) | abstain |
| read (**PR Walkthrough**, not File System) | **select deny** |

The last row is a deliberate adversarial case, not a real example: a tool
literally named `read` but in the `PR Walkthrough` group. It correctly
resolves to `deny`, not `allow` — the dangerous-group rule is checked before
the read-only-safe rule in `RULES`, so group-based denial always wins over a
name match. This confirms the documented "same-named tool from another group
must abstain [not auto-allow]" invariant holds even when that other group
happens to also be dangerous — the classifier fails toward the more
conservative verdict, not toward abstain-in-a-way-that-loses-the-deny.

**No real grant/deny history exists to spot-check "would-have-been-wrong"
denials against** (see Part 1 — `tool-guard/` isn't an audit log). This is
flagged explicitly rather than fabricated: the honest state is "we don't know
whether any of this classifier's `deny`s would have blocked something a human
actually wanted to grant," which is exactly the gap enforce-mode telemetry
(once turned on) would close.

### Model-tier classifier — 15 roles

| Role | Verdict |
|---|---|
| team-lead, architect, security-reviewer, spec-auditor, bug-hunter | frontier |
| coder, reviewer, code-reviewer, test-engineer, qa-tester | mid |
| docs-writer | cheap |
| assistant, general, ux-designer, pr-reviewer | abstain |

Exactly mirrors the VER-02 table by construction (it's a direct port) — this
table is a correctness check on the port, not new information. `pr-reviewer`
(a market-pack role, not a built-in) correctly abstains — the VER-02 table
was scoped to built-in roles only, and the classifier doesn't guess for
pack-shipped roles it wasn't told about.

## AJ decision list (enforce-mode flips) — see PR summary

The three flip decisions this report feeds, each with a recommendation, are
listed in the PR description rather than duplicated here — this file is the
evidence, not the decision record.
