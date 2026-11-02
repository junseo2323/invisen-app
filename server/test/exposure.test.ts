import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelOf, exposurePercent, timeWeightedAverage, buckets, zoneDurations, dayStart, atLocalTime, MAX_GAP_MS, SHIFT_MS, type Sample } from '../src/exposure.js';

const MIN = 60_000;
const s = (ts: number, pm10: number, zoneId: number | null = 1, limit = 100): Sample => ({ ts, pm10, zoneId, limit });

test('levelOf uses 80% / 100% thresholds', () => {
  assert.equal(levelOf(79, 100), 'safe');
  assert.equal(levelOf(80, 100), 'caution');
  assert.equal(levelOf(99.9, 100), 'caution');
  assert.equal(levelOf(100, 100), 'danger');
  assert.equal(levelOf(40, 50), 'caution');
});

test('8h at the limit is 100%', () => {
  const xs: Sample[] = [];
  for (let t = 0; t < SHIFT_MS; t += MIN) xs.push(s(t, 100));
  assert.equal(Math.round(exposurePercent(xs, SHIFT_MS)), 100);
});

test('gaps longer than 5 minutes are not counted', () => {
  const xs = [s(0, 100), s(60 * MIN, 100)];
  // first sample counts for MAX_GAP only, second until now (1 min)
  assert.equal(exposurePercent(xs, 61 * MIN), ((MAX_GAP_MS + MIN) / SHIFT_MS) * 100);
});

test('per-zone limits are respected', () => {
  const xs = [s(0, 50, 1, 50), s(MIN, 50, 2, 100)];
  // first minute at 100% of its limit, second at 50%
  assert.equal(exposurePercent(xs, 2 * MIN), ((MIN * 1 + MIN * 0.5) / SHIFT_MS) * 100);
});

test('time-weighted average and buckets', () => {
  const xs = [s(0, 10), s(10 * MIN, 30)];
  assert.equal(timeWeightedAverage(xs, 15 * MIN), (10 * 5 + 30 * 5) / 10); // each counts 5 min (gap cap / until now)
  const b = buckets([s(0, 10), s(MIN, 10), s(30 * MIN, 50)], 0, 31 * MIN, 30 * MIN);
  assert.equal(b.length, 2);
  assert.equal(b[0].avg, 10);
  assert.equal(b[1].avg, 50);
});

test('zone durations', () => {
  const m = zoneDurations([s(0, 1, 1), s(2 * MIN, 1, 2), s(3 * MIN, 1, 2)], 4 * MIN);
  assert.equal(m.get(1), 2 * MIN);
  assert.equal(m.get(2), 2 * MIN);
});

test('local calendar at +09:00', () => {
  const t = Date.parse('2026-11-02T05:00:00Z'); // 14:00 KST
  assert.equal(new Date(dayStart(t, 540)).toISOString(), '2026-11-01T15:00:00.000Z');
  assert.equal(new Date(atLocalTime(t, '07:00:00', 540)).toISOString(), '2026-11-01T22:00:00.000Z');
});
