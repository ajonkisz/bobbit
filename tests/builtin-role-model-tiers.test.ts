/**
 * Pins the built-in role `model` tiering decided in the D1 follow-up to
 * VER-02 (Fable audit), loaded via the exact same `parseRolesDir` the
 * server uses (`BuiltinConfigProvider` / config cascade lowest layer, see
 * src/server/agent/builtin-config.ts) AND via the real `PackResolver`
 * resolution path used at runtime (`src/server/agent/pack-resolver.ts`).
 *
 * Finding VER-02 (Fable audit) documented a recommended per-role `model`
 * tier table (docs/internals.md § Recommended model tiers (VER-02);
 * docs/design/per-role-model-overrides.md §1.6) but deliberately shipped
 * NO literal `model:` default on any built-in role, because `role.model`
 * binding is a hard contract: a `setModel` failure or read-back mismatch
 * throws, and only falls back to `default.sessionModel` when the operator
 * has separately opted into `allowSessionModelFallback` (off by default —
 * see docs/session-model-fallback.md and tests/controlled-model-fallback.
 * test.ts). A hardcoded literal `<provider>/<modelId>` default therefore
 * risks hard-failing every spawn of that role on an install that doesn't
 * have that exact model configured.
 *
 * AJ reviewed that finding and approved applying the tiering NARROWLY,
 * for the single tier the table calls "purely mechanical" (Cheap: docs-
 * writer only) — NOT the "Mid" tier (coder, reviewer, code-reviewer,
 * test-engineer, qa-tester), which are implementer/reviewer-class roles
 * and stay on the operator/global default, and NOT the "Frontier" tier
 * (team-lead, architect, security-reviewer, spec-auditor, bug-hunter),
 * which are unchanged by design. This keeps the blast radius of the
 * availability-fallback risk to one low-stakes, prose-only role, whose
 * own prompt already forbids touching runtime logic — and which the
 * operator can still override per-role (Model tab / role YAML) if
 * `anthropic/claude-haiku-4-5` isn't available on their install.
 *
 * If a future change wants to extend the literal-model default beyond
 * docs-writer, update this test deliberately alongside evidence that the
 * availability-fallback risk has been addressed more broadly (e.g. a
 * symbolic tier that only picks among a gateway's actually-discovered
 * models, the way `selectAigwModelForRoleTier` already does for the
 * AI-Gateway auto-select path — see tests/model-utils.test.ts and finding
 * F5-model-aigw).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const { parseRolesDir } = await import("../src/server/agent/builtin-config.ts");
const { PackResolver, RoleLoader } = await import("../src/server/agent/pack-resolver.ts");
const roleStore = await import("../src/server/agent/role-store.ts");

const ROLES_DIR = path.resolve(import.meta.dirname, "..", "defaults", "roles");
const DEFAULTS_DIR = path.resolve(import.meta.dirname, "..", "defaults");

/** The only role AJ approved for a literal model default (Cheap tier, VER-02). */
const CHEAP_TIER_ROLE = "docs-writer";
const CHEAP_TIER_MODEL = "anthropic/claude-haiku-4-5";

/** Mid tier: implementer/reviewer-class roles, explicitly left unchanged. */
const MID_TIER_ROLES = ["coder", "reviewer", "code-reviewer", "test-engineer", "qa-tester"];

/** Frontier tier: team-lead/orchestration/high-stakes-review roles, unchanged. */
const FRONTIER_TIER_ROLES = ["team-lead", "architect", "security-reviewer", "spec-auditor", "bug-hunter"];

/** Not in the VER-02 tier table at all — no documented recommendation. */
const UNTIERED_ROLES = ["assistant", "general", "ux-designer"];

function roleModelOf(roles: ReturnType<typeof parseRolesDir>, name: string): string | undefined {
	const role = roles.find((r) => r.name === name);
	assert.ok(role, `expected built-in role "${name}" to exist`);
	return role!.model;
}

describe("built-in role model tiering (VER-02 + D1 low-stakes-only application)", () => {
	const roles = parseRolesDir(ROLES_DIR);

	it("loads at least one built-in role (sanity check on the fixture path)", () => {
		assert.ok(roles.length > 0, "expected parseRolesDir to find built-in role YAMLs");
	});

	it(`ships the approved Cheap-tier literal model default on "${CHEAP_TIER_ROLE}" only`, () => {
		assert.equal(
			roleModelOf(roles, CHEAP_TIER_ROLE),
			CHEAP_TIER_MODEL,
			`"${CHEAP_TIER_ROLE}" should carry the approved low-stakes model default`,
		);
	});

	it("leaves Mid-tier (implementer/reviewer-class) roles without a literal model default", () => {
		for (const name of MID_TIER_ROLES) {
			assert.equal(
				roleModelOf(roles, name),
				undefined,
				`role "${name}" is Mid tier (implementer/reviewer class) and must stay on the operator default — ` +
					`AJ's brief explicitly excludes implementer/reviewer/team-lead classes from this change`,
			);
		}
	});

	it("leaves Frontier-tier (team-lead/high-stakes-review) roles without a literal model default", () => {
		for (const name of FRONTIER_TIER_ROLES) {
			assert.equal(
				roleModelOf(roles, name),
				undefined,
				`role "${name}" is Frontier tier and must stay on the operator default (unchanged by design)`,
			);
		}
	});

	it("leaves untiered roles (not in the VER-02 table) without a literal model default", () => {
		for (const name of UNTIERED_ROLES) {
			assert.equal(roleModelOf(roles, name), undefined, `role "${name}" has no documented tier and must not change`);
		}
	});

	it("no OTHER built-in role ships a literal model default beyond the one approved exception", () => {
		for (const role of roles) {
			if (role.name === CHEAP_TIER_ROLE) continue;
			assert.equal(
				role.model,
				undefined,
				`role "${role.name}" must not set a literal model default (VER-02: hardcoding an unavailable ` +
					`model would hard-fail every spawn of that role — see docs/session-model-fallback.md). Only ` +
					`"${CHEAP_TIER_ROLE}" was approved for this.`,
			);
		}
	});

	it(`"${CHEAP_TIER_ROLE}"'s model string is well-formed per role-store's validator`, () => {
		assert.equal(roleStore.validateModelString(CHEAP_TIER_MODEL), CHEAP_TIER_MODEL);
	});
});

describe("built-in role model tiering resolves through the real PackResolver path", () => {
	it("resolves docs-writer.model via the same builtin PackEntry/RoleLoader the server's config cascade uses", () => {
		const builtinEntry = {
			id: "builtin",
			kind: "builtin" as const,
			scope: "builtin" as const,
			path: DEFAULTS_DIR,
			readOnly: true,
			layout: "defaults-tree" as const,
		};
		const resolver = new PackResolver([builtinEntry], [new RoleLoader() as any]);
		const resolved = resolver.resolve<import("../src/server/agent/role-store.ts").Role>("roles");
		const docsWriter = resolved.find((r) => r.name === CHEAP_TIER_ROLE);
		assert.ok(docsWriter, "expected PackResolver to resolve the docs-writer role from the builtin defaults-tree");
		assert.equal(docsWriter!.item.model, CHEAP_TIER_MODEL);

		// Guard: a Mid-tier role resolved through the identical path must NOT
		// have picked up a model default.
		const coder = resolved.find((r) => r.name === "coder");
		assert.ok(coder, "expected PackResolver to resolve the coder role from the builtin defaults-tree");
		assert.equal(coder!.item.model, undefined);
	});
});
