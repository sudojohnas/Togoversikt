import test from 'node:test';
import assert from 'node:assert/strict';
import { callWindowState, filterLiveItems, journeyCallStatus, smFallbackStatus } from '../frontend/data.js';

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
    aimed_departure_iso: '2026-09-27T12:56:00+02:00',
    expected_iso: '2026-09-27T12:55:57+02:00',
    expected_departure_iso: '2026-09-27T12:55:57+02:00',
    status_raw: 'delayed',
  };
  assert.equal(smFallbackStatus(call), 'Planlagt');
});

test('keeps a train at the platform until its expected departure', () => {
  const call = {
    ...baseCall,
    aimed_departure_iso: '',
    aimed_arrival_iso: '2026-09-27T13:23:00+02:00',
    expected_arrival_iso: '2026-09-27T13:59:00+02:00',
    actual_arrival_iso: '2026-09-27T13:58:53+02:00',
    expected_departure_iso: '2026-09-27T14:14:00+02:00',
    actual_departure_iso: '',
  };
  assert.deepEqual(
    callWindowState(call, '2026-09-27', '14:08', '23:59', true),
    { include:true, clock:'14:14', overdue:false },
  );
  assert.notEqual(journeyCallStatus({route:[call]},call), 'Passert');
});

test('removes completed and cancelled calls before now but retains overdue active calls', () => {
  const items = [
    {train_no:'118',time:'13:46',status:'Passert'},
    {train_no:'1920',time:'13:55',status:'Forsinket'},
    {train_no:'2237',time:'14:01',status:'Innstilt'},
    {train_no:'653',time:'14:14',status:'Forsinket +36 min'},
  ];
  assert.deepEqual(filterLiveItems(items,'14:08','23:59').map(x=>x.train_no),['1920','653']);
});
