import fs from "node:fs";
import type { Workflow, WorkflowState } from "./types.js";

/**
 * Generate an evidence-focused HTML report for a workflow.
 * Detects the workflow type and delegates to the appropriate renderer.
 */
export function generateReport(workflow: Workflow, state: WorkflowState): string {
	if (workflow.id === "code-review") {
		return generateCodeReviewReport(workflow, state);
	}
	return generateGenericReport(workflow, state);
}

// ---------------------------------------------------------------------------
// Code Review Report
// ---------------------------------------------------------------------------

interface Finding {
	id: string;
	file: string;
	lineRange: string;
	category: string;
	severity: string;
	title: string;
	description: string;
	suggestion: string;
}

function generateCodeReviewReport(workflow: Workflow, state: WorkflowState): string {
	const ctx = state.context;
	const duration = (state.completedAt || Date.now()) - state.startedAt;

	// Parse findings
	let findings: Finding[] = [];
	const findingsArtifact = state.artifacts.find((a) => a.name === "review-findings.json");
	if (findingsArtifact) {
		try {
			const raw = fs.readFileSync(findingsArtifact.filePath, "utf-8");
			findings = JSON.parse(raw);
		} catch {
			// leave empty
		}
	}

	// Read other artifacts
	const artifactContents: Record<string, string> = {};
	for (const a of state.artifacts) {
		if (a.name === "review-findings.json") continue;
		try {
			artifactContents[a.name] = fs.readFileSync(a.filePath, "utf-8");
		} catch {
			artifactContents[a.name] = "(could not read artifact)";
		}
	}

	const verdict = ctx.verdict || "comment";
	const summary = ctx.summary || "";
	const criticalCount = parseInt(ctx.critical_count || "0", 10);
	const majorCount = parseInt(ctx.major_count || "0", 10);
	const minorCount = parseInt(ctx.minor_count || "0", 10);
	const nitCount = parseInt(ctx.nit_count || "0", 10);
	const totalCount = parseInt(ctx.finding_count || String(findings.length), 10);

	const verdictInfo = {
		approve: { label: "APPROVED", color: "#3fb950", icon: "✓" },
		"request-changes": { label: "CHANGES REQUESTED", color: "#f85149", icon: "✗" },
		comment: { label: "COMMENTS", color: "#d29922", icon: "●" },
	}[verdict] || { label: verdict.toUpperCase(), color: "#8b949e", icon: "?" };

	const severityColor: Record<string, string> = {
		critical: "#f85149",
		major: "#d29922",
		minor: "#58a6ff",
		nit: "#8b949e",
	};

	const categoryIcon: Record<string, string> = {
		correctness: "🐛",
		completeness: "📋",
		security: "🔒",
		robustness: "🛡️",
		design: "🏗️",
		performance: "⚡",
		maintainability: "🔧",
	};

	// Group findings by severity
	const bySeverity = (s: string) => findings.filter((f) => f.severity === s);
	const criticals = bySeverity("critical");
	const majors = bySeverity("major");
	const minors = bySeverity("minor");
	const nits = bySeverity("nit");

	const renderFinding = (f: Finding) => `
		<div class="finding" data-severity="${esc(f.severity)}">
			<div class="finding-header">
				<span class="severity-badge" style="background:${severityColor[f.severity] || "#8b949e"}">${esc(f.severity)}</span>
				<span class="category-badge">${categoryIcon[f.category] || "📝"} ${esc(f.category)}</span>
				<span class="finding-id">${esc(f.id)}</span>
			</div>
			<h3 class="finding-title">${esc(f.title)}</h3>
			<div class="finding-location"><code>${esc(f.file)}:${esc(f.lineRange)}</code></div>
			<div class="finding-description">${esc(f.description)}</div>
			${f.suggestion ? `<div class="finding-suggestion"><strong>Suggestion:</strong> ${esc(f.suggestion)}</div>` : ""}
		</div>`;

	const renderSection = (label: string, items: Finding[]) => {
		if (items.length === 0) return "";
		return `
		<section class="findings-section">
			<h2>${esc(label)} <span class="count">(${items.length})</span></h2>
			${items.map(renderFinding).join("\n")}
		</section>`;
	};

	const changeSummary = artifactContents["change-summary.txt"];
	const changeSummarySection = changeSummary
		? `<section class="evidence">
			<h2>Change Summary</h2>
			<pre class="output">${esc(changeSummary)}</pre>
		   </section>`
		: "";

	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code Review: ${esc(ctx.feature_branch || "unknown")}</title>
<style>
${CODE_REVIEW_CSS}
</style></head>
<body><div class="report">
	<div class="header">
		<h1>Code Review</h1>
		<div class="verdict-banner" style="background:${verdictInfo.color}15;border-left:4px solid ${verdictInfo.color}">
			<span class="verdict-icon" style="color:${verdictInfo.color}">${verdictInfo.icon}</span>
			<span class="verdict-label" style="color:${verdictInfo.color}">${verdictInfo.label}</span>
		</div>
		<div class="header-meta">
			<span><strong>Branch:</strong> ${esc(ctx.feature_branch || "unknown")}</span>
			<span><strong>Base:</strong> ${esc(ctx.base_branch || "unknown")}</span>
			<span><strong>Duration:</strong> ${fmtDur(duration)}</span>
		</div>
		${summary ? `<p class="summary">${esc(summary)}</p>` : ""}
		<div class="stats">
			${criticalCount > 0 ? `<span class="stat" style="color:${severityColor.critical}">● ${criticalCount} critical</span>` : ""}
			${majorCount > 0 ? `<span class="stat" style="color:${severityColor.major}">● ${majorCount} major</span>` : ""}
			${minorCount > 0 ? `<span class="stat" style="color:${severityColor.minor}">● ${minorCount} minor</span>` : ""}
			${nitCount > 0 ? `<span class="stat" style="color:${severityColor.nit}">● ${nitCount} nit</span>` : ""}
			${totalCount === 0 ? `<span class="stat" style="color:${severityColor.nit}">No issues found</span>` : ""}
		</div>
	</div>

	${changeSummarySection}
	${renderSection("Critical", criticals)}
	${renderSection("Major", majors)}
	${renderSection("Minor", minors)}
	${renderSection("Nits", nits)}

	<div class="footer">
		<span>${fmtTime(state.startedAt)} → ${state.completedAt ? fmtTime(state.completedAt) : "in progress"}</span>
		<span>${state.status}</span>
	</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Generic Report (test suite report, etc.)
// ---------------------------------------------------------------------------

function generateGenericReport(workflow: Workflow, state: WorkflowState): string {
	const now = Date.now();
	const duration = (state.completedAt || now) - state.startedAt;

	const ctx = state.context;
	const testResult = ctx.test_result || (state.status === "failed" ? "fail" : "unknown");
	const passCount = ctx.pass_count || "?";
	const failCount = ctx.fail_count || "?";
	const summary = ctx.summary || "";

	// Read artifact contents from disk
	const artifactContents: Record<string, string> = {};
	for (const a of state.artifacts) {
		try {
			artifactContents[a.name] = fs.readFileSync(a.filePath, "utf-8");
		} catch {
			artifactContents[a.name] = "(could not read artifact)";
		}
	}

	const resultColor = testResult === "pass"
		? { bg: "#3fb950", bgFaint: "rgba(63,185,80,0.1)" }
		: { bg: "#f85149", bgFaint: "rgba(248,81,73,0.1)" };

	const buildOutput = artifactContents["build-output.txt"];
	const testOutput = artifactContents["test-output.txt"];

	const buildSection = buildOutput ? `
		<section class="evidence">
			<h2>Build Output</h2>
			<pre class="output">${esc(buildOutput)}</pre>
		</section>` : "";

	const testSection = testOutput ? `
		<section class="evidence">
			<h2>Test Results</h2>
			<div class="result-banner" style="background:${resultColor.bgFaint};border-left:3px solid ${resultColor.bg}">
				<span class="result-label" style="color:${resultColor.bg}">${testResult === "pass" ? "PASSED" : "FAILED"}</span>
				<span class="result-counts">${passCount} passed, ${failCount} failed</span>
			</div>
			<pre class="output">${esc(testOutput)}</pre>
		</section>` : "";

	const otherArtifacts = state.artifacts.filter(
		(a) => a.name !== "build-output.txt" && a.name !== "test-output.txt",
	);
	const otherSections = otherArtifacts.map((a) => {
		const content = artifactContents[a.name] || "";
		return `
		<section class="evidence">
			<h2>${esc(a.name)}</h2>
			<pre class="output">${esc(content)}</pre>
		</section>`;
	}).join("\n");

	const branch = ctx.branch || "unknown";
	const commit = ctx.head_commit || "unknown";
	const sourceBranch = ctx.source_branch || "unknown";

	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(workflow.name)}</title>
<style>
${GENERIC_CSS}
</style></head>
<body><div class="report">
	<div class="header">
		<h1>${esc(workflow.name)}</h1>
		<div class="header-meta">
			<span><strong>Branch:</strong> ${esc(branch)}</span>
			<span><strong>Commit:</strong> <code>${esc(commit)}</code></span>
			<span><strong>Base:</strong> ${esc(sourceBranch)}</span>
			<span><strong>Duration:</strong> ${fmtDur(duration)}</span>
		</div>
		${summary ? `<p class="summary">${esc(summary)}</p>` : ""}
	</div>

	${testSection}
	${buildSection}
	${otherSections}

	<div class="footer">
		<span>${fmtTime(state.startedAt)} → ${state.completedAt ? fmtTime(state.completedAt) : "in progress"}</span>
		<span>${state.status}</span>
		${ctx.failure_reason ? `<span>Failure: ${esc(ctx.failure_reason)}</span>` : ""}
	</div>
</div></body></html>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | undefined | null): string {
	if (s == null) return "";
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtTime(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function fmtDur(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const secs = Math.floor(ms / 1000);
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	const remSecs = secs % 60;
	if (mins < 60) return `${mins}m ${remSecs}s`;
	const hrs = Math.floor(mins / 60);
	const remMins = mins % 60;
	return `${hrs}h ${remMins}m`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const BASE_VARS = `
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; }
@media(prefers-color-scheme:light) {
	:root { --bg: #fff; --surface: #f6f8fa; --border: #d0d7de; --text: #1f2328; --muted: #656d76; }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }
.report { max-width: 900px; margin: 0 auto; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
`;

const HEADER_FOOTER = `
.header { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
.header h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.5rem; }
.header-meta { display: flex; flex-wrap: wrap; gap: 1.5rem; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.75rem; }
.header-meta strong { color: var(--text); font-weight: 500; }
.summary { font-size: 1rem; margin-top: 0.5rem; }
.footer { padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.75rem; display: flex; flex-wrap: wrap; gap: 1.5rem; }
`;

const EVIDENCE = `
.evidence { margin-bottom: 2rem; }
.evidence h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
.output { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; font-size: 0.8rem; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.result-banner { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 1rem; }
.result-label { font-weight: 700; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; }
.result-counts { font-size: 0.85rem; color: var(--muted); }
`;

const GENERIC_CSS = BASE_VARS + HEADER_FOOTER + EVIDENCE;

const CODE_REVIEW_CSS = BASE_VARS + HEADER_FOOTER + EVIDENCE + `
.verdict-banner { padding: 0.75rem 1.25rem; border-radius: 6px; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.75rem; }
.verdict-icon { font-size: 1.5rem; font-weight: 700; }
.verdict-label { font-size: 1.1rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }

.stats { display: flex; gap: 1.25rem; font-size: 0.9rem; font-weight: 500; margin-top: 0.5rem; }
.stat { display: flex; align-items: center; gap: 0.25rem; }

.findings-section { margin-bottom: 2rem; }
.findings-section h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
.findings-section .count { color: var(--muted); font-weight: 400; }

.finding { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; }
.finding-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
.severity-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; color: #fff; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.category-badge { font-size: 0.8rem; color: var(--muted); }
.finding-id { margin-left: auto; font-size: 0.75rem; color: var(--muted); font-family: monospace; }
.finding-title { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.35rem; }
.finding-location { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.5rem; }
.finding-location code { background: var(--bg); padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.75rem; }
.finding-description { font-size: 0.85rem; line-height: 1.6; margin-bottom: 0.5rem; }
.finding-suggestion { font-size: 0.85rem; line-height: 1.6; padding: 0.5rem 0.75rem; background: var(--bg); border-radius: 4px; border-left: 3px solid #58a6ff; }
`;
