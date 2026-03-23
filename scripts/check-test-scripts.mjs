// Verify package.json test scripts are properly configured
import { readFileSync } from 'fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const hasUnit = 'test:unit' in pkg.scripts;
const testRunsBoth = pkg.scripts.test && pkg.scripts.test.includes('test:unit') && pkg.scripts.test.includes('test:e2e');
const unitNotHardcoded = hasUnit && !pkg.scripts['test:unit'].includes('mobile-header');

if (!hasUnit || !testRunsBoth || !unitNotHardcoded) {
  console.log('BUG: test scripts misconfigured');
  console.log('  test:unit exists:', hasUnit);
  console.log('  test runs both:', testRunsBoth);
  console.log('  unit not hardcoded:', unitNotHardcoded);
  process.exit(1);
}
console.log('FIXED: test scripts correct');
