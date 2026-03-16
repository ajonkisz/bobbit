/**
 * Code review finding synthesis — pure logic for merging, deduplicating,
 * sorting, and summarising findings from parallel review delegates.
 *
 * Used by:
 * - `engine.ts` (server-side WorkflowRunner.synthesiseFindings)
 * - `.pi/extensions/workflow.ts` has a parallel implementation that should
 *   be kept in sync with the algorithms here (see the `synthesise_review` case).
 */

import { readArtifact, storeArtifact } from "./artifact-store.js";
import type { WorkflowArtifact } from "./types.js";

// ── Types ──

export interface Finding {
	id: string;
	file: string;
	lineRange: string;
	category: string;
	severity: string;
	title: string;
	description: string;
	suggestion: string;
}

export interface SynthesisResult {
	findings: Finding[];
	rawCount: number;
	duplicatesRemoved: number;
	criticalCount: number;
	majorCount: number;
	minorCount: number;
	nitCount: number;
	verdict: string;
	summary: string;
	artifact: WorkflowArtifact;
}

// ── Severity ordering ──

const SEVERITY_ORDER: Record<string, number> = {
	critical: 0,
	major: 1,
	minor: 2,
	nit: 3,
};

// ── Pure helper functions ──

/**
 * Extract a Finding[] array from raw text.
 * Tries JSON.parse on the whole text first, then falls back to extracting
 * from the first ```json fenced block.
 */
export function extractFindings(text: string): Finding[] {
	// Try parsing the whole text as JSON first
	try {
		const parsed = JSON.parse(text);
		if (Array.isArray(parsed)) return parsed;
	} catch {
		// Fall back to extracting from code fences
	}
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
	if (fenceMatch) {
		try {
			const parsed = JSON.parse(fenceMatch[1]);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// ignore
		}
	}
	return [];
}

/** Check whether two line-range strings overlap (e.g. "L10-L20" and "L15-L25"). */
export function lineRangeOverlaps(a: string, b: string): boolean {
	const parseRange = (r: string): [number, number] => {
		const nums = r.replace(/[Ll]/g, "").split(/[-–]/);
		const start = parseInt(nums[0], 10) || 0;
		const end = parseInt(nums[1] || nums[0], 10) || start;
		return [start, end];
	};
	const [aStart, aEnd] = parseRange(a);
	const [bStart, bEnd] = parseRange(b);
	return aStart <= bEnd && bStart <= aEnd;
}

/** Check whether two titles are similar (case-insensitive, one contains the other). */
export function similarTitle(a: string, b: string): boolean {
	const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const na = normalize(a);
	const nb = normalize(b);
	if (na === nb) return true;
	return na.includes(nb) || nb.includes(na);
}

/**
 * Deduplicate findings: same file, overlapping line ranges, similar titles.
 * When a duplicate is found, the one with the longer description wins.
 * Returns a new array (does not mutate the input).
 */
export function deduplicateFindings(findings: Finding[]): Finding[] {
	const deduped: Finding[] = [];
	for (const finding of findings) {
		const dupIdx = deduped.findIndex(
			(existing) =>
				existing.file === finding.file &&
				lineRangeOverlaps(existing.lineRange, finding.lineRange) &&
				similarTitle(existing.title, finding.title),
		);
		if (dupIdx >= 0) {
			// Keep the one with the longer description
			if (finding.description.length > deduped[dupIdx].description.length) {
				deduped[dupIdx] = finding;
			}
		} else {
			deduped.push(finding);
		}
	}
	return deduped;
}

/** Sort findings by severity (critical → major → minor → nit). Mutates in place. */
export function sortBySeverity(findings: Finding[]): void {
	findings.sort(
		(a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
	);
}

/** Renumber finding IDs sequentially as F001, F002, etc. Mutates in place. */
export function renumberFindings(findings: Finding[]): void {
	for (let i = 0; i < findings.length; i++) {
		findings[i].id = `F${String(i + 1).padStart(3, "0")}`;
	}
}

/** Compute severity counts, verdict, and summary from a list of findings. */
export function computeVerdict(findings: Finding[]): {
	criticalCount: number;
	majorCount: number;
	minorCount: number;
	nitCount: number;
	verdict: string;
	summary: string;
} {
	const criticalCount = findings.filter((f) => f.severity === "critical").length;
	const majorCount = findings.filter((f) => f.severity === "major").length;
	const minorCount = findings.filter((f) => f.severity === "minor").length;
	const nitCount = findings.filter((f) => f.severity === "nit").length;

	let verdict: string;
	if (criticalCount > 0 || majorCount > 0) {
		verdict = "request-changes";
	} else if (minorCount > 0 || nitCount > 0) {
		verdict = "comment";
	} else {
		verdict = "approve";
	}

	const verdictDescriptions: Record<string, string> = {
		approve: "No significant issues found — approve.",
		comment: "Minor issues only — approve with comments.",
		"request-changes": "Significant issues found — changes requested.",
	};
	const summary = `${findings.length} findings (${criticalCount} critical, ${majorCount} major). ${verdictDescriptions[verdict]}`;

	return { criticalCount, majorCount, minorCount, nitCount, verdict, summary };
}

// ── Full pipeline (uses artifact-store I/O) ──

/** Default delegate artifact names for the three review perspectives. */
const DELEGATE_ARTIFACT_NAMES = [
	"delegate-review-correctness.txt",
	"delegate-review-security.txt",
	"delegate-review-design.txt",
];

/**
 * Full synthesis pipeline: read delegate artifacts, merge/deduplicate/sort
 * findings, store the merged artifact, and return everything the caller needs
 * to update workflow state.
 */
export function synthesiseReviewFindings(
	sessionId: string,
	currentPhaseId?: string,
): SynthesisResult {
	// 1. Read and extract findings from delegate artifacts
	let allFindings: Finding[] = [];
	for (const name of DELEGATE_ARTIFACT_NAMES) {
		const buf = readArtifact(sessionId, name);
		if (buf) {
			const findings = extractFindings(buf.toString("utf-8"));
			allFindings.push(...findings);
		}
	}
	const rawCount = allFindings.length;

	// 2. Sort by severity
	sortBySeverity(allFindings);

	// 3. Deduplicate
	const deduped = deduplicateFindings(allFindings);

	// 4. Renumber IDs
	renumberFindings(deduped);

	// 5. Store merged artifact
	const filename = "review-findings.json";
	const content = JSON.stringify(deduped, null, 2);
	const filePath = storeArtifact(sessionId, filename, content);
	const artifact: WorkflowArtifact = {
		name: filename,
		filePath,
		mimeType: "application/json",
		collectedAt: Date.now(),
		phaseId: currentPhaseId,
	};

	// 6. Compute verdict and summary
	const { criticalCount, majorCount, minorCount, nitCount, verdict, summary } =
		computeVerdict(deduped);

	return {
		findings: deduped,
		rawCount,
		duplicatesRemoved: rawCount - deduped.length,
		criticalCount,
		majorCount,
		minorCount,
		nitCount,
		verdict,
		summary,
		artifact,
	};
}
