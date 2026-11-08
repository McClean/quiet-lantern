// The committed adapters/quicknes/core/ and binding.mjs must be exactly what libretro/build-core.sh
// produces from the pinned QuickNES commit. These checks read the files; they do not rebuild.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(here, '..');
const REPO = path.resolve(ADAPTER, '../..');
const QN_COMMIT = '26bb785c9deddb66a17717b21bb4e328f03ade32';
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('core/ ships core.mjs and a non-empty core.wasm', () => {
  for (const f of ['core.mjs', 'core.wasm']) {
    const p = path.join(ADAPTER, 'core', f);
    assert.ok(fs.existsSync(p), `missing core/${f}`);
    assert.ok(fs.statSync(p).size > 0, `empty core/${f}`);
  }
});

test('core/LICENSE.quicknes is the GPL-2.0 text read from the QuickNES repo', () => {
  const p = path.join(ADAPTER, 'core', 'LICENSE.quicknes');
  assert.ok(fs.existsSync(p), 'missing core/LICENSE.quicknes');
  assert.match(fs.readFileSync(p, 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991/);
});

test('BUILD-INFO.txt records the pinned commit', () => {
  const info = fs.readFileSync(path.join(ADAPTER, 'core', 'BUILD-INFO.txt'), 'utf8');
  assert.match(info, new RegExp(`commit: ${QN_COMMIT}`));
  assert.match(info, /url: https:\/\/github\.com\/libretro\/QuickNES_Core\.git/);
});

test('BUILD-INFO.txt sha256 lines match the shipped files', () => {
  const info = fs.readFileSync(path.join(ADAPTER, 'core', 'BUILD-INFO.txt'), 'utf8');
  // sha256sum format: "<64 hex> *<path relative to adapters/quicknes>"
  const sums = new Map();
  for (const line of info.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64}) [* ]?(.+)$/);
    if (m) sums.set(m[2], m[1]);
  }
  for (const f of ['core/core.wasm', 'core/core.mjs', 'binding.mjs']) {
    assert.ok(sums.has(f), `no sha256 line for ${f}`);
    assert.equal(sums.get(f), sha(path.join(ADAPTER, f)), `sha256 of ${f} does not match the file`);
  }
});

test('adapters/quicknes/binding.mjs is byte-identical to libretro/binding.mjs', () => {
  assert.equal(sha(path.join(ADAPTER, 'binding.mjs')), sha(path.join(REPO, 'libretro', 'binding.mjs')));
});
