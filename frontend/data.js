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
let locationsPromise = null;
let liveEtCache = null;
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
    planned:isoClock(planned), expected:isoClock(expected), actual:isoClock(actual),
    platform:call.DeparturePlatformName || call.ArrivalPlatformName || '',
    status_raw:cancelled?'cancelled':raw, state,
  };
}
function category(feature='', product='', operator='') {
  if(operator==='BN') return 'Arbeidstog';
  if(operator==='FLY') return 'Persontog';
  const f=String(feature).toLowerCase(), p=String(product).toUpperCase();
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
function callStatus(call) {
  const raw=String(call?.status_raw || '').toLowerCase();
  if(raw==='cancelled') return 'Innstilt';
  const delay=delayMinutes(call);
  if(raw==='delayed' || (delay!=null && delay>=1)) return `Forsinket +${Math.max(delay || 0,0)} min`;
  if(call?.actual_iso || call?.state==='recorded') return 'Passert';
  if(['ontime','on_time'].includes(raw)) return 'I rute';
  // SIRI Stop Monitoring commonly reports "noReport" even when it supplies an
  // expected time. In that case the expected-vs-planned deviation is the useful
  // live signal: under the delay threshold means the train is currently in route.
  if(call?.expected_iso && delay!=null) return 'I rute';
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
function selectedCall(journey, code) { return journey.route.find(c=>c.code===code) || null; }
function currentPosition(journey) { const recorded=journey.route.filter(c=>c.state==='recorded'); return recorded.at(-1) || null; }
function callIso(call) { return call?.actual_iso || call?.expected_iso || call?.planned_iso || ''; }
function queryDataset(dataset, locationCode, selectedDate, fromTime, toTime) {
  const items=[];
  for(const journey of dataset.journeys) {
    const call=selectedCall(journey,locationCode); if(!call) continue;
    const iso=callIso(call); if(!iso || isoDate(iso)!==selectedDate) continue;
    const clock=isoClock(iso); if(!clock || clock<fromTime || clock>toTime) continue;
    const current=currentPosition(journey);
    items.push({journey_id:journey.journey_id,train_no:journey.train_no,line:journey.line,category:journey.category,
      operator:journey.operator,operator_code:journey.operator_code,origin:journey.origin,destination:journey.destination,
      direction_ref:journey.direction_ref,time:clock,planned_time:call.planned,expected_time:call.expected,actual_time:call.actual,
      platform:call.platform,status:callStatus(call),current_location:current?.name || null,source:journey.source});
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
async function getLiveEt(force=false) {
  if(!force && liveEtCache && Date.now()-liveEtCache.ts<45000) return liveEtCache.data;
  const data=parseEt(await fetchText('/api/et')); liveEtCache={ts:Date.now(),data}; return data;
}
async function getFilteredEt(item) {
  const key=[item.operator_code,item.line,item.direction_ref].join('|'); const cached=filteredEtCache.get(key);
  if(cached && Date.now()-cached.ts<45000) return cached.data;
  const p=new URLSearchParams(); if(item.operator_code) p.set('OperatorRef',item.operator_code);
  if(item.line) p.set('Lines.LineDirection.LineRef',item.line); if(item.direction_ref) p.set('Lines.LineDirection.DirectionRef',item.direction_ref);
  const data=parseEt(await fetchText(`/api/et?${p}`)); filteredEtCache.set(key,{ts:Date.now(),data}); return data;
}
async function getPlan(date) {
  const cached=planCache.get(date); if(cached && Date.now()-cached.ts<600000) return cached.data;
  const p=new URLSearchParams({'ValidityPeriod.StartTime':zonedIso(addDays(date,-1),'16:00'),'ValidityPeriod.EndTime':zonedIso(addDays(date,1),'00:00')});
  const data=parsePt(await fetchText(`/api/pt?${p}`)); planCache.set(date,{ts:Date.now(),data}); return data;
}
function parseSm(xml, locationCode, date, fromTime, toTime) {
  const root=parser.parse(xml); const service=root?.Siri?.ServiceDelivery || {};
  if(String(service.Status).toLowerCase()==='false' || service.ErrorCondition) return {unsupported:true,items:[],source_time:service.ResponseTimestamp || null};
  const delivery=service.StopMonitoringDelivery || {}; const items=[];
  for(const visit of arr(delivery.MonitoredStopVisit)) {
    const j=visit?.MonitoredVehicleJourney || {}, c=parseCall(j.MonitoredCall || {},'estimated');
    c.code=locationCode; const iso=callIso(c); if(!iso || isoDate(iso)!==date) continue;
    const clock=isoClock(iso); if(!clock || clock<fromTime || clock>toTime) continue;
    const operator=j.OperatorRef || '', product=j.ProductCategoryRef || '', feature=j.ServiceFeatureRef || '';
    const id=j?.FramedVehicleJourneyRef?.DatedVehicleJourneyRef || visit.ItemIdentifier || `${j.VehicleRef || '–'}:${date}`;
    items.push({journey_id:id,train_no:j.VehicleRef || String(id).split(':')[0] || '–',line:j.LineRef || j.PublishedLineName || '',
      category:category(feature,product,operator),operator:OPERATOR_NAMES[operator] || operator || 'Ukjent',operator_code:operator,
      origin:j.OriginName || '',destination:j.DestinationName || '',direction_ref:j.DirectionRef || '',time:clock,
      planned_time:c.planned,expected_time:c.expected,actual_time:c.actual,platform:c.platform,status:callStatus(c),current_location:null,source:'Bane NOR SIRI SM'});
  }
  items.sort((a,b)=>a.time.localeCompare(b.time) || String(a.train_no).localeCompare(String(b.train_no),undefined,{numeric:true}));
  return {unsupported:false,items,source_time:delivery.ResponseTimestamp || service.ResponseTimestamp || null};
}
export async function queryTrains({locationCode,location,date,fromTime,toTime,today}) {
  if(date===today) {
    const nowOslo=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
    const historical=minutes(toTime)<minutes(nowOslo) || minutes(fromTime)<minutes(nowOslo)-30;
    if(historical) {
      const et=await getLiveEt();
      return {items:queryDataset(et,locationCode,date,fromTime,toTime),source_time:et.source_time,mode:'live',location,location_code:locationCode,date};
    }
    const span=Math.max(1,minutes(toTime)-minutes(fromTime));
    const p=new URLSearchParams({MonitoringRef:locationCode,StartTime:zonedIso(date,fromTime),PreviewInterval:`PT${span}M`,MaximumStopVisits:'2000'});
    const sm=parseSm(await fetchText(`/api/sm?${p}`),locationCode,date,fromTime,toTime);
    if(!sm.unsupported) return {items:sm.items,source_time:sm.source_time,mode:'live',location,location_code:locationCode,date};
    const et=await getLiveEt(); return {items:queryDataset(et,locationCode,date,fromTime,toTime),source_time:et.source_time,mode:'live',location,location_code:locationCode,date};
  }
  const pt=await getPlan(date); return {items:queryDataset(pt,locationCode,date,fromTime,toTime),source_time:pt.source_time,mode:'planned',location,location_code:locationCode,date};
}
function detailFromJourney(journey, locationCode, sourceTime) {
  if(!journey) return null; const selected=selectedCall(journey,locationCode), current=currentPosition(journey);
  const route=journey.route.map(call=>({code:call.code,name:call.name,planned:call.planned,expected:call.expected,actual:call.actual,
    platform:call.platform,status:callStatus(call),state:current===call?'current':call.state,selected:call.code===locationCode}));
  return {journey_id:journey.journey_id,train_no:journey.train_no,line:journey.line,category:journey.category,operator:journey.operator,
    origin:journey.origin,destination:journey.destination,status:selected?callStatus(selected):'–',selected_time:selected?isoClock(callIso(selected)):null,
    current_location:current?.name || 'Ikke registrert ennå',route,source:journey.source,source_time:sourceTime};
}
export async function trainDetail({journeyId,date,locationCode,today,item}) {
  let dataset;
  if(date===today) {
    if(item) { dataset=await getFilteredEt(item); let j=dataset.journeys.find(x=>x.journey_id===journeyId); if(j) return detailFromJourney(j,locationCode,dataset.source_time); }
    dataset=await getLiveEt(true);
  } else dataset=await getPlan(date);
  return detailFromJourney(dataset.journeys.find(x=>x.journey_id===journeyId),locationCode,dataset.source_time);
}
