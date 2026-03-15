import fs from "node:fs";
import type { Workflow, WorkflowState } from "./types.js";

/**
 * Generate an evidence-focused HTML report for a workflow.
 * Prioritises artifact content (build output, test results, diffs)
 * over workflow metadata.
 */
export function generateReport(workflow: Workflow, state: WorkflowState): string {
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
${CSS}
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

function esc(s: string): string {
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

const CSS = `
:root { --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; }
@media(prefers-color-scheme:light) {
	:root { --bg: #fff; --surface: #f6f8fa; --border: #d0d7de; --text: #1f2328; --muted: #656d76; }
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; padding: 2rem; }
.report { max-width: 900px; margin: 0 auto; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }

.header { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border); }
.header h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.5rem; }
.header-meta { display: flex; flex-wrap: wrap; gap: 1.5rem; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.75rem; }
.header-meta strong { color: var(--text); font-weight: 500; }
.summary { font-size: 1rem; margin-top: 0.5rem; }

.evidence { margin-bottom: 2rem; }
.evidence h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
.output { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 1rem; font-size: 0.8rem; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.result-banner { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 1rem; }
.result-label { font-weight: 700; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; }
.result-counts { font-size: 0.85rem; color: var(--muted); }

.footer { padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.75rem; display: flex; flex-wrap: wrap; gap: 1.5rem; }
`;
