import test from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, windowTotals, cycleBounds, estimateRemaining, dayKey, daysLeft } from '../lib/usage.js';

test('acumula segundos y archivos por día', () => {
  const usage = {};
  addUsage(usage, '2026-11-24T10:00:00Z', 180);
  addUsage(usage, '2026-11-24T12:00:00Z', 120.5);
  addUsage(usage, '2026-11-25T09:00:00Z', 60);
  assert.equal(usage['2026-11-24'].seconds, 300.5);
  assert.equal(usage['2026-11-24'].files, 2);
  assert.equal(usage['2026-11-25'].files, 1);
});

test('suma solo la ventana del ciclo', () => {
  const usage = {};
  addUsage(usage, '2026-10-30T10:00:00Z', 500);
  addUsage(usage, '2026-11-24T00:00:00Z', 100);
  addUsage(usage, '2026-12-01T00:00:00Z', 200);
  const totals = windowTotals(usage, '2026-11-24', '2026-12-24');
  assert.equal(totals.seconds, 300);
  assert.equal(totals.files, 2);
});

test('ciclo desde la fecha de próximo cobro', () => {
  const { start, end } = cycleBounds('2026-12-24', 1, new Date('2026-11-24T20:00:00Z'));
  assert.equal(dayKey(start), '2026-11-24');
  assert.equal(dayKey(end), '2026-12-24');
});

test('ciclo por día de corte si no hay fecha de cobro', () => {
  const { start, end } = cycleBounds(null, 1, new Date('2026-11-24T20:00:00Z'));
  assert.equal(dayKey(start), '2026-11-01');
  assert.equal(dayKey(end), '2026-12-01');

  const second = cycleBounds(null, 15, new Date('2026-11-10T20:00:00Z'));
  assert.equal(dayKey(second.start), '2026-10-15');
  assert.equal(dayKey(second.end), '2026-11-15');
});

test('estima detecciones restantes con la media', () => {
  assert.equal(estimateRemaining(6000, 200), 30);
  assert.equal(estimateRemaining(0, 200), 0);
  assert.equal(estimateRemaining(null, 200), null);
  assert.equal(estimateRemaining(1000, 0), null);
});

test('días restantes del ciclo', () => {
  const left = daysLeft('2026-12-24T00:00:00Z', new Date('2026-11-24T20:00:00Z'));
  assert.equal(left, 30);
});
