// libretro/build-core.sh argument checks. These refuse before any clone or toolchain step,
// so they need no network and no emsdk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'build-core.sh');
const BASH = process.env.HM_BASH ?? (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/bash.exe' : 'bash');
const run = args => spawnSync(BASH, [script, ...args], { encoding: 'utf8', timeout: 30000 });
const URL = 'https://github.com/libretro/QuickNES_Core.git';
const SHA = '26bb785c9deddb66a17717b21bb4e328f03ade32';

test('build-core: refuses a branch name instead of a pinned 40-hex commit', () => {
  const r = run(['quicknes', URL, 'master', 'quicknes']);
  assert.equal(r.status, 2, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /40-hex/);
});

test('build-core: refuses a non-https source URL', () => {
  const r = run(['quicknes', 'http://github.com/libretro/QuickNES_Core.git', SHA, 'quicknes']);
  assert.equal(r.status, 2, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /https/);
});

test('build-core: refuses a call with missing arguments (usage, exit 2)', () => {
  const r = run(['quicknes', URL]);
  assert.equal(r.status, 2, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /usage/);
});
