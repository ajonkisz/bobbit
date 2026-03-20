#!/usr/bin/env node
/**
 * Runs Playwright tests and outputs only a summary + failure details.
 * Keeps agent context lean by suppressing per-test pass lines.
 *
 * Usage:
 *   node scripts/test-summary.mjs                          # Run E2E tests
 *   node scripts/test-summary.mjs --unit                   # Unit tests only
 *   node scripts/test-summary.mjs --e2e                    # E2E tests only
 *   node scripts/test-summary.mjs --all                    # check + unit + E2E
 *   node scripts/test-summary.mjs tests/e2e/foo.spec.ts    # Specific E2E test file
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let overallExit = 0;

function runCheck() {
  console.log("=== Type check ===");
  const r = spawnSync("npm", ["run", "check"], { stdio: "pipe", shell: true });
  if (r.status === 0) {
    console.log("PASSED\n");
  } else {
    console.log("FAILED");
    console.log(r.stdout?.toString() || "");
    console.log(r.stderr?.toString() || "");
    overallExit = 1;
  }
}

function runTests(label, playwrightArgs) {
  console.log(`=== ${label} ===`);

  const fullCmd = ["playwright", "test", ...playwrightArgs, "--reporter=json"];
  const r = spawnSync("npx", fullCmd, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    env: { ...process.env },
    maxBuffer: 50 * 1024 * 1024,
  });

  let report;
  try {
    report = JSON.parse(r.stdout?.toString() || "{}");
  } catch {
    console.log("Could not parse JSON output. Raw stderr:");
    console.log(r.stderr?.toString().slice(0, 2000) || "(empty)");
    overallExit = 1;
    return;
  }

  const stats = report.stats || {};
  const passed = stats.expected || 0;
  const failed = (stats.unexpected || 0) + (stats.flaky || 0);
  const skipped = stats.skipped || 0;
  const total = passed + failed + skipped;
  const durationMs = stats.duration || 0;
  const duration = durationMs > 60000
    ? `${(durationMs / 60000).toFixed(1)}m`
    : `${(durationMs / 1000).toFixed(1)}s`;

  if (failed === 0) {
    console.log(`PASSED: ${passed} / ${total} (${duration})`);
  } else {
    console.log(`Tests passed: ${passed} / ${total} (${duration})`);
    console.log(`Tests FAILED: ${failed}\n`);
    let n = 0;
    function walkSuite(suite, parentTitle) {
      const prefix = parentTitle
        ? (suite.title ? `${parentTitle} > ${suite.title}` : parentTitle)
        : (suite.title || "");
      for (const spec of suite.specs || []) {
        for (const test of spec.tests || []) {
          for (const result of test.results || []) {
            if (result.status === "unexpected" || result.status === "failed") {
              n++;
              const title = prefix ? `${prefix} > ${spec.title}` : spec.title;
              console.log(`--- Failure ${n}: ${title} ---`);
              if (result.error?.message) console.log(result.error.message.slice(0, 800));
              if (result.error?.snippet) console.log(result.error.snippet.slice(0, 500));
              console.log("");
            }
          }
        }
      }
      for (const child of suite.suites || []) walkSuite(child, prefix);
    }
    for (const suite of report.suites || []) walkSuite(suite, "");
    overallExit = 1;
  }

  if (skipped > 0) console.log(`Skipped: ${skipped}`);
  console.log("");
  if (r.status !== 0 && failed === 0) overallExit = 1;
}

// Parse mode
const mode = args[0] || "--e2e";

switch (mode) {
  case "--unit":
    runTests("Unit tests", ["tests/mobile-header.spec.ts", "--config", "tests/playwright.config.ts"]);
    break;
  case "--e2e":
    runTests("E2E tests", ["--config", "playwright-e2e.config.ts", ...args.slice(1)]);
    break;
  case "--all":
    runCheck();
    runTests("Unit tests", ["tests/mobile-header.spec.ts", "--config", "tests/playwright.config.ts"]);
    runTests("E2E tests", ["--config", "playwright-e2e.config.ts", ...args.slice(1)]);
    break;
  case "--help":
  case "-h":
    console.log(`Usage: node scripts/test-summary.mjs [--unit|--e2e|--all] [test files...]`);
    break;
  default:
    // Treat args as file paths / extra args for E2E
    runTests("E2E tests", ["--config", "playwright-e2e.config.ts", ...args]);
    break;
}

process.exit(overallExit);
