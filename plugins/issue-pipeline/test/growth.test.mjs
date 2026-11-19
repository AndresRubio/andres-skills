import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growsLinearly } from './helpers/growth.mjs';

// The quadratic case runs (n / 70) squared iterations: about 8 ms at 200,000 and 136 ms at four
// times that on the owner's machine, where the limit is 67 ms. A smaller case would fall under the
// 5 ms floor, and its big run could then pass the limit on a faster machine.
test('growsLinearly tells a linear scan from a quadratic one', () => {
  const linear = (n) => { let x = 0; for (let i = 0; i < n * 40; i++) x += i; return x; };
  const quadratic = (n) => { let x = 0; for (let i = 0; i < n / 70; i++) for (let j = 0; j < n / 70; j++) x += j; return x; };
  assert.equal(growsLinearly(linear, 200_000).ok, true);
  assert.equal(growsLinearly(quadratic, 200_000).ok, false);
});
