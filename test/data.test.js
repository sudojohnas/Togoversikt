import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraphOperationalNotices, callDisplayTimes, callWindowState, combineEventItems, dailyGraphUrl, detailFromJourney, enrichJourneyRouteNames, filterLiveItems, journeyCallStatus, locationSearchRank, mergeDailyGraphResponses, mergeLiveItems, metadataJourneyForTrain, queryTrains, smFallbackStatus } from '../frontend/data.js';

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

test('uses a future start time as a strict lower boundary', () => {
  const items = [
    {train_no:'1',time:'22:40',actual_time:'22:42',status:'Forsinket'},
    {train_no:'2',time:'23:21',actual_time:null,status:'Hentet fra rutegraf, ingen sanntidsdata'},
  ];
  assert.deepEqual(filterLiveItems(items,'23:00','23:59',false).map(item=>item.train_no),['2']);
});

test('combines arrivals and departures while keeping one graph-only event', () => {
  const arrival=[
    {journey_id:'regular',train_no:'1',time:'12:00'},
    {journey_id:'graph',train_no:'2',time:'12:05',graph_only:true},
  ];
  const departure=[
    {journey_id:'regular',train_no:'1',time:'12:03'},
    {journey_id:'graph',train_no:'2',time:'12:05',graph_only:true},
  ];
  assert.deepEqual(combineEventItems(arrival,departure).map(item=>[item.train_no,item.event_type]),[
    ['1','arrival'],['1','departure'],['2','graph'],
  ]);
});

test('removes a graph-only guess when the other event has the same train number', () => {
  const arrival=[
    {journey_id:'graph:2026-10-02:1:8402:1',train_no:'8402',time:'23:21',category:'Mulig arbeidstog',graph_only:true},
  ];
  const departure=[
    {journey_id:'8402:2026-10-02',train_no:'8402',time:'23:24',category:'Godstog'},
  ];
  assert.deepEqual(combineEventItems(arrival,departure).map(item=>[item.train_no,item.time,item.category,item.event_type]),[
    ['8402','23:24','Godstog','departure'],
  ]);
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

test('merges different source ids for the same train number and trusts the live category', () => {
  const graph={
    journey_id:'graph:2026-10-02:1:8402:1',train_no:'8402',time:'23:21',category:'Mulig arbeidstog',
    operator:'Bane NOR-bestilt',graph_only:true,graph_fallback:true,
  };
  const live={
    journey_id:'8402:2026-10-02',train_no:'8402',time:'23:24',category:'Godstog',operator:'CargoNet',
  };
  assert.deepEqual(mergeLiveItems([graph],[],[live]),[
    {...graph,...live,graph_fallback:false,graph_only:false},
  ]);
});

test('keeps SIRI live data authoritative over Togkart', () => {
  const planned={journey_id:'123:2026-10-07',train_no:'123',time:'12:00',status:'Planlagt',source:'Bane NOR SIRI PT'};
  const siri={...planned,time:'12:07',status:'Forsinket +7 min',source:'Bane NOR SIRI SM'};
  const togkart={...planned,time:'12:05',status:'I rute',source:'Bane NOR Togkart'};
  assert.deepEqual(mergeLiveItems([planned],[siri],[togkart]),[{...siri,graph_fallback:false}]);
});

test('selects same-date SIRI metadata for a graph-only passing train', () => {
  const journeys=[
    {journey_id:'125:2026-10-06',train_no:'125',operator:'Vy'},
    {journey_id:'125:2026-10-07',train_no:'125',operator:'Vy',category:'Persontog',line:'RE20'},
  ];
  assert.equal(metadataJourneyForTrain(journeys,'125','2026-10-07'),journeys[1]);
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

test('selects arrival or departure time for the station board', () => {
  const call = {
    ...baseCall,
    aimed_arrival_iso:'2026-09-27T14:00:00+02:00', expected_arrival_iso:'2026-09-27T14:02:00+02:00', actual_arrival_iso:'',
    aimed_departure_iso:'2026-09-27T14:05:00+02:00', expected_departure_iso:'2026-09-27T14:07:00+02:00', actual_departure_iso:'',
  };
  assert.deepEqual(callDisplayTimes(call,'arrival'),{planned:'14:00',expected:'14:02',actual:null});
  assert.deepEqual(callDisplayTimes(call,'departure'),{planned:'14:05',expected:'14:07',actual:null});
  assert.deepEqual(callWindowState(call,'2026-09-27','14:03','15:00',false,'arrival'),{include:false,clock:'14:02',overdue:false});
  assert.deepEqual(callWindowState(call,'2026-09-27','14:03','15:00',false,'departure'),{include:true,clock:'14:07',overdue:false});
});

test('does not show an origin as an arrival or a destination as a departure', () => {
  const origin={...baseCall};
  const destination={...baseCall,aimed_departure_iso:'',planned_iso:'2026-09-27T18:00:00+02:00',aimed_arrival_iso:'2026-09-27T18:00:00+02:00'};
  assert.equal(callWindowState(origin,'2026-09-27','00:00','23:59',false,'arrival').include,false);
  assert.equal(callWindowState(destination,'2026-09-27','00:00','23:59',false,'departure').include,false);
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

test('enriches a graph-only passing train with complete SIRI PT metadata', async () => {
  const originalFetch=globalThis.fetch;
  const emptyPt='<Siri><ServiceDelivery><ProductionTimetableDelivery><DatedTimetableVersionFrame></DatedTimetableVersionFrame></ProductionTimetableDelivery></ServiceDelivery></Siri>';
  const metadataPt='<Siri><ServiceDelivery><ProductionTimetableDelivery><DatedTimetableVersionFrame><OperatorRef>VY</OperatorRef><LineRef>RE20</LineRef><DirectionRef>HLD</DirectionRef><DatedVehicleJourney><DatedVehicleJourneyCode>125:2099-01-03</DatedVehicleJourneyCode><ProductCategoryRef>Rt</ProductCategoryRef><ServiceFeatureRef>passengerTrain</ServiceFeatureRef><DatedCalls><DatedCall><StopPointRef>OSL</StopPointRef><StopPointName>Oslo S</StopPointName><AimedDepartureTime>2099-01-03T11:00:00+01:00</AimedDepartureTime></DatedCall><DatedCall><StopPointRef>HLD</StopPointRef><StopPointName>Halden</StopPointName><AimedArrivalTime>2099-01-03T12:10:00+01:00</AimedArrivalTime></DatedCall></DatedCalls></DatedVehicleJourney></DatedTimetableVersionFrame></ProductionTimetableDelivery></ServiceDelivery></Siri>';
  const graph={date:'2099-01-03',trains:[],graphs_loaded:1,graphs_expected:1,possible_work_trains:[{
    journey_id:'graph:2099-01-03:24:125:12:00:1',train_no:'125',line_number:24,origin_code:'BG',destination_code:'HLD',work_hint:false,
    route:[{code:'BG',time:'12:00',minute:720},{code:'HLD',time:'12:10',minute:730}],
  }]};
  globalThis.fetch=async url=>{
    const path=String(url);
    if(path==='/locations.json') return new Response(readFileSync(new URL('../public/locations.json',import.meta.url),'utf8'));
    if(path.startsWith('/api/pt')) return new Response(path.includes('TrainNumbers=125')?metadataPt:emptyPt,{status:200});
    if(path.startsWith('/api/daily-graph-lines')) return Response.json({location:'BG',lines:[24]});
    if(path.startsWith('/api/daily-graphs')) return Response.json(graph);
    throw new Error(`Uventet kall: ${path}`);
  };
  try {
    const result=await queryTrains({locationCode:'BG',location:'Berg',date:'2099-01-03',today:'2099-01-01',fromTime:'00:00',toTime:'23:59'});
    assert.equal(result.items.length,1);
    assert.deepEqual(result.items[0],{
      journey_id:'graph:2099-01-03:24:125:12:00:1',train_no:'125',line:'RE20',category:'Persontog',operator:'Vy',operator_code:'VY',
      origin:'Oslo S',destination:'Halden',direction_ref:'HLD',time:'12:00',planned_time:'12:00',expected_time:null,actual_time:null,
      platform:'',passing:true,status:'Hentet fra rutegraf, ingen sanntidsdata',current_location:null,current_location_code:null,
      source:'Bane NOR SIRI PT + rutegraf',event_type:'arrival',graph_fallback:true,graph_only:true,
      graph_route:[{code:'BG',name:'Berg',time:'12:00'},{code:'HLD',name:'Halden',time:'12:10'}],
      graph_url:dailyGraphUrl('2099-01-03',24),
    });
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('uses the production timetable when historical ET is temporarily unavailable', async () => {
  const originalFetch=globalThis.fetch;
  const pt=`<Siri><ServiceDelivery><ProductionTimetableDelivery><ResponseTimestamp>2026-10-06T12:00:00+02:00</ResponseTimestamp><DatedTimetableVersionFrame><OperatorRef>CN</OperatorRef><LineRef>F1</LineRef><DatedVehicleJourney><DatedVehicleJourneyCode>123</DatedVehicleJourneyCode><DatedCalls><DatedCall><StopPointRef>OSL</StopPointRef><StopPointName>Oslo S</StopPointName><AimedArrivalTime>2026-10-06T12:00:00+02:00</AimedArrivalTime></DatedCall></DatedCalls></DatedVehicleJourney></DatedTimetableVersionFrame></ProductionTimetableDelivery></ServiceDelivery></Siri>`;
  globalThis.fetch=async url=>{
    const path=String(url);
    if(path.startsWith('/api/et')) return new Response('utilgjengelig',{status:503});
    if(path.startsWith('/api/pt')) return new Response(pt,{status:200});
    if(path.startsWith('/api/daily-graph-lines')) return Response.json({location:'OSL',lines:[1]});
    if(path.startsWith('/api/daily-graphs')) return Response.json({trains:[],possible_work_trains:[],graphs_loaded:1,graphs_expected:1});
    if(path.startsWith('/api/togkart')) return Response.json({detail:'utilgjengelig'},{status:503});
    throw new Error(`Uventet kall: ${path}`);
  };
  try {
    const result=await queryTrains({locationCode:'OSL',location:'Oslo S',date:'2026-10-06',today:'2026-10-06',fromTime:'00:00',toTime:'13:00'});
    assert.deepEqual(result.items.map(item=>item.train_no),['123']);
    assert.equal(result.items[0].source,'Bane NOR SIRI PT');
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('merges independently processed daily graph lines', () => {
  const merged=mergeDailyGraphResponses([
    {trains:['123'],possible_work_trains:[{train_no:'9001'}],graphs_loaded:1,source_time:'2026-10-06T10:00:00Z'},
    null,
    {trains:['123','456'],possible_work_trains:[{train_no:'9002'}],graphs_loaded:1,source_time:'2026-10-06T10:02:00Z'},
  ],3);
  assert.deepEqual(merged,{
    trains:['123','456'],possible_work_trains:[{train_no:'9001'},{train_no:'9002'}],
    operational_markers:[],operational_sections:[],
    graphs_loaded:2,graphs_expected:3,source_time:'2026-10-06T10:02:00Z',
  });
});

test('builds a cross-midnight section notice from split graph markers', () => {
  const graphData={
    operational_markers:[
      {train_no:'54702',line_number:24,station_code:'HLD',time:'06:53',minute:413},
      {train_no:'54702',line_number:24,station_code:'HLD',time:'22:54',minute:1374},
    ],
    operational_sections:[
      {train_no:'54702',line_number:24,time:'01:52',minute:112,section_codes:['HLD','BG']},
      {train_no:'54702',line_number:24,time:'03:54',minute:234,section_codes:['HLD','BG']},
    ],
  };
  const result=buildGraphOperationalNotices(graphData,'2026-10-06','HLD',[
    {code:'HLD',name:'Halden'},{code:'BG',name:'Berg'},
  ]);
  assert.equal(result.length,2);
  assert.deepEqual(result[1],{
    id:'graph:2026-10-06:24:54702:22:54',trainNo:'54702',route:'Halden–Berg',locationCodes:['HLD','BG'],
    startsAt:'2026-10-06T22:54:00+02:00',endsAt:'2026-10-07T06:53:00+02:00',graphDate:'2026-10-06',graphLine:24,
    message:'Toget er ført mellom Halden og Berg i rutegrafen i dette tidsrommet.',
  });
  assert.equal(buildGraphOperationalNotices(graphData,'2026-10-06','OSL',[]).length,0);
});

test('uses next-day ET cancellation status instead of the uncancelled plan', async () => {
  const originalFetch=globalThis.fetch;
  const pt='<Siri><ServiceDelivery><ProductionTimetableDelivery><DatedTimetableVersionFrame><OperatorRef>VY</OperatorRef><LineRef>RE20</LineRef><DirectionRef>HLD</DirectionRef><DatedVehicleJourney><DatedVehicleJourneyCode>139:2026-10-07</DatedVehicleJourneyCode><ServiceFeatureRef>passengerTrain</ServiceFeatureRef><DatedCalls><DatedCall><StopPointRef>HLD</StopPointRef><StopPointName>Halden</StopPointName><AimedArrivalTime>2026-10-07T02:01:00+02:00</AimedArrivalTime><ArrivalPlatformName>1</ArrivalPlatformName></DatedCall></DatedCalls></DatedVehicleJourney></DatedTimetableVersionFrame></ProductionTimetableDelivery></ServiceDelivery></Siri>';
  const et='<Siri><ServiceDelivery><EstimatedTimetableDelivery><ResponseTimestamp>2026-10-06T23:40:00+02:00</ResponseTimestamp><EstimatedJourneyVersionFrame><EstimatedVehicleJourney><LineRef>RE20</LineRef><DirectionRef>HLD</DirectionRef><DatedVehicleJourneyRef>139:2026-10-07</DatedVehicleJourneyRef><Cancellation>true</Cancellation><OriginName>Oslo S</OriginName><DestinationName>Halden</DestinationName><OperatorRef>VY</OperatorRef><ServiceFeatureRef>passengerTrain</ServiceFeatureRef><VehicleRef>139</VehicleRef><EstimatedCalls><EstimatedCall><StopPointRef>HLD</StopPointRef><StopPointName>Halden</StopPointName><Cancellation>true</Cancellation><AimedArrivalTime>2026-10-07T02:01:00+02:00</AimedArrivalTime><ArrivalStatus>cancelled</ArrivalStatus><ArrivalPlatformName>1</ArrivalPlatformName></EstimatedCall></EstimatedCalls></EstimatedVehicleJourney></EstimatedJourneyVersionFrame></EstimatedTimetableDelivery></ServiceDelivery></Siri>';
  globalThis.fetch=async url=>{
    const path=String(url);
    if(path.startsWith('/api/pt')) return new Response(pt,{status:200});
    if(path.startsWith('/api/et')) return new Response(et,{status:200});
    if(path.startsWith('/api/daily-graph-lines')) return Response.json({location:'HLD',lines:[]});
    throw new Error(`Uventet kall: ${path}`);
  };
  try {
    const result=await queryTrains({locationCode:'HLD',location:'Halden',date:'2026-10-07',today:'2026-10-06',fromTime:'00:00',toTime:'03:00'});
    assert.equal(result.items.length,1);
    assert.equal(result.items[0].train_no,'139');
    assert.equal(result.items[0].status,'Innstilt');
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('builds a date-specific Bane NOR graph link for the selected route', () => {
  const url=new URL(dailyGraphUrl('2026-10-06',24));
  assert.equal(url.searchParams.get('dateInput'),'2026-10-06');
  assert.equal(url.searchParams.get('selectLine'),'24');
});
