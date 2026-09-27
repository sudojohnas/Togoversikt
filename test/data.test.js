import test from 'node:test';
import assert from 'node:assert/strict';
import { callWindowState, journeyCallStatus, smFallbackStatus } from '../frontend/data.js';

const baseCall = {
  planned_iso: '2026-09-27T08:20:00+02:00',
  aimed_departure_iso: '2026-09-27T08:20:00+02:00',
  expected_iso: '',
  expected_departure_iso: '',
  actual_iso: '',
  actual_departure_iso: '',
  state: 'estimated',
  status_raw: '',
};

test('keeps an unpassed train visible after its planned time', () => {
  assert.deepEqual(
    callWindowState(baseCall, '2026-09-27', '08:21', '23:59', true),
    { include: true, clock: '08:20', overdue: true },
  );
});

test('uses an expected delayed time when one is available', () => {
  const call = {...baseCall, expected_iso:'2026-09-27T08:22:00+02:00', expected_departure_iso:'2026-09-27T08:22:00+02:00'};
  assert.deepEqual(
    callWindowState(call, '2026-09-27', '08:21', '23:59', true),
    { include: true, clock: '08:22', overdue: false },
  );
});

test('removes the train after an actual passing time is recorded', () => {
  const call = {...baseCall, actual_iso:'2026-09-27T08:22:00+02:00', actual_departure_iso:'2026-09-27T08:22:00+02:00'};
  assert.deepEqual(
    callWindowState(call, '2026-09-27', '08:23', '23:59', true),
    { include: false, clock: '08:22', overdue: false },
  );
});

test('does not retain cancelled or historical trains outside the selected window', () => {
  assert.equal(callWindowState({...baseCall,status_raw:'cancelled'}, '2026-09-27', '08:21', '23:59', true).include, false);
  assert.equal(callWindowState(baseCall, '2026-09-27', '08:21', '23:59', false).include, false);
});

test('marks an early actual arrival as passed even when SIRI says delayed', () => {
  const call = {
    ...baseCall,
    planned_iso: '2026-09-27T12:56:00+02:00',
    aimed_departure_iso: '',
    aimed_arrival_iso: '2026-09-27T12:56:00+02:00',
    expected_iso: '2026-09-27T12:55:57+02:00',
    expected_arrival_iso: '2026-09-27T12:55:57+02:00',
    actual_iso: '2026-09-27T12:55:57+02:00',
    actual_arrival_iso: '2026-09-27T12:55:57+02:00',
    status_raw: 'delayed',
  };
  assert.equal(smFallbackStatus(call), 'Passert');
  assert.equal(journeyCallStatus({route:[call]}, call), 'Passert');
});

test('ignores a contradictory delayed flag when the expected time is early', () => {
  const call = {
    ...baseCall,
    planned_iso: '2026-09-27T12:56:00+02:00',
    expected_iso: '2026-09-27T12:55:57+02:00',
    expected_departure_iso: '2026-09-27T12:55:57+02:00',
    status_raw: 'delayed',
  };
  assert.equal(smFallbackStatus(call), 'Planlagt');
});
