import { XMLParser } from 'fast-xml-parser';

const OPERATOR_NAMES = {
  VY:'Vy', FLY:'Flytoget', VYT:'Vy Tåg', GAG:'Go-Ahead Nordic', SJN:'SJ Norge', SJ:'SJ',
  CN:'CargoNet', GR:'Grenland Rail', ONR:'OnRail', RCT:'Railcare', HER:'Hector Rail',
  BLS:'BLS Rail', 'TÅB':'Tågåkeriet i Bergslagen', BN:'Bane NOR'
};
const parser = new XMLParser({
  removeNSPrefix:true, ignoreAttributes:true, parseTagValue:false, trimValues:true,
  isArray:(name)=>['EstimatedJourneyVersionFrame','EstimatedVehicleJourney','RecordedCall','EstimatedCall',
    'DatedTimetableVersionFrame','DatedVehicleJourney','DatedCall','MonitoredStopVisit'].includes(name),
});
const arr = value => value == null ? [] : Array.isArray(value) ? value : [value];
const LIVE_LOOKBACK_MINUTES = 360;
let locationsPromise = null;
let liveEtCache = null;
let togkartCache = null;
const planCache = new Map();
const filteredEtCache = new Map();

function searchKey(value='') {
  return String(value).toLocaleLowerCase('no').replaceAll('ø','o').replaceAll('æ','ae').replaceAll('å','a')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
}
async function locations() {
  if (!locationsPromise) locationsPromise = fetch('/locations.json').then(r => { if(!r.ok) throw new Error('Kunne ikke laste stedskoder'); return r.json(); });
  return locationsPromise;
}
export async function searchLocations(q, limit=15) {
  const items = await locations();
  const needle = searchKey(String(q).trim());
  if (!needle) return items.slice(0,limit);
  return items.map(item => {
    const nk=searchKey(item.name), ck=searchKey(item.code);
    if (!nk.includes(needle) && !ck.includes(needle)) return null;
    const rank=nk.startsWith(needle)?0:ck.startsWith(needle)?1:2;
    return {rank,item};
  }).filter(Boolean).sort((a,b)=>a.rank-b.rank || a.item.name.length-b.item.name.length || a.item.name.localeCompare(b.item.name,'no'))
    .slice(0,limit).map(x=>x.item);
}
async function resolveLocation(value) {
  const items=await locations(), key=searchKey(String(value).trim());
  const exact=items.find(x=>searchKey(x.code)===key || searchKey(x.name)===key);
  return exact || (await searchLocations(value,1))[0] || null;
}
export async function nearestLocation(lat, lon) {
  const p=new URLSearchParams({lat:String(lat),lon:String(lon)});
  const r=await fetch(`/api/nearest?${p}`); const data=await r.json();
  if(!r.ok) throw new Error(data?.detail || 'Fant ikke nærmeste stasjon');
  for(const feature of data.features || []) {
    const name=String(feature?.properties?.name || '').trim();
    const candidates=[name];
    for(const suffix of [' stasjon',' holdeplass']) if(name.toLocaleLowerCase('no').endsWith(suffix)) candidates.push(name.slice(0,-suffix.length).trim());
    for(const candidate of candidates) { const found=await resolveLocation(candidate); if(found) return found; }
  }
  throw new Error('Fant ingen nærliggende jernbanestasjon');
}
function deepValue(obj,key) {
  if(!obj || typeof obj!=='object') return null;
  if(Object.prototype.hasOwnProperty.call(obj,key)) return obj[key];
  for(const value of Object.values(obj)) { const found=deepValue(value,key); if(found!=null) return found; }
  return null;
}
const isoClock = iso => iso ? String(iso).slice(11,16) : null;
const isoDate = iso => iso ? String(iso).slice(0,10) : null;
function parseCall(call={}, state='planned') {
  const aimedArr=call.AimedArrivalTime || '', aimedDep=call.AimedDepartureTime || '';
  const expectedArr=call.ExpectedArrivalTime || '', expectedDep=call.ExpectedDepartureTime || '';
  const actualArr=call.ActualArrivalTime || '', actualDep=call.ActualDepartureTime || '';
  const planned=aimedDep || aimedArr, expected=expectedDep || expectedArr, actual=actualDep || actualArr;
  const raw=call.DepartureStatus || call.ArrivalStatus || '';
  const cancelled=String(raw).toLowerCase()==='cancelled' || String(deepValue(call,'Cancellation') || '').toLowerCase()==='true';
  return {
    code:call.StopPointRef || '', name:call.StopPointName || call.StopPointRef || '',
    planned_iso:planned, expected_iso:expected, actual_iso:actual,
    aimed_arrival_iso:aimedArr, aimed_departure_iso:aimedDep,
    expected_arrival_iso:expectedArr, expected_departure_iso:expectedDep,
    actual_arrival_iso:actualArr, actual_departure_iso:actualDep,
    planned:isoClock(planned), expected:isoClock(expected), actual:isoClock(actual),
    platform:call.DeparturePlatformName || call.ArrivalPlatformName || '',
    passing:[call.DepartureBoardingActivity,call.ArrivalBoardingActivity].some(v=>String(v || '').toLowerCase()==='passthru'),
    status_raw:cancelled?'cancelled':raw, state,
  };
}
function category(feature='', product='', operator='') {
  if(operator==='BN') return 'Arbeidstog';
  if(operator==='FLY') return 'Persontog';
  const f=String(feature).toLowerCase(), p=String(product).toUpperCase();
  if(p==='A2') return 'Arbeidstog';
  if(f==='freighttrain' || f==='goodstrain') return 'Godstog';
  if(f==='passengertrain') return 'Persontog';
  if(p==='GMB') return 'Godstog';
  if(['LT','RT','CH','CHT'].includes(p)) return 'Persontog';
  return 'Ukjent';
}
function delayMinutes(call) {
  if(!call?.planned_iso || !call?.expected_iso) return null;
  const a=new Date(call.planned_iso), b=new Date(call.expected_iso);
  if(Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b-a)/60000);
}
function delayStatus(call) {
  const raw=String(call?.status_raw || '').toLowerCase();
  if(raw==='cancelled') return 'Innstilt';
  const plannedMs=Date.parse(call?.planned_iso || ''), expectedMs=Date.parse(call?.expected_iso || '');
  if(Number.isFinite(plannedMs) && Number.isFinite(expectedMs) && expectedMs<=plannedMs) return null;
  const delay=delayMinutes(call);
  if(delay!=null && delay>=1) return `Forsinket +${delay} min`;
  if(raw==='delayed') return 'Forsinket';
  return null;
}
function callHasPassed(call) {
  if(!call) return false;
  // At a stop with a scheduled departure, arrival alone must not count as passed.
  // This keeps a passenger train at the platform as active until it actually departs.
  if(call.aimed_departure_iso) return Boolean(call.actual_departure_iso);
  // At the final stop there is no departure; actual arrival completes the call.
  return Boolean(call.actual_arrival_iso || call.actual_iso);
}
function journeyStarted(journey) {
  return Boolean(journey?.route?.some(call => call.state==='recorded' &&
    (call.actual_departure_iso || call.actual_arrival_iso || call.actual_iso)));
}
export function journeyCallStatus(journey, call) {
  const delayed=delayStatus(call);
  if(delayed==='Innstilt') return delayed;
  if(callHasPassed(call)) return 'Passert';
  // Before the first recorded movement, the train is still only planned.
  if(!journeyStarted(journey)) return delayed || 'Planlagt';
  if(delayed) return delayed;
  return 'I rute';
}
export function smFallbackStatus(call) {
  const delayed=delayStatus(call);
  if(delayed==='Innstilt') return delayed;
  if(callHasPassed(call)) return 'Passert';
  if(delayed) return delayed;
  // Stop Monitoring alone does not tell us whether the journey has actually begun.
  // The ET enrichment below upgrades started journeys to "I rute".
  return 'Planlagt';
}
function parseEt(xml) {
  const root=parser.parse(xml); const service=root?.Siri?.ServiceDelivery || {};
  const delivery=service.EstimatedTimetableDelivery || {};
  const frames=arr(delivery.EstimatedJourneyVersionFrame); const journeys=[];
  for(const frame of frames) for(const elem of arr(frame?.EstimatedVehicleJourney)) {
    const operator=elem?.OperatorRef || '', product=elem?.ProductCategoryRef || '', feature=elem?.ServiceFeatureRef || '';
    const route=[...arr(elem?.RecordedCalls?.RecordedCall).map(c=>parseCall(c,'recorded')),
      ...arr(elem?.EstimatedCalls?.EstimatedCall).map(c=>parseCall(c,'estimated'))];
    if(!route.length) continue;
    const id=elem?.DatedVehicleJourneyRef || ''; const trainNo=elem?.VehicleRef || String(id).split(':')[0] || '–';
    journeys.push({journey_id:id || `${trainNo}:${route[0]?.planned_iso || ''}`,train_no:trainNo,line:elem?.LineRef || '',
      operator_code:operator,operator:OPERATOR_NAMES[operator] || operator || 'Ukjent',category:category(feature,product,operator),
      origin:elem?.OriginName || route[0].name,destination:elem?.DestinationName || route.at(-1).name,direction_ref:elem?.DirectionRef || '',
      product,feature,route,source:'Bane NOR SIRI ET'});
  }
  return {journeys,source_time:delivery.ResponseTimestamp || service.ResponseTimestamp || null};
}
function parsePt(xml) {
  const root=parser.parse(xml); const service=root?.Siri?.ServiceDelivery || {}; const delivery=service.ProductionTimetableDelivery || {};
  const journeys=[];
  for(const frame of arr(delivery.DatedTimetableVersionFrame)) {
    const operator=frame?.OperatorRef || '', line=frame?.LineRef || '', direction=frame?.DirectionRef || '';
    for(const elem of arr(frame?.DatedVehicleJourney)) {
      const id=elem?.DatedVehicleJourneyCode || '–', trainNo=String(id).split(':')[0] || '–';
      const product=elem?.ProductCategoryRef || '', feature=elem?.ServiceFeatureRef || '';
      const route=arr(elem?.DatedCalls?.DatedCall).map(c=>parseCall(c,'planned')); if(!route.length) continue;
      journeys.push({journey_id:id,train_no:trainNo,line,operator_code:operator,operator:OPERATOR_NAMES[operator] || operator || 'Ukjent',
        category:category(feature,product,operator),origin:route[0].name,destination:route.at(-1).name,direction_ref:direction,
        product,feature,route,source:'Bane NOR SIRI PT'});
    }
  }
  return {journeys,source_time:delivery.ResponseTimestamp || service.ResponseTimestamp || null};
}
function epochOsloIso(value) {
  if(!value) return '';
  const d=new Date(Number(value)*1000);
  if(Number.isNaN(d.getTime())) return '';
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }).formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const date=`${parts.year}-${parts.month}-${parts.day}`, time=`${parts.hour}:${parts.minute}:${parts.second}`;
  return `${date}T${time}${offsetFor(date,`${parts.hour}:${parts.minute}`)}`;
}
function togkartCategory(fare) {
  if(fare?.company==='BN') return 'Arbeidstog';
  const kind=String(fare?.train_kind || '').toUpperCase();
  if(kind==='AT' || kind==='TRT') return 'Arbeidstog';
  if(kind==='GT' || kind==='EGT') return 'Godstog';
  if(kind==='PT' || kind==='EPT') return 'Persontog';
  return category('',fare?.train_type || '',fare?.company || '');
}
async function parseTogkart(data) {
  const locs=await locations(), names=new Map(locs.map(x=>[x.code,x.name]));
  const journeys=[];
  for(const fare of data?.Fares || []) {
    const route=(fare.stops || []).map(stop=>{
      const aimedArr=epochOsloIso(stop.sta), aimedDep=epochOsloIso(stop.std);
      const expectedArr=epochOsloIso(stop.eta), expectedDep=epochOsloIso(stop.etd);
      const actualArr=epochOsloIso(stop.ata), actualDep=epochOsloIso(stop.atd);
      const planned=aimedDep || aimedArr, expected=expectedDep || expectedArr, actual=actualDep || actualArr;
      const cancelled=stop.cancel && stop.cancel!=='N';
      return {
        code:stop.city || '', name:names.get(stop.city) || stop.city || '',
        planned_iso:planned, expected_iso:expected, actual_iso:actual,
        aimed_arrival_iso:aimedArr, aimed_departure_iso:aimedDep,
        expected_arrival_iso:expectedArr, expected_departure_iso:expectedDep,
        actual_arrival_iso:actualArr, actual_departure_iso:actualDep,
        planned:isoClock(planned), expected:isoClock(expected), actual:isoClock(actual),
        platform:String(stop.track ?? stop.planned_track ?? ''), passing:String(stop.activity || '').toUpperCase()==='P',
        status_raw:cancelled?'cancelled':'', state:(actualArr || actualDep)?'recorded':'estimated', activity:stop.activity || ''
      };
    });
    if(!route.length) continue;
    const operator=fare.company || '';
    journeys.push({
      journey_id:fare.train_id || `${fare.train_no || '–'}:${isoDate(route[0]?.planned_iso || '')}`,
      train_no:String(fare.train_no ?? '–'), line:fare.line_no || '', operator_code:operator,
      operator:fare.company_name || OPERATOR_NAMES[operator] || operator || 'Ukjent', category:togkartCategory(fare),
      origin:names.get(fare.origin) || fare.origin || route[0].name,
      destination:names.get(fare.destination) || fare.destination || route.at(-1).name,
      direction_ref:'', product:fare.train_type || '', feature:fare.train_kind || '', route,
      source:'Bane NOR Togkart'
    });
  }
  return {journeys,source_time:new Date().toISOString()};
}

function selectedCall(journey, code) { return journey.route.find(c=>c.code===code) || null; }
function currentPosition(journey) { const recorded=journey.route.filter(c=>c.state==='recorded'); return recorded.at(-1) || null; }
function callIso(call) {
  if(!call) return '';
  if(call.aimed_departure_iso) return call.actual_departure_iso || call.expected_departure_iso || call.aimed_departure_iso || '';
  return call.actual_arrival_iso || call.expected_arrival_iso || call.aimed_arrival_iso || call.actual_iso || call.expected_iso || call.planned_iso || '';
}
export function callWindowState(call, selectedDate, fromTime, toTime, includeOverdue=false) {
  const iso=callIso(call); if(!iso || isoDate(iso)!==selectedDate) return {include:false,clock:null,overdue:false};
  const clock=isoClock(iso); if(!clock || clock>toTime) return {include:false,clock,overdue:false};
  if(clock>=fromTime) return {include:true,clock,overdue:false};
  if(!includeOverdue || callHasPassed(call) || delayStatus(call)==='Innstilt') return {include:false,clock,overdue:false};
  const plannedIso=call.planned_iso || '';
  const plannedClock=isoClock(plannedIso);
  const overdue=isoDate(plannedIso)===selectedDate && Boolean(plannedClock) && plannedClock<fromTime && plannedClock<=toTime;
  return {include:overdue,clock,overdue};
}
function queryDataset(dataset, locationCode, selectedDate, fromTime, toTime, includeOverdue=false) {
  const items=[];
  for(const journey of dataset.journeys) {
    const call=selectedCall(journey,locationCode); if(!call) continue;
    const window=callWindowState(call,selectedDate,fromTime,toTime,includeOverdue); if(!window.include) continue;
    const clock=window.clock;
    const current=currentPosition(journey);
    const baseStatus=journeyCallStatus(journey,call);
    items.push({journey_id:journey.journey_id,train_no:journey.train_no,line:journey.line,category:journey.category,
      operator:journey.operator,operator_code:journey.operator_code,origin:journey.origin,destination:journey.destination,
      direction_ref:journey.direction_ref,time:clock,planned_time:call.planned,expected_time:call.expected,actual_time:call.actual,
      platform:call.platform,passing:Boolean(call.passing),status:window.overdue && !String(baseStatus).includes('Forsinket')?'Forsinket':baseStatus,
      current_location:current?.name || null,source:journey.source});
  }
  items.sort((a,b)=>a.time.localeCompare(b.time) || String(a.train_no).localeCompare(String(b.train_no),undefined,{numeric:true}));
  return items;
}
function offsetFor(date,time='12:00') {
  const probe=new Date(`${date}T${time}:00Z`);
  const value=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Oslo',timeZoneName:'longOffset'}).formatToParts(probe).find(p=>p.type==='timeZoneName')?.value || 'GMT+01:00';
  return value.replace('GMT','');
}
function zonedIso(date,time) { return `${date}T${time}:00${offsetFor(date,time)}`; }
function addDays(date,days) { const d=new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function minutes(hhmm) { const [h,m]=hhmm.split(':').map(Number); return h*60+m; }
async function fetchText(url) { const r=await fetch(url); const text=await r.text(); if(!r.ok) throw new Error(`Datakilden svarte ${r.status}`); return text; }
async function fetchJson(url) { const r=await fetch(url); const data=await r.json(); if(!r.ok) throw new Error(`Datakilden svarte ${r.status}`); return data; }
async function getTogkart(force=false) {
  if(!force && togkartCache && Date.now()-togkartCache.ts<20000) return togkartCache.data;
  const data=await parseTogkart(await fetchJson('/api/togkart'));
  togkartCache={ts:Date.now(),data}; return data;
}
async function getLiveEt(force=false) {
  if(!force && liveEtCache && Date.now()-liveEtCache.ts<45000) return liveEtCache.data;
  const data=parseEt(await fetchText('/api/et')); liveEtCache={ts:Date.now(),data}; return data;
}
async function getFilteredEt(item, force=false) {
  const key=[item.operator_code,item.line,item.direction_ref].join('|'); const cached=filteredEtCache.get(key);
  if(!force && cached && Date.now()-cached.ts<45000) return cached.data;
  const p=new URLSearchParams(); if(item.operator_code) p.set('OperatorRef',item.operator_code);
  if(item.line) p.set('Lines.LineDirection.LineRef',item.line); if(item.direction_ref) p.set('Lines.LineDirection.DirectionRef',item.direction_ref);
  const data=parseEt(await fetchText(`/api/et?${p}`)); filteredEtCache.set(key,{ts:Date.now(),data}); return data;
}
async function getPlan(date, force=false) {
  const cached=planCache.get(date); if(cached && Date.now()-cached.ts<600000) return cached.data;
  const p=new URLSearchParams({'ValidityPeriod.StartTime':zonedIso(addDays(date,-1),'16:00'),'ValidityPeriod.EndTime':zonedIso(addDays(date,1),'00:00')});
  const data=parsePt(await fetchText(`/api/pt?${p}`)); planCache.set(date,{ts:Date.now(),data}); return data;
}
function parseSm(xml, locationCode, date, fromTime, toTime, includeOverdue=false) {
  const root=parser.parse(xml); const service=root?.Siri?.ServiceDelivery || {};
  if(String(service.Status).toLowerCase()==='false' || service.ErrorCondition) return {unsupported:true,items:[],source_time:service.ResponseTimestamp || null};
  const delivery=service.StopMonitoringDelivery || {}; const items=[];
  for(const visit of arr(delivery.MonitoredStopVisit)) {
    const j=visit?.MonitoredVehicleJourney || {}, c=parseCall(j.MonitoredCall || {},'estimated');
    c.code=locationCode; const window=callWindowState(c,date,fromTime,toTime,includeOverdue); if(!window.include) continue;
    const clock=window.clock;
    const operator=j.OperatorRef || '', product=j.ProductCategoryRef || '', feature=j.ServiceFeatureRef || '';
    const id=j?.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || visit.ItemIdentifier || `${j.VehicleRef || '–'}:${date}`;
    items.push({journey_id:id,train_no:j.VehicleRef || String(id).split(':')[0] || '–',line:j.LineRef || j.PublishedLineName || '',
      category:category(feature,product,operator),operator:OPERATOR_NAMES[operator] || operator || 'Ukjent',operator_code:operator,
      origin:j.OriginName || '',destination:j.DestinationName || '',direction_ref:j.DirectionRef || '',time:clock,
      planned_time:c.planned,expected_time:c.expected,actual_time:c.actual,platform:c.platform,passing:Boolean(c.passing),
      status:window.overdue?'Forsinket':smFallbackStatus(c),current_location:null,source:'Bane NOR SIRI SM'});
  }
  items.sort((a,b)=>a.time.localeCompare(b.time) || String(a.train_no).localeCompare(String(b.train_no),undefined,{numeric:true}));
  return {unsupported:false,items,source_time:delivery.ResponseTimestamp || service.ResponseTimestamp || null};
}
async function enrichTogkartMetadata(items) {
  if(!items.length) return items;
  const groups=new Map();
  for(const item of items) {
    const key=[item.operator_code,item.line].join('|');
    if(item.operator_code && item.line && !groups.has(key)) groups.set(key,{...item,direction_ref:''});
  }
  const datasets=new Map();
  await Promise.all([...groups.entries()].map(async ([key,item])=>{
    try { datasets.set(key,await getFilteredEt(item)); } catch { datasets.set(key,null); }
  }));
  return items.map(item=>{
    const dataset=datasets.get([item.operator_code,item.line].join('|'));
    const meta=dataset?.journeys?.find(j=>j.journey_id===item.journey_id);
    if(!meta) return item;
    return {...item,
      origin:meta.origin || item.origin,destination:meta.destination || item.destination,
      operator:meta.operator || item.operator,category:meta.category || item.category,
      direction_ref:meta.direction_ref || item.direction_ref};
  });
}

async function enrichSmItems(items, locationCode) {
  if(!items.length) return items;
  const groups=new Map();
  for(const item of items) {
    const key=[item.operator_code,item.line,item.direction_ref].join('|');
    if(!groups.has(key)) groups.set(key,item);
  }
  const datasets=new Map();
  await Promise.all([...groups.entries()].map(async ([key,item]) => {
    try { datasets.set(key,await getFilteredEt(item)); } catch { datasets.set(key,null); }
  }));
  return items.map(item => {
    const key=[item.operator_code,item.line,item.direction_ref].join('|');
    const dataset=datasets.get(key);
    const journey=dataset?.journeys?.find(j=>j.journey_id===item.journey_id);
    if(!journey) return item;
    const call=selectedCall(journey,locationCode);
    if(!call) return item;
    const current=currentPosition(journey);
    return {...item,
      planned_time:call.planned || item.planned_time, expected_time:call.expected || item.expected_time,
      actual_time:call.actual || item.actual_time, platform:call.platform || item.platform, passing:Boolean(call.passing || item.passing),
      status:journeyCallStatus(journey,call), current_location:current?.name || null, source:'Bane NOR SIRI ET'};
  });
}
export async function queryTrains({locationCode,location,date,fromTime,toTime,today}) {
  if(date===today) {
    const nowOslo=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
    const historical=minutes(toTime)<minutes(nowOslo) || minutes(fromTime)<minutes(nowOslo)-30;
    if(historical) {
      const et=await getLiveEt();
      const etItems=queryDataset(et,locationCode,date,fromTime,toTime);
      try {
        const live=await getTogkart();
        const liveItems=await enrichTogkartMetadata(queryDataset(live,locationCode,date,fromTime,toTime));
        const merged=new Map(etItems.map(item=>[item.journey_id,item]));
        for(const item of liveItems) {
          const base=merged.get(item.journey_id);
          merged.set(item.journey_id,base?{...base,...item,
            origin:base.origin || item.origin,destination:base.destination || item.destination,
            operator:base.operator || item.operator,category:base.category || item.category,
            line:base.line || item.line,direction_ref:base.direction_ref || item.direction_ref}:item);
        }
        const items=[...merged.values()].sort((a,b)=>a.time.localeCompare(b.time) || String(a.train_no).localeCompare(String(b.train_no),undefined,{numeric:true}));
        return {items,source_time:live.source_time || et.source_time,mode:'live',location,location_code:locationCode,date};
      } catch {}
      return {items:etItems,source_time:et.source_time,mode:'live',location,location_code:locationCode,date};
    }
    const smStartMinutes=Math.max(0,minutes(fromTime)-LIVE_LOOKBACK_MINUTES);
    const smStart=`${String(Math.floor(smStartMinutes/60)).padStart(2,'0')}:${String(smStartMinutes%60).padStart(2,'0')}`;
    const span=Math.max(1,minutes(toTime)-smStartMinutes);
    const p=new URLSearchParams({MonitoringRef:locationCode,StartTime:zonedIso(date,smStart),PreviewInterval:`PT${span}M`,MaximumStopVisits:'2000'});
    let smItems=[], smTime=null, liveItems=[], liveTime=null;
    try {
      const sm=parseSm(await fetchText(`/api/sm?${p}`),locationCode,date,fromTime,toTime,true);
      if(!sm.unsupported) { smItems=await enrichSmItems(sm.items,locationCode); smTime=sm.source_time; }
    } catch {}
    try {
      const live=await getTogkart();
      liveItems=await enrichTogkartMetadata(queryDataset(live,locationCode,date,fromTime,toTime,true));
      liveTime=live.source_time;
    } catch {}
    if(smItems.length || liveItems.length) {
      const merged=new Map(smItems.map(item=>[item.journey_id,item]));
      for(const item of liveItems) {
        const base=merged.get(item.journey_id);
        merged.set(item.journey_id,base?{...item,
          origin:base.origin || item.origin,destination:base.destination || item.destination,
          operator:base.operator || item.operator,category:base.category || item.category,
          line:base.line || item.line,direction_ref:base.direction_ref || item.direction_ref}:item);
      }
      const items=[...merged.values()].sort((a,b)=>a.time.localeCompare(b.time) || String(a.train_no).localeCompare(String(b.train_no),undefined,{numeric:true}));
      return {items,source_time:liveTime || smTime,mode:'live',location,location_code:locationCode,date};
    }
    const et=await getLiveEt(); return {items:queryDataset(et,locationCode,date,fromTime,toTime,true),source_time:et.source_time,mode:'live',location,location_code:locationCode,date};
  }
  const pt=await getPlan(date); return {items:queryDataset(pt,locationCode,date,fromTime,toTime),source_time:pt.source_time,mode:'planned',location,location_code:locationCode,date};
}
function detailFromJourney(journey, locationCode, sourceTime) {
  if(!journey) return null; const selected=selectedCall(journey,locationCode), current=currentPosition(journey);
  const currentIndex=current ? journey.route.indexOf(current) : -1;
  const route=journey.route.map((call,index)=>({code:call.code,name:call.name,planned:call.planned,expected:call.expected,actual:call.actual,
    platform:call.platform,passing:Boolean(call.passing),status:currentIndex>=0 && index<currentIndex?'Passert':journeyCallStatus(journey,call),
    state:currentIndex>=0 && index<currentIndex?'recorded':current===call?'current':call.state,selected:call.code===locationCode}));
  const selectedIndex=selected ? journey.route.indexOf(selected) : -1;
  const selectedStatus=selected ? (currentIndex>=0 && selectedIndex<currentIndex?'Passert':journeyCallStatus(journey,selected)) : '–';
  return {journey_id:journey.journey_id,train_no:journey.train_no,line:journey.line,category:journey.category,operator:journey.operator,
    origin:journey.origin,destination:journey.destination,status:selectedStatus,passing:Boolean(selected?.passing),selected_time:selected?isoClock(callIso(selected)):null,
    current_location:current?.name || 'Ikke registrert ennå',route,source:journey.source,source_time:sourceTime};
}
export async function trainDetail({journeyId,date,locationCode,today,item,force=false}) {
  let dataset;
  if(date===today) {
    try {
      dataset=await getTogkart(force);
      let j=dataset.journeys.find(x=>x.journey_id===journeyId);
      if(j) {
        if(item) {
          try {
            const et=await getFilteredEt(item,force), meta=et.journeys.find(x=>x.journey_id===journeyId);
            if(meta) j={...j,origin:meta.origin || j.origin,destination:meta.destination || j.destination,operator:meta.operator || j.operator,category:meta.category || j.category};
          } catch {}
        }
        return detailFromJourney(j,locationCode,dataset.source_time);
      }
    } catch {}
    if(item) { dataset=await getFilteredEt(item,force); let j=dataset.journeys.find(x=>x.journey_id===journeyId); if(j) return detailFromJourney(j,locationCode,dataset.source_time); }
    dataset=await getLiveEt(true);
  } else dataset=await getPlan(date,force);
  return detailFromJourney(dataset.journeys.find(x=>x.journey_id===journeyId),locationCode,dataset.source_time);
}
