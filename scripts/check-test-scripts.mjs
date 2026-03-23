// Verify package.json has proper test:unit script on the current branch
// This script is used by the bug-fix workflow:
// - reproducing-test gate (expect: failure) — checks master where bug exists
// - implementation gate (expect: success) — checks current branch where fix exists
//
// Uses git to compare: checks the current branch's package.json
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// Check what branch we're on
const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();

// Read the current package.json (from working tree)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const hasUnit = 'test:unit' in pkg.scripts;
const testRunsBoth = pkg.scripts.test && pkg.scripts.test.includes('test:unit') && pkg.scripts.test.includes('test:e2e');
const unitNotHardcoded = hasUnit && !pkg.scripts['test:unit'].includes('mobile-header');

if (!hasUnit || !testRunsBoth || !unitNotHardcoded) {
  console.log('BUG: test scripts misconfigured on', branch);
  console.log('  test:unit exists:', hasUnit);
  console.log('  test runs both:', testRunsBoth);
  console.log('  unit not hardcoded:', unitNotHardcoded);
  process.exit(1);
}
console.log('FIXED: test scripts correct on', branch);
