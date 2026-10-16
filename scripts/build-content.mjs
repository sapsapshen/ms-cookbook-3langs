// Compatibility entry point; content/ is the single source of truth.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) {
  console.error('Usage: node scripts/build-content.mjs [--check]');
  process.exit(1);
}
const result = spawnSync('python3', [resolve(import.meta.dirname, 'build-content.py'), ...args], { stdio: 'inherit' });
if (result.error) {
  console.error('Python 3 is required to build chapter content:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
