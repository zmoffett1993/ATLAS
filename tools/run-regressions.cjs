// Runs local synthetic Node tests only. Staging/network runners are excluded.
const { readdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = resolve(__dirname, '..');
const tests = readdirSync(join(root, 'tests'))
  .filter(name => /\.test\.(cjs|mjs)$/.test(name)).sort()
  .map(name => join('tests', name));
if (!tests.length) throw new Error('No regression tests found.');
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
