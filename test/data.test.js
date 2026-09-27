import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callDisplayTimes, callWindowState, detailFromJourney, enrichJourneyRouteNames, filterLiveItems, journeyCallStatus, locationSearchRank, smFallbackStatus } from '../frontend/data.js';

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

test('marks an early actual arrival at the destination as arrived even when SIRI says delayed', () => {
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
  assert.equal(smFallbackStatus(call), 'Ankommet');
  assert.equal(journeyCallStatus({route:[call]}, call), 'Ankommet');
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

test('requires one full minute before marking a train delayed', () => {
  const secondsLate=seconds => ({
    ...baseCall,
    expected_iso:`2026-09-27T08:20:${String(seconds).padStart(2,'0')}+02:00`,
    expected_departure_iso:`2026-09-27T08:20:${String(seconds).padStart(2,'0')}+02:00`,
    status_raw:'delayed',
  });
  assert.equal(smFallbackStatus(secondsLate(37)),'Planlagt');
  assert.equal(smFallbackStatus({
    ...baseCall,
    expected_iso:'2026-09-27T08:21:00+02:00',
    expected_departure_iso:'2026-09-27T08:21:00+02:00',
    status_raw:'delayed',
  }),'Forsinket +1 min');
});

test('keeps a train at the platform but displays its arrival time', () => {
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
    { include:true, clock:'13:58', overdue:false },
  );
  assert.notEqual(journeyCallStatus({route:[call]},call), 'Passert');
});

test('removes completed and cancelled calls before now but retains overdue active calls', () => {
  const items = [
    {train_no:'118',time:'13:46',status:'Ankommet'},
    {train_no:'1920',time:'13:55',status:'Forsinket'},
    {train_no:'2237',time:'14:01',status:'Innstilt'},
    {train_no:'653',time:'14:14',status:'Forsinket +36 min'},
  ];
  assert.deepEqual(filterLiveItems(items,'14:08','23:59').map(x=>x.train_no),['1920','653']);
});

test('keeps separate arrival and departure times in train details', () => {
  const call = {
    ...baseCall, code:'OSL', name:'Oslo S', state:'recorded',
    aimed_arrival_iso:'2026-09-27T14:00:00+02:00', expected_arrival_iso:'2026-09-27T14:02:00+02:00', actual_arrival_iso:'2026-09-27T14:01:00+02:00',
    aimed_departure_iso:'2026-09-27T14:05:00+02:00', expected_departure_iso:'2026-09-27T14:07:00+02:00', actual_departure_iso:'2026-09-27T14:06:00+02:00',
  };
  const detail=detailFromJourney({journey_id:'1',train_no:'1',route:[call],origin:'Oslo S',destination:'Bergen',operator:'Vy'},'OSL',null);
  assert.equal(detail.route[0].planned_arrival,'14:00');
  assert.equal(detail.route[0].expected_arrival,'14:02');
  assert.equal(detail.route[0].actual_arrival,'14:01');
  assert.equal(detail.route[0].planned_departure,'14:05');
  assert.equal(detail.route[0].expected_departure,'14:07');
  assert.equal(detail.route[0].actual_departure,'14:06');
});

test('uses arrival time on the train card when arrival and departure both exist', () => {
  const call = {
    ...baseCall,
    aimed_arrival_iso:'2026-09-27T14:00:00+02:00', expected_arrival_iso:'2026-09-27T14:02:00+02:00', actual_arrival_iso:'',
    aimed_departure_iso:'2026-09-27T14:05:00+02:00', expected_departure_iso:'2026-09-27T14:07:00+02:00', actual_departure_iso:'',
  };
  assert.deepEqual(callDisplayTimes(call),{planned:'14:00',expected:'14:02',actual:null});
  assert.deepEqual(callWindowState(call,'2026-09-27','13:00','15:00'),{include:true,clock:'14:02',overdue:false});
});

test('bases the card delay on arrival rather than departure', () => {
  const call = {
    ...baseCall,
    aimed_arrival_iso:'2026-09-27T14:00:00+02:00', expected_arrival_iso:'2026-09-27T14:00:37+02:00',
    aimed_departure_iso:'2026-09-27T14:05:00+02:00', expected_departure_iso:'2026-09-27T14:07:00+02:00',
    status_raw:'delayed',
  };
  assert.equal(smFallbackStatus(call),'Planlagt');
});

test('enriches route codes with full SIRI names', () => {
  const journey={route:[{code:'NTH',name:'NTH'},{code:'LSD',name:'LSD'},{code:'OSL',name:'Oslo S'}]};
  const metadata={route:[{code:'NTH',name:'Nationaltheatret'},{code:'LSD',name:'Leirsund'},{code:'OSL',name:'Oslo S'}]};
  assert.deepEqual(enrichJourneyRouteNames(journey,metadata).route.map(x=>x.name),['Nationaltheatret','Leirsund','Oslo S']);
});

test('finds a stop by code, official name, and a close spelling', () => {
  const location={code:'NTH',name:'Nationaltheatret',kind:'Stoppested'};
  assert.equal(locationSearchRank(location,'NTH').rank,1);
  assert.equal(locationSearchRank(location,'Nationaltheatret').rank,0);
  assert.equal(locationSearchRank(location,'Nationaltheateret').rank,3);
  assert.equal(locationSearchRank(location,'Trondheim'),null);
});

test('ships the active stopping points in the searchable location list', () => {
  const locations=JSON.parse(readFileSync(new URL('../public/locations.json',import.meta.url),'utf8'));
  const byCode=new Map(locations.map(location=>[location.code,location]));
  assert.equal(byCode.get('NTH')?.name,'Nationaltheatret');
  for(const code of ['LIE','LSD','NBY','SDA','JÅT']) assert.ok(byCode.has(code),`${code} mangler`);
});
