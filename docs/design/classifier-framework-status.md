# CLF — Classifier Framework lane: in-repo status ledger

Status: Wave 4 shipped (model-tier classifier, observe-only telemetry) and
Wave 3 shipped (F14 thinking-router apply mode, behind
`BOBBIT_CLF_THINKING_ROUTER=enforce`). The full design (interception points,
the select/abstain `Decision` model, the RO/RW mount-property safety model,
and the phased wave plan) lives in the Fable program's classifier-framework
design note — that document is tracked outside this repo, so it is referenced
here only by name, never by machine path (see AGENTS.md's "no machine paths in
source" convention). This file is the in-repo mirror of that document's own
"Wave N status" sections, kept close to the code it describes so a reader
doesn't need the external doc just to see what's shipped vs. deferred.

See [clf-w3-w4-telemetry-report.md](clf-w3-w4-telemetry-report.md) for the
observe-mode telemetry evidence (real usage mining attempt + synthetic-but-real
evaluation) behind the Wave 3 enforce-mode decision and Wave 4's would-have-
chosen model tiers.

## Wave 0(b) — the seam, dark

`decision-types.ts` + `LifecycleHub.dispatchDecision`/`allowDecisionPoint`/
`registerDecisionClassifier`: a typed `Decision<TChoice>` (`select` |
`abstain` — no `mutate`/`veto` yet, see `decision-types.ts`'s header for why),
a per-`(point, kind)` allow-list, and outcome tracing. No production call site
consults it. Pinned by `tests/lifecycle-hub-dispatch-decision.test.ts`.

## Wave 1(a) — transparency first

`ContextTraceStore.appendDecision` + the transparency-panel decision rows,
landed **before** any real classifier, so a decision is always user-visible
the moment one exists. See `tests/e2e/ui/transparency-panel.spec.ts`'s
CLF-W1a block.

## Wave 1(b) — F14 thinking router (first real classifier)

`thinking-router-classifier.ts`: a small deterministic regex rule table
(`ultrathink` / `think harder` → `xhigh`), registered for real at gateway
construction (`registerThinkingRouterClassifier`, `server.ts`). Observe-mode
only at this wave — `SessionManager.enqueuePrompt` records the decision but
nothing applies it (no `setThinkingLevel` call on this path). Apply mode
lands in Wave 3, below.

## Wave 2 — tool-approve decision seam (harness only)

`tool-approve-classifier.ts`: the `(tool-call, tool-approve)` point/kind pair,
`ToolApproveVerdict` (`"allow" | "deny"`), `ToolApproveArg` (`toolName`,
`toolGroup`, optional `roleName` — no argument/command content), and the
`BOBBIT_CLF_TOOL_APPROVE` flag reader (`isToolApproveEnforceMode`).
`SessionManager.requestToolGrant` consults the seam for real on every
tool-permission ask — a genuine production call site, unlike Wave 0(b)'s dark
seam. `server.ts` only `allowDecisionPoint`s the pair at gateway construction;
it registers **no classifier**, so every consult abstains and production
behavior is provably unconditionally unchanged. Deliberately deferred: a real
classifier (this wave's whole point was shipping the harness + safety
mechanics first — deny short-circuits in enforce mode, allow never
auto-applies, byte-identical when the flag/hub/registration is absent — see
that file's header for the full mechanics).

## Wave 2.5 — the real tool-approve heuristic (this ledger's current head)

`tool-approve-heuristic.ts`: the first REAL classifier at
`(tool-call, tool-approve)`, mirroring Wave 1(b)'s "seam ships dark, first
real customer follows" split.

**Conservative by construction.** `ToolApproveArg` carries only tool
identity (name + group + role), never command/argument content, so this
classifier can only reason about *which* tool is being asked for, never
*what a specific invocation would do*. That rules out inventing an
argument-aware read-only policy here — see
`src/server/pr-walkthrough/walkthrough-readonly-policy.ts` for why that's a
deliberately separate, narrower, argument-aware allowlist scoped to the PR
Walkthrough pack's own `readonly_bash` tool, not a general-purpose model.

Given that constraint, the rule table is narrow and reuses existing rule
sources rather than inventing new ones:

- **`select(deny)`** when the tool's group is one of `defaults/tool-group-
  policies.yaml`'s existing `never`-by-default groups (`Children`, `Team`,
  `PR Walkthrough`) — the codebase's own established "these tool categories
  are off-limits by default" source of truth, reused verbatim (kept in sync by
  a pinning test that parses that YAML file directly).
- **`select(allow)`** for a hand-curated read-only-safe allowlist: the
  builtin File System tools that are non-mutating by construction (`read`,
  `ls`, `grep`, `find`), matched on the tool name **and** the builtin
  "File System" group — a pack/MCP tool merely *named* `read` in another
  group abstains, so a future CQ-03 auto-apply consumer can trust recorded
  `allow` verdicts (harmless telemetry today, a widening hazard later without
  the group restriction). Deliberately excludes `bash`/`bash_bg` even though
  they're very often used read-only — this classifier has no visibility into
  the actual command, so treating the whole tool as safe would be wrong the
  moment it's used for anything else.
- Everything else: `abstain`. No ambiguity guessing, same discipline as
  Wave 1(b)'s thinking-router rule table.

**Registration is a SEPARATE gate from enforcement.** `server.ts` registers
this classifier (next to Wave 2's `allowDecisionPoint` call) only when
`BOBBIT_CLF_TOOL_APPROVE` is set to ANY value at all (`isToolApproveHeuristic
Enabled`) — unset stays byte-identical to Wave 2's harness-only state (zero
classifiers, every consult abstains), pinned end-to-end against a real booted
gateway (`tests/e2e/tool-approve-heuristic-registration.spec.ts`), not just at
the unit level. Whether a registered classifier's `deny` verdict actually
*auto-applies* is the separate, pre-existing `isToolApproveEnforceMode` gate
(`BOBBIT_CLF_TOOL_APPROVE=enforce` exactly) — so `BOBBIT_CLF_TOOL_APPROVE=
observe` registers the classifier for pure telemetry (decisions recorded and
visible in the transparency panel — see
`tests/e2e/ui/transparency-panel-tool-approve-heuristic.spec.ts`) with zero
behavior change, and `=enforce` additionally lets a `deny` short-circuit
`requestToolGrant`. An `allow` verdict never auto-applies in either mode this
wave — it still needs the CQ-03 operator-confirmation permit for widening
(see below).

**Deliberately still deferred** (unchanged from Wave 2's own list, mostly
still pending AJ's trust-tier decision):

- The CQ-03 operator-confirmation permit wiring for auto-`allow` widening.
- A model-backed cascade for tools the deterministic rules abstain on.
- Any argument/command-aware policy (see the PR Walkthrough pointer above) —
  this classifier will never grow one; that's a different, separate seam.
- The pre-spawn apply barrier and the per-turn decision budget mentioned in
  the design note's phased plan.

## Wave 3 — F14 thinking-router APPLY mode

`thinking-router-classifier.ts::isThinkingRouterApplyMode()` +
`SessionManager.enqueuePrompt`/`canApplyThinkingRouterDecision`: the first
Wave-1(b)/2 classifier to graduate from record-only to actually changing live
session state, mirroring Wave 2.5's own registration/enforcement split but for
a *select* verdict rather than a *deny*.

**Three-state mode flag** (`BOBBIT_CLF_THINKING_ROUTER`), same shape as
`BOBBIT_CLF_TOOL_APPROVE`: absent or any value other than the exact string
`"enforce"` (including `"observe"`) stays byte-identical to Wave 1(b) — the
decision is recorded, nothing is applied. `=enforce` calls
`session.rpcClient.setThinkingLevel(choice)` with the classifier's exact
selected level, transiently for that one turn (never persisted as
`spawnPinnedThinkingLevel` — the next prompt re-consults from scratch, so a
`fix this typo` prompt right after an `ultrathink` one drops back to the
non-`select`ed default rather than staying pinned at `xhigh`).

**Precedence — the pinned safety invariant.** Apply mode must never override a
human decision that already exists for this session:

- a role-level `thinkingLevel` override (`resolveRoleThinkingLevel`) — the
  role author already made a considered choice;
- `session.thinkingLevelUserPinned` — set ONLY by the explicit
  `set_thinking_level` ws action (the composer's slider), never by spawn-time
  role/preference resolution (which sets the pre-existing
  `spawnPinnedThinkingLevel` field instead — a different field, deliberately,
  since that one already meant "the value currently pinned" for unrelated
  reasons and conflating "pinned at spawn" with "the user picked this on
  purpose" would have broken the precedence check the day a role also had a
  thinkingLevel default).

`SessionManager.canApplyThinkingRouterDecision` gates on both; neither being
set means there was no human decision to protect, so apply mode is free to
route per-prompt as usual. An `abstain` never calls `setThinkingLevel`
regardless of mode. Pinned end-to-end (including both precedence cases and the
observe/absent/explicit-"observe" byte-identical cases) by
`tests/session-manager-thinking-router.test.ts`'s CLF-W3 describe block.

**Transparency: `applied` field.** `DecisionOutcome`/`TransparencyDecision`
gained an optional `applied?: boolean`, set by the CALLER (via
`dispatchDecision`'s new `opts.applyIfSelected`, decided from the mode flag +
precedence BEFORE the classifier runs — never from the resulting choice) and
surfaced in the transparency panel as a `(applied)` suffix on the verdict line
plus an explicit `applied: yes` row when expanded. Omitted for `abstain` and
for any pre-Wave-3 `dispatchDecision` caller that doesn't pass the new opts
arg — additive, no existing trace row changes shape.

**Known gap, flagged not fixed:** `thinkingLevelUserPinned` is in-memory only
and does not currently survive a session restore/respawn — re-setting it after
a restart is one click, and the alternative (persisting it into the session
snapshot) was judged out of scope for this wave's actual risk. Revisit if a
restore-then-immediately-enforce report ever surfaces.

## Wave 4 — model-tier classifier (observe-only, new decision point)

`model-tier-classifier.ts`: the first classifier at a brand-new decision
point, `(session-spawn, model-tier)` (added to `DECISION_POINTS`), consulted
once per session spawn from `session-setup.ts::resolveDynamicContext` — right
after the `sessionSetup` lifecycle hook's own `dispatch()` call, so there is
already an active `TraceEntry` to attach into (same ordering constraint the
F14 router's own trace-integration tests pin).

**What it proposes.** A symbolic tier label — `"cheap" | "mid" | "frontier"`
— NEVER a literal `<provider>/<modelId>` string. The rule table is a
byte-for-byte mirror of docs/internals.md's "Recommended model tiers (VER-02)"
table (kept in sync by a pinning test that parses that doc section directly),
keyed on role name only (no prompt content — same identity-only discipline as
the tool-approve heuristic).

**Why observe-only with no enforce flag at all this wave** (unlike Wave 3 /
Wave 2.5's three-state flags): AJ already considered and explicitly deferred
literal per-role model-tiering (the D2.1 lane → PR #89, CLOSED per AJ
reversal — built-in role `model` fields stay unset; see docs/internals.md's
"Why this is guidance and not a shipped default" for the hard-fail-without-
opt-in risk a literal model id carries). Recording only a tier LABEL, and
never reading it back to change `bridgeOptions.initialModel`, sidesteps that
deferral entirely — zero behavior change, zero hard-fail risk — while still
accumulating the exact "would-have-chosen" data that makes a future literal-
tiering decision an informed one instead of a guess. Registered
unconditionally at gateway construction (`registerModelTierClassifier`,
`server.ts`), same as the F14 router's own Wave-1(b) registration — there is
no apply mode to gate a registration flag behind.

**Deliberately deferred:** any apply mode at all (see above — this is a
future lane's job, once/if AJ revisits the D2.1 deferral with this wave's
telemetry in hand); a model-backed cascade for untiered/custom roles (same
"no ambiguity guessing" discipline as every other classifier in this lane).
