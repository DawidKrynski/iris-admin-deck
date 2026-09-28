import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast } from './contrast.mjs';

test('contrast uses sRGB linearization, is symmetric and rejects invalid colours', () => {
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.equal(contrast('#123456', '#123456'), 1);
  assert.ok(Math.abs(contrast('#777777', '#ffffff') - 4.478089) < 0.000001);
  assert.equal(contrast('#abcdef', '#123456'), contrast('#123456', '#abcdef'));
  assert.throws(() => contrast('red', '#ffffff'), TypeError);
});

test('text tokens meet 4.5:1 across theme surfaces, including filled buttons', () => {
  const css = readFileSync(new URL('../../web/css/app.css', import.meta.url), 'utf8');
  const tokens = {};
  for (const [theme, block] of [...css.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/g)].entries()) {
    Object.assign(
      tokens,
      Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*(#[\da-f]{6})/g)].map((m) => [m[1], m[2]])),
    );
    for (const fg of ['text', 'text-2', 'muted', 'accent', 'ok', 'warn', 'err']) {
      for (const bg of [
        'bg',
        'panel',
        'panel-2',
        'code-bg',
        'accent-soft',
        'ok-bg',
        'warn-bg',
        'err-bg',
        'side-hover',
        'side-active',
      ]) {
        assert.ok(contrast(tokens[fg], tokens[bg]) >= 4.5, `${theme}: ${fg} on ${bg}`);
      }
    }
    for (const [fg, bg] of [
      ['accent-contrast', 'accent'],
      ['danger-contrast', 'err'],
    ]) {
      assert.ok(contrast(tokens[fg], tokens[bg]) >= 4.5, `${theme}: ${fg} on ${bg}`);
    }
  }
});
