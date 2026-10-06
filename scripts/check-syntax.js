// Syntax-checks every JS file without running it — the cheapest possible
// "did I break the build" gate, and what CI runs first.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOTS = ['server', 'client/src', 'tests', 'scripts'];
const SKIP = new Set(['node_modules', 'uploads']);

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|cjs)$/.test(entry.name)) yield full;
  }
}

let checked = 0;
let failed = 0;
for (const root of ROOTS) {
  for (const file of walk(path.join(__dirname, '..', root))) {
    checked += 1;
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${path.relative(process.cwd(), file)}\n${err.stderr}`);
    }
  }
}
console.log(`${checked - failed}/${checked} files OK`);
process.exit(failed ? 1 : 0);
