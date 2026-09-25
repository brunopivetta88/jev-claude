import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.mjs';
import { applyMode, applyUnavailable, decide, explain, strongest } from '../src/policy.mjs';

const thresholds = DEFAULTS.thresholds;

test('a probability below every threshold allows', () => {
  const d = decide({ signals: { destructive: 0.1 }, thresholds });
  assert.equal(d.action, 'allow');
  assert.equal(d.reasons.length, 0);
});

test('thresholds map to their level', () => {
  assert.equal(decide({ signals: { destructive: 0.4 }, thresholds }).action, 'warn');
  assert.equal(decide({ signals: { destructive: 0.65 }, thresholds }).action, 'ask');
  assert.equal(decide({ signals: { destructive: 0.9 }, thresholds }).action, 'block');
});

test('the strongest signal wins across a mixed batch', () => {
  const d = decide({ signals: { scope_creep: 0.6, secret_exposure: 0.9, loop: 0.75 }, thresholds });
  assert.equal(d.action, 'block');
  assert.equal(d.reasons[0].signal, 'secret_exposure');
});

test('one signal contributes only its strongest level', () => {
  const d = decide({ signals: { destructive: 0.9 }, thresholds });
  assert.equal(d.reasons.filter((r) => r.signal === 'destructive').length, 1);
});

test('a severe score escalates a warn to an ask', () => {
  const warn = decide({ signals: { destructive: 0.4 }, severity: 1, thresholds });
  const escalated = decide({ signals: { destructive: 0.4 }, severity: 4, thresholds });
  assert.equal(warn.action, 'warn');
  assert.equal(escalated.action, 'ask');
});

test('severity alone never creates a finding', () => {
  assert.equal(decide({ signals: {}, severity: 4, thresholds }).action, 'allow');
});

test('floor matches are attributed to the rule, not to jev', () => {
  const d = decide({
    signals: { destructive: 0.99 },
    thresholds,
    floorMatches: [{ signal: 'destructive', label: 'rm -rf against / or $HOME', probability: 0.99 }],
  });
  assert.match(d.reasons[0].source, /^rule: rm -rf/);
});

test('shadow mode downgrades the action but remembers what it was', () => {
  const blocked = decide({ signals: { destructive: 0.95 }, thresholds });
  const shadowed = applyMode(blocked, { enforcing: false });
  assert.equal(shadowed.action, 'allow');
  assert.equal(shadowed.rawAction, 'block');
  assert.equal(shadowed.shadowed, true);
  assert.match(explain(shadowed), /shadow: would block/);
});

test('enforce mode leaves the action intact', () => {
  const blocked = decide({ signals: { destructive: 0.95 }, thresholds });
  assert.equal(applyMode(blocked, { enforcing: true }).action, 'block');
});

test('fail-open keeps the floor decision when jev is down', () => {
  const d = decide({ signals: { destructive: 0.99 }, thresholds });
  assert.equal(applyUnavailable(d, { failOpen: true }, 'timeout').action, 'block');
  assert.equal(applyUnavailable(decide({ signals: {}, thresholds }), { failOpen: true }, 'timeout').action, 'allow');
});

test('fail-closed raises an otherwise clean call to an ask', () => {
  const d = applyUnavailable(decide({ signals: {}, thresholds }), { failOpen: false }, 'timeout');
  assert.equal(d.action, 'ask');
  assert.equal(d.reasons[0].signal, 'jev_unavailable');
});

test('strongest orders the four outcomes', () => {
  assert.equal(strongest('allow', 'warn'), 'warn');
  assert.equal(strongest('block', 'ask'), 'block');
});
