// CLF-W4: trace-row integration — proves the REAL registered model-tier
// classifier (not a fake classifier) lands a Decision in `ContextTraceStore`'s
// persisted `TraceEntry.decisions[]` when consulted through
// `LifecycleHub.dispatchDecision` during an active turn, mirroring
// `thinking-router-trace-integration.test.ts`'s own structure for the F14
// router. Exercises `session-setup.ts::resolveDynamicContext`'s wiring
// directly (the actual production call site) rather than calling
// `dispatchDecision` by hand, since the ordering constraint (consult AFTER
// the `sessionSetup` dispatch, so an active TraceEntry already exists) is the
// thing most likely to regress.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextTraceStore } from "../src/server/agent/context-trace-store.ts";
import { LifecycleHub, type HookCtx } from "../src/server/agent/lifecycle-hub.ts";
import type { ProviderContribution } from "../src/server/agent/pack-contributions.ts";
import type { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import { ModuleHost } from "../src/server/extension-host/module-host-worker.ts";
import { resolveDynamicContext, type SessionSetupPlan, type PipelineContext } from "../src/server/agent/session-setup.ts";
import {
	registerModelTierClassifier,
	MODEL_TIER_CLASSIFIER_ID,
	MODEL_TIER_POINT,
	MODEL_TIER_KIND,
} from "../src/server/agent/model-tier-classifier.ts";

function tmpDir(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "model-tier-trace-")));
}

function registry(providers: ProviderContribution[]): PackContributionRegistry {
	return { listProviders: () => providers } as unknown as PackContributionRegistry;
}

function makeHub(tmp: string, moduleHost: ModuleHost): { hub: LifecycleHub; trace: ContextTraceStore } {
	const trace = new ContextTraceStore(path.join(tmp, "state"));
	const hub = new LifecycleHub({
		registry: registry([]),
		moduleHost,
		trace,
		gatewayInfo: () => ({ baseUrl: "https://gateway.test", token: "token-1" }),
	});
	registerModelTierClassifier(hub);
	return { hub, trace };
}

function plan(tmp: string, id: string, roleName: string | undefined): SessionSetupPlan {
	return {
		id,
		mode: "normal",
		title: "model-tier trace test",
		cwd: tmp,
		roleName,
		bridgeOptions: { cwd: tmp },
	} as SessionSetupPlan;
}

describe("Model-tier classifier — real registration + trace-row integration (CLF-W4)", () => {
	it("a frontier-tier role produces a real SELECT that persists into TraceEntry.decisions[] via resolveDynamicContext", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const { hub, trace } = makeHub(tmp, moduleHost);
			const ctx = { lifecycleHub: hub } as unknown as PipelineContext;

			await resolveDynamicContext(plan(tmp, "sess-frontier", "team-lead"), ctx);

			const rows = trace.readTrace("sess-frontier");
			assert.equal(rows.length, 1, "sessionSetup's own dispatch() call must write the entry the model-tier decision attaches to");
			const decisions = rows[0].decisions ?? [];
			const modelTierRow = decisions.find((d) => d.point === MODEL_TIER_POINT && d.decisionKind === MODEL_TIER_KIND);
			assert.ok(modelTierRow, "expected a (session-spawn, model-tier) decision row");
			assert.deepEqual(modelTierRow!.consulted, [MODEL_TIER_CLASSIFIER_ID]);
			assert.equal(modelTierRow!.decision.kind, "select");
			assert.equal((modelTierRow!.decision as { choice: string }).choice, "frontier");
			assert.equal(modelTierRow!.applied, undefined, "CLF-W4 is observe-only — applied must never be set");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("an untiered role (assistant) abstains and still lands the abstain outcome in the trace", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const { hub, trace } = makeHub(tmp, moduleHost);
			const ctx = { lifecycleHub: hub } as unknown as PipelineContext;

			await resolveDynamicContext(plan(tmp, "sess-untiered", "assistant"), ctx);

			const rows = trace.readTrace("sess-untiered");
			const decisions = rows[0].decisions ?? [];
			const modelTierRow = decisions.find((d) => d.point === MODEL_TIER_POINT && d.decisionKind === MODEL_TIER_KIND);
			assert.ok(modelTierRow);
			assert.deepEqual(modelTierRow!.decision, { kind: "abstain" });
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("never touches plan.bridgeOptions.initialModel — pure telemetry, zero behavior change", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const { hub } = makeHub(tmp, moduleHost);
			const ctx = { lifecycleHub: hub } as unknown as PipelineContext;
			const p = plan(tmp, "sess-no-mutate", "docs-writer");
			p.bridgeOptions.initialModel = "acme/already-resolved-model";

			await resolveDynamicContext(p, ctx);

			assert.equal(p.bridgeOptions.initialModel, "acme/already-resolved-model", "model-tier consult must never mutate the already-resolved spawn model");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("is a no-op (no throw) when no lifecycleHub is configured", async () => {
		const tmp = tmpDir();
		await resolveDynamicContext(plan(tmp, "sess-no-hub", "coder"), {} as PipelineContext);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("dispatchDecision never throws once registerModelTierClassifier has run, even with no active TraceEntry", async () => {
		const tmp = tmpDir();
		const moduleHost = new ModuleHost({ timeoutMs: 5_000 });
		try {
			const { hub } = makeHub(tmp, moduleHost);
			const decision = await hub.dispatchDecision(MODEL_TIER_POINT, MODEL_TIER_KIND, { sessionId: "no-turn-sess", cwd: tmp }, { roleName: "coder" });
			assert.equal(decision.kind, "select");
			assert.equal((decision as { choice: string }).choice, "mid");
		} finally {
			moduleHost.dispose();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
