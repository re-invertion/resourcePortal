import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const picomatch = require('picomatch');
const packageInfo = require('picomatch/package.json');

// A pinned, reviewed fork is required until upstream releases an official fix.
// npm audit alone cannot prove that a renamed package fixes a CVE; execute the
// exact vulnerable pattern family under an independent wall-clock deadline.
test('patched picomatch package is the intentionally pinned replacement', () => {
  assert.equal(packageInfo.name, '@ryotsu/picomatch');
  assert.equal(packageInfo.version, '4.0.7-a');
});

test('repeated single-branch wildcard extglobs do not cause regex DoS', () => {
  for (const pattern of ['+(*a)', '*(*a)', '+(*?a)', '+(*ab)', '*(*ab)']) {
    const child = spawnSync(process.execPath, ['-e', `
      const picomatch = require('picomatch');
      const re = picomatch.makeRe(${JSON.stringify(pattern)});
      re.test('a'.repeat(38) + '!');
    `], { encoding: 'utf8', timeout: 3500, cwd: process.cwd() });
    assert.equal(child.error, undefined, `${pattern}: timed out or failed: ${child.error}`);
    assert.equal(child.status, 0, `${pattern}: ${child.stderr}`);
  }
});

test('the replacement retains standard filename glob behavior', () => {
  assert.equal(picomatch.isMatch('src/tenant/auth.ts', '**/*.ts'), true);
  assert.equal(picomatch.isMatch('src/tenant/auth.tsx', '**/*.ts'), false);
  assert.equal(picomatch.isMatch('.env', '*.ts'), false);
  assert.equal(picomatch.isMatch('auth.test.ts', '*.test.ts'), true);
  assert.equal(picomatch.isMatch('a/b/c.js', '**/*.js'), true);
  assert.equal(picomatch.isMatch('a/b/c.ts', '**/*.js'), false);
});
