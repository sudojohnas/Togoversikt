import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callDisplayTimes, callWindowState, detailFromJourney, enrichJourneyRouteNames, filterLiveItems, journeyCallStatus, locationSearchRank, mergeLiveItems, smFallbackStatus } from '../frontend/data.js';

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

test('keeps upcoming cancelled calls visible', () => {
  const items = [
    {train_no:'5749',time:'09:30',status:'Innstilt'},
    {train_no:'85702',time:'09:49',status:'Innstilt'},
  ];
  assert.deepEqual(filterLiveItems(items,'08:00','23:59').map(x=>x.train_no),['5749','85702']);
});

test('uses the daily plan as fallback for trains missing from live feeds', () => {
  const planned=[
    {journey_id:'5749:2026-09-28',train_no:'5749',time:'12:20',status:'Planlagt',origin:'Koppang',destination:'Trondheim S',operator:'CargoNet',category:'Godstog',line:'-',direction_ref:'TND',graph_fallback:true},
    {journey_id:'85702:2026-09-28',train_no:'85702',time:'09:49',status:'Planlagt',origin:'Trondheim S',destination:'Alnabru',operator:'CargoNet',category:'Godstog',line:'-',direction_ref:'ALB',graph_fallback:true},
  ];
  const live=[
    {journey_id:'85702:2026-09-28',train_no:'85702',time:'09:49',status:'Innstilt',origin:'',destination:'',operator:'CargoNet',category:'Godstog',line:'-',direction_ref:'ALB'},
  ];
  assert.deepEqual(mergeLiveItems(planned,[],live),[
    planned[0],
    {...planned[1],status:'Innstilt',graph_fallback:false},
  ]);
});

test('expires an old planned train when no live time was ever reported', () => {
  const stale={...baseCall,planned_iso:'2026-09-27T16:02:39+02:00',aimed_departure_iso:'2026-09-27T16:02:39+02:00'};
  assert.deepEqual(
    callWindowState(stale,'2026-09-27','16:48','23:59',true),
    {include:false,clock:'16:02',overdue:false},
  );
  assert.deepEqual(
    filterLiveItems([{train_no:'44759',time:'16:02',planned_time:'16:02',actual_time:null,status:'Planlagt'}],'16:48','23:59'),
    [],
  );
});

test('retains a recently overdue train and a train confirmed at the platform', () => {
  const recent={...baseCall,planned_iso:'2026-09-27T16:30:00+02:00',aimed_departure_iso:'2026-09-27T16:30:00+02:00'};
  assert.equal(callWindowState(recent,'2026-09-27','16:48','23:59',true).include,true);
  const [unconfirmed]=filterLiveItems(
    [{train_no:'2',time:'16:30',planned_time:'16:30',actual_time:null,status:'Planlagt'}],
    '16:48','23:59',
  );
  assert.equal(unconfirmed.status,'Forsinket');
  assert.equal(unconfirmed.unconfirmed_remaining_minutes,12);
  assert.deepEqual(
    filterLiveItems([{train_no:'1',time:'15:00',planned_time:'15:00',actual_time:'15:00',status:'I rute'}],'16:48','23:59').map(x=>x.train_no),
    ['1'],
  );
});

test('marks a missing call passed when the train is recorded at a later point', () => {
  const selected={...baseCall,code:'NYL',planned_iso:'2026-09-27T17:04:58+02:00',aimed_departure_iso:'2026-09-27T17:04:58+02:00'};
  const later={...baseCall,code:'GRO',actual_iso:'2026-09-27T17:03:39+02:00',actual_departure_iso:'2026-09-27T17:03:39+02:00',state:'recorded'};
  assert.equal(journeyCallStatus({route:[selected,later]},selected),'Passert');
  assert.deepEqual(
    filterLiveItems([{train_no:'41960',time:'17:04',status:'Passert'}],'17:00','23:59'),
    [],
  );
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
