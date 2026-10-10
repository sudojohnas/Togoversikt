import { DAILY_GRAPH_COUNT, extractDailyGraphData, graphResponseVersion, graphUrl, matchCandidateTrainNumbers } from './daily-graphs.js';
import STATION_GRAPH_LINES from './station-graph-map.json' with { type: 'json' };
import LOCATIONS from '../public/locations.json' with { type: 'json' };
import { filterEstimatedTimetableXml, filterProductionTimetableXml } from './pt-filter.js';

const SIRI = 'https://siri.banenor.no/jbv';
const ENTUR = 'https://api.entur.io/geocoder/v1/reverse';
const TOGKART = 'https://api.togkart-prod.geodataonline.no/api/fares/getongoing';
const GRAPH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const GRAPH_CACHE_SECONDS = 31 * 24 * 60 * 60;
const MAX_WORK_GRAPH_BYTES = 350 * 1024;
const GRAPH_PARSER_VERSION = 'v8';
const TRANSIENT_UPSTREAM_STATUSES = new Set([502, 503, 504]);
const SECTION_STATION_CODES = LOCATIONS.filter(location=>location.kind==='Stasjon').map(location=>location.code);
const SPLIT_GRAPH_LINES = new Set([7,23,24,25]);
const TOGKART_ARCHIVE_VERSION = 'v1';
const OSLO_DATE = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'});
const VALID_LOCATION_CODES = new Set(LOCATIONS.map(location=>location.code));
const MAX_QUERY_DATE_DISTANCE_DAYS = 31;
const COMMON_SECURITY_HEADERS = {
  'Strict-Transport-Security':'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'strict-origin-when-cross-origin',
  'Permissions-Policy':'camera=(), microphone=(), payment=(), usb=()',
};

function validCalendarDate(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date=new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10)===value;
}

function dateWithinQueryWindow(value, now=new Date()) {
  if(!validCalendarDate(value)) return false;
  const today=OSLO_DATE.format(now);
  const distance=Math.round((Date.parse(`${value}T12:00:00Z`)-Date.parse(`${today}T12:00:00Z`))/86400000);
  return Math.abs(distance)<=MAX_QUERY_DATE_DISTANCE_DAYS;
}

function validLocationCode(value) {
  return VALID_LOCATION_CODES.has(String(value || '').toUpperCase());
}

function secureResponse(response) {
  const headers=new Headers(response.headers);
  for(const [name,value] of Object.entries(COMMON_SECURITY_HEADERS)) headers.set(name,value);
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

function upstreamHeaders(response, cacheControl, source, fallbackType) {
  const headers=new Headers();
  headers.set('Content-Type',response.headers.get('Content-Type') || fallbackType);
  headers.set('Cache-Control',response.ok?cacheControl:'no-store');
  headers.set('X-Togoversikt-Upstream',source);
  for(const name of ['ETag','Last-Modified']) {
    const value=response.headers.get(name);
    if(value) headers.set(name,value);
  }
  return headers;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function notifyNtfy(env, title, message, dedupeKey='generic') {
  if(!env?.NTFY_TOPIC_URL) return false;
  const marker=`alert:v1:${dedupeKey}`;
  try {
    if(env.ROUTE_GRAPHS) {
      if(await env.ROUTE_GRAPHS.get(marker)) return false;
      await env.ROUTE_GRAPHS.put(marker,'1',{expirationTtl:15*60});
    }
    const headers={Title:title,Priority:'high',Tags:'warning,train'};
    if(env.NTFY_TOKEN) headers.Authorization=`Bearer ${env.NTFY_TOKEN}`;
    const response=await fetch(env.NTFY_TOPIC_URL,{method:'POST',headers,body:String(message).slice(0,3500),signal:AbortSignal.timeout(5000)});
    if(!response.ok) throw new Error(`ntfy svarte ${response.status}`);
    return true;
  } catch(error) {
    console.error(JSON.stringify({event:'ntfy_error',error:errorMessage(error)}));
    return false;
  }
}

async function enforceRateLimit(request, env) {
  if(!env?.EXPENSIVE_RATE_LIMITER) return null;
  const url=new URL(request.url);
  if(!['/api/daily-graphs','/api/pt'].includes(url.pathname)) return null;
  const actor=request.headers.get('CF-Connecting-IP') || 'anonymous';
  const {success}=await env.EXPENSIVE_RATE_LIMITER.limit({key:`${actor}:${url.pathname}`});
  return success?null:Response.json({detail:'For mange forespørsler. Prøv igjen om litt.'},{status:429,headers:{'Retry-After':'60'}});
}

function graphParts(line) {
  return Number(line)===6?12:SPLIT_GRAPH_LINES.has(Number(line))?2:1;
}

function addDateDays(date,days) {
  const value=new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate()+days);
  return value.toISOString().slice(0,10);
}

function copyParams(source, target, allowed) {
  for (const key of allowed) {
    for (const value of source.getAll(key)) target.append(key, value);
  }
}

async function fetchUpstream(url, options) {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(url, {...options,signal:options?.signal || AbortSignal.timeout(15000)});
    if (!TRANSIENT_UPSTREAM_STATUSES.has(response.status) || attempt === 1) return response;
    await response.body?.cancel();
  }
  return response;
}

async function proxyXml(request, upstreamBase, allowed, ttl) {
  const incoming = new URL(request.url);
  const upstream = new URL(upstreamBase);
  copyParams(incoming.searchParams, upstream.searchParams, allowed);
  const response = await fetchUpstream(upstream.toString(), {
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '300-599': 0 } },
    headers: { 'User-Agent': 'Togoversikt.no/1.0' },
  });
  const headers=upstreamHeaders(response,`public, max-age=${ttl}`,'Bane NOR SIRI','application/xml; charset=utf-8');
  return new Response(response.body, { status: response.status, headers });
}

function validateStopMonitoring(request) {
  const params=new URL(request.url).searchParams;
  const locationCode=String(params.get('MonitoringRef') || '').toUpperCase();
  if(!validLocationCode(locationCode)) return 'Ugyldig MonitoringRef';
  const maximum=Number(params.get('MaximumStopVisits') || 2000);
  if(!Number.isInteger(maximum) || maximum<1 || maximum>2000) return 'Ugyldig MaximumStopVisits';
  const preview=params.get('PreviewInterval') || '';
  const match=preview.match(/^PT(\d{1,4})M$/);
  if(!match || Number(match[1])<1 || Number(match[1])>2880) return 'Ugyldig PreviewInterval';
  const start=params.get('StartTime');
  if(start && (!Number.isFinite(Date.parse(start)) || !dateWithinQueryWindow(start.slice(0,10)))) return 'Ugyldig StartTime';
  for(const key of ['OperatorRef','DestinationRef']) {
    const value=params.get(key);
    if(value && !/^[A-ZÆØÅ0-9:_-]{1,40}$/u.test(value)) return `Ugyldig ${key}`;
  }
  return null;
}

async function proxyProductionTimetable(request, ctx) {
  const incoming=new URL(request.url), locationCode=String(incoming.searchParams.get('StopPointRef') || '').toUpperCase();
  const fullJourney=incoming.searchParams.get('IncludeFullJourney')==='true';
  if(!validLocationCode(locationCode)) return Response.json({detail:'Mangler gyldig stedskode'},{status:400});
  const start=incoming.searchParams.get('ValidityPeriod.StartTime'), end=incoming.searchParams.get('ValidityPeriod.EndTime');
  const startMs=Date.parse(start || ''), endMs=Date.parse(end || '');
  if(!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs<=startMs || endMs-startMs>72*60*60*1000) {
    return Response.json({detail:'Ugyldig eller for lang gyldighetsperiode'},{status:400});
  }
  if(!dateWithinQueryWindow(String(start).slice(0,10)) || !dateWithinQueryWindow(String(end).slice(0,10))) {
    return Response.json({detail:'Gyldighetsperioden er utenfor tillatt datointervall'},{status:400});
  }
  const rawTrainNumbers=(incoming.searchParams.get('TrainNumbers') || '').split(',').map(value=>value.trim()).filter(Boolean);
  if(rawTrainNumbers.length>500 || rawTrainNumbers.some(value=>!/^\d{1,6}$/.test(value))) {
    return Response.json({detail:'Ugyldige tognumre'},{status:400});
  }
  const trainNumbers=[...new Set(rawTrainNumbers)];
  const cache=typeof caches!=='undefined' ? caches.default : null;
  const cached=cache ? await cache.match(request) : null;
  if(cached) return cached;
  const upstream=new URL(`${SIRI}/pt/production-timetable.xml`);
  copyParams(incoming.searchParams,upstream.searchParams,['ValidityPeriod.StartTime','ValidityPeriod.EndTime']);
  const response=await fetchUpstream(upstream.toString(),{
    cf:{cacheEverything:true,cacheTtl:600},headers:{'User-Agent':'Togoversikt.no/1.0'}
  });
  const xml=await response.text();
  const result=new Response(response.ok?filterProductionTimetableXml(xml,locationCode,trainNumbers,!fullJourney):xml,{
    status:response.status,headers:upstreamHeaders(response,'public, max-age=600','Bane NOR SIRI PT','application/xml; charset=utf-8')
  });
  if(cache && response.ok) {
    const stored=cache.put(request,result.clone());
    if(ctx?.waitUntil) ctx.waitUntil(stored); else await stored;
  }
  return result;
}

async function proxyEstimatedTimetable(request, ctx) {
  const incoming=new URL(request.url), locationCode=String(incoming.searchParams.get('StopPointRef') || '').toUpperCase();
  if(locationCode && !validLocationCode(locationCode)) return Response.json({detail:'Ugyldig stedskode'},{status:400});
  const cache=typeof caches!=='undefined' ? caches.default : null;
  const cached=cache ? await cache.match(request) : null;
  if(cached) return cached;
  const upstream=new URL(`${SIRI}/et/EstimatedTimetable.xml`);
  copyParams(incoming.searchParams,upstream.searchParams,[
    'PreviewInterval','OperatorRef','ServiceFeatureRef',
    'Lines.LineDirection.LineRef','Lines.LineDirection.DirectionRef',
  ]);
  const response=await fetchUpstream(upstream.toString(),{
    cf:{cacheEverything:true,cacheTtlByStatus:{'200-299':30,'300-599':0}},headers:{'User-Agent':'Togoversikt.no/1.0'}
  });
  const xml=await response.text();
  const result=new Response(response.ok && locationCode?filterEstimatedTimetableXml(xml,locationCode):xml,{
    status:response.status,headers:upstreamHeaders(response,'public, max-age=30','Bane NOR SIRI ET','application/xml; charset=utf-8')
  });
  if(cache && response.ok) {
    const stored=cache.put(request,result.clone());
    if(ctx?.waitUntil) ctx.waitUntil(stored); else await stored;
  }
  return result;
}


async function proxyTogkart(request) {
  const incoming=new URL(request.url);
  const locationCode=String(incoming.searchParams.get('location') || '').toUpperCase();
  if(!validLocationCode(locationCode)) return Response.json({detail:'Mangler gyldig stedskode'},{status:400});
  const upstream = new URL(TOGKART);
  const bucket = Math.floor(Date.now() / 30000) * 30 + 60;
  upstream.searchParams.set('timestamp', String(bucket));
  const response = await fetchUpstream(upstream.toString(), {
    cf: { cacheEverything: true, cacheTtl: 20 },
    headers: { 'User-Agent': 'Togoversikt.no/1.0' },
  });
  if(!response.ok) {
    return new Response(response.body,{status:response.status,headers:upstreamHeaders(response,'public, max-age=20','Bane NOR Togkart','application/json; charset=utf-8')});
  }
  const payload=await response.json();
  payload.Fares=(payload?.Fares || []).filter(fare=>fare?.origin===locationCode || fare?.destination===locationCode ||
    (fare?.stops || []).some(stop=>stop?.city===locationCode));
  return Response.json(payload,{headers:{'Cache-Control':'public, max-age=20','X-Togoversikt-Upstream':'Bane NOR Togkart'}});
}

function archiveKey(date) {
  return `togkart-archive:${TOGKART_ARCHIVE_VERSION}:${date}`;
}

function retentionExpiration(date) {
  return Math.floor((Date.parse(`${date}T00:00:00Z`)+(31*24*60*60*1000))/1000);
}

function storedDateFromKey(name) {
  const match=String(name).match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] && validCalendarDate(match[1])?match[1]:null;
}

export async function maintainKvRetention(store, now=new Date()) {
  if(!store || typeof store.list!=='function') return {scanned:0,deleted:0,migrated:0};
  let scanned=0, deleted=0, migrated=0;
  for(const prefix of ['daily-graph:','togkart-archive:']) {
    let cursor;
    do {
      const page=await store.list({prefix,cursor,limit:1000});
      for(const item of page.keys || []) {
        scanned++;
        const date=storedDateFromKey(item.name);
        const obsoleteParser=prefix==='daily-graph:' && !item.name.startsWith(`daily-graph:${GRAPH_PARSER_VERSION}:`);
        const expiration=date?retentionExpiration(date):0;
        if(obsoleteParser || !date || expiration*1000<=now.getTime()) {
          await store.delete(item.name);
          deleted++;
        } else if(!item.expiration) {
          const value=await store.get(item.name);
          if(value!=null) {
            await store.put(item.name,value,{expiration});
            migrated++;
          }
        }
      }
      cursor=page.list_complete?undefined:page.cursor;
    } while(cursor);
  }
  return {scanned,deleted,migrated};
}

function osloDateFromEpoch(value) {
  const date=new Date(Number(value)*1000);
  return Number.isNaN(date.getTime())?null:OSLO_DATE.format(date);
}

function fareTouchesDate(fare,date) {
  return (fare?.stops || []).some(stop=>['sta','std','eta','etd','ata','atd']
    .some(field=>osloDateFromEpoch(stop?.[field])===date));
}

function fareResolved(fare) {
  const stops=fare?.stops || [], last=stops.at(-1);
  if(!last) return false;
  const cancelled=last.cancel && String(last.cancel).toUpperCase()!=='N';
  return Boolean(last.ata || cancelled || (Number.isInteger(Number(fare.stopindex)) && Number(fare.stopindex)>=stops.length-1));
}

function compactFare(fare) {
  const fields=['train_no','train_id','origin','destination','stopindex','line_no','company','company_name','train_type','train_kind'];
  const compact=Object.fromEntries(fields.filter(field=>fare?.[field]!=null).map(field=>[field,fare[field]]));
  compact.stops=(fare?.stops || []).map(stop=>{
    const stopFields=['city','planned_track','track','cancel','sta','std','eta','etd','ata','atd','activity'];
    return Object.fromEntries(stopFields.filter(field=>stop?.[field]!=null).map(field=>[field,stop[field]]));
  });
  return compact;
}

export async function archiveTogkart(scheduledAt, store) {
  if(!store) return {dates:[],fares:0};
  const today=OSLO_DATE.format(scheduledAt), yesterday=addDateDays(today,-1);
  const upstream=new URL(TOGKART);
  upstream.searchParams.set('timestamp',String(Math.floor(scheduledAt.getTime()/30000)*30+60));
  const response=await fetchUpstream(upstream.toString(),{headers:{'User-Agent':'Togoversikt.no/1.0'}});
  if(!response.ok) throw new Error(`Togkart svarte ${response.status}`);
  const payload=await response.json(), incoming=(payload?.Fares || []).map(compactFare);
  const results=[];
  for(const date of [yesterday,today]) {
    const key=archiveKey(date), existing=await store.get(key,'json');
    if(existing?.complete) { results.push({date,complete:true,fares:existing.Fares?.length || 0}); continue; }
    const fares=new Map((existing?.Fares || []).map(fare=>[String(fare.train_id || `${fare.train_no}:${fare.origin_time || ''}`),fare]));
    for(const fare of incoming.filter(item=>fareTouchesDate(item,date))) {
      fares.set(String(fare.train_id || `${fare.train_no}:${fare.origin_time || ''}`),fare);
    }
    const merged=[...fares.values()], complete=date<today && merged.length>0 && merged.every(fareResolved);
    const archive={date,Fares:merged,archived_at:scheduledAt.toISOString(),complete};
    await store.put(key,JSON.stringify(archive),{expiration:retentionExpiration(date)});
    results.push({date,complete,fares:merged.length});
  }
  return {dates:results,fares:incoming.length};
}

async function togkartArchive(request, store) {
  const date=new URL(request.url).searchParams.get('date') || '';
  if(!validCalendarDate(date)) return Response.json({detail:'Ugyldig dato'},{status:400});
  const archive=store ? await store.get(archiveKey(date),'json') : null;
  if(!archive) return Response.json({detail:'Ingen arkiverte sanntidsdata for datoen'},{status:404});
  return Response.json(archive,{headers:{'Cache-Control':archive.complete?'public, max-age=86400':'public, max-age=60'}});
}

async function graphContentHash(data) {
  const digest=await crypto.subtle.digest('SHA-256',data);
  return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}

async function storeGraphResult(cache, cacheKey, store, storeKey, data, ctx, persist=false) {
  if(cache) {
    const response=Response.json(data,{headers:{'Cache-Control':`public, max-age=${GRAPH_CACHE_SECONDS}`}});
    const pending=cache.put(cacheKey,response);
    if(ctx?.waitUntil) ctx.waitUntil(pending); else await pending;
  }
  if(persist && store) await store.put(storeKey,JSON.stringify(data),{expiration:retentionExpiration(data.date)});
}

async function dailyGraphLine(date, line, ctx, store, part=1, parts=1, forceCheck=false) {
  const cache=typeof caches!=='undefined' ? caches.default : null;
  const partKey=parts>1?`:${part}-of-${parts}`:'';
  const cacheKey=new Request(`https://togoversikt.no/__cache/daily-graphs/${GRAPH_PARSER_VERSION}/${date}/${line}${partKey}`);
  const storeKey=`daily-graph:${GRAPH_PARSER_VERSION}:${date}:${line}${partKey}`;
  const cachedResponse=cache ? await cache.match(cacheKey) : null;
  let cached=cachedResponse ? await cachedResponse.json() : null;
  if(!cached && store) {
    cached=await store.get(storeKey,'json');
    if(cached) await storeGraphResult(cache,cacheKey,null,storeKey,cached,ctx);
  }
  const checkedAt=Date.parse(cached?.checked_at || '');
  if(!forceCheck && cached && Array.isArray(cached.possible_work_trains) && Array.isArray(cached.operational_sections) && Number.isFinite(checkedAt) && Date.now()-checkedAt<GRAPH_CHECK_INTERVAL_MS) return cached;

  if(cached && Array.isArray(cached.possible_work_trains) && Array.isArray(cached.operational_sections)) {
    try {
      const head=await fetch(graphUrl(date,line),{
        method:'HEAD',cf:{cacheEverything:true,cacheTtl:120},headers:{'User-Agent':'Togoversikt.no/1.0'},signal:AbortSignal.timeout(10000)
      });
      if(!head.ok) return cached;
      const remoteVersion=graphResponseVersion(head.headers);
      if(remoteVersion && remoteVersion===cached.remote_version) {
        const unchanged={...cached,checked_at:new Date().toISOString()};
        await storeGraphResult(cache,cacheKey,null,storeKey,unchanged,ctx);
        return unchanged;
      }
    } catch {
      return cached;
    }
  }

  const response=await fetch(graphUrl(date,line),{
    cf:{cacheEverything:true,cacheTtl:120},headers:{'User-Agent':'Togoversikt.no/1.0'},signal:AbortSignal.timeout(20000)
  });
  if(!response.ok || !String(response.headers.get('Content-Type') || '').includes('application/pdf')) throw new Error(`Rutegraf ${line} svarte ${response.status}`);
  const pdf=await response.arrayBuffer();
  const contentHash=await graphContentHash(pdf);
  const remoteVersion=graphResponseVersion(response.headers);
  // A few unusually large graph sheets exceed the Worker's memory budget when
  // PDF drawing operators are expanded. Keep ordinary graph confirmation for
  // those sheets, but never let them take down results from the other lines.
  const parseTrainPaths=pdf.byteLength<=MAX_WORK_GRAPH_BYTES || parts>=12;
  const graphData=await extractDailyGraphData(pdf,date,line,Object.keys(STATION_GRAPH_LINES),parseTrainPaths,part,parts,SECTION_STATION_CODES);
  if(cached?.content_hash===contentHash) {
    const unchanged={...cached,possible_work_trains:graphData.possible_work_trains,
      operational_markers:graphData.operational_markers,operational_sections:graphData.operational_sections,
      remote_version:remoteVersion || cached.remote_version,checked_at:new Date().toISOString()};
    await storeGraphResult(cache,cacheKey,store,storeKey,unchanged,ctx,true);
    return unchanged;
  }
  const now=new Date().toISOString();
  const data={date,line,numbers:[...new Set(graphData.numbers)],possible_work_trains:graphData.possible_work_trains,
    operational_markers:graphData.operational_markers,operational_sections:graphData.operational_sections,
    source_time:now,checked_at:now,
    remote_version:remoteVersion,content_hash:contentHash};
  await storeGraphResult(cache,cacheKey,store,storeKey,data,ctx,true);
  return data;
}

function graphLinesForLocation(locationCode) {
  const configured=STATION_GRAPH_LINES[locationCode];
  return configured?.length ? configured : Array.from({length:DAILY_GRAPH_COUNT},(_,index)=>index+1);
}

async function dailyGraphNumbers(date, locationCode, ctx, store, requestedLine=null, part=1, parts=1) {
  const configuredLines=graphLinesForLocation(locationCode);
  const lines=requestedLine==null ? configuredLines : configuredLines.includes(requestedLine) ? [requestedLine] : [];
  const results=new Array(lines.length);
  let cursor=0;
  const workers=Array.from({length:Math.min(2,lines.length)},async()=>{
    while(cursor<lines.length) {
      const index=cursor++;
      try { results[index]=await dailyGraphLine(date,lines[index],ctx,store,part,parts); } catch { results[index]=null; }
    }
  });
  await Promise.all(workers);
  const loaded=results.filter(Boolean);
  return {date,numbers:[...new Set(loaded.flatMap(result=>result.numbers))],
    possible_work_trains:loaded.flatMap(result=>result.possible_work_trains || []),graphs_loaded:loaded.length,
    operational_markers:loaded.flatMap(result=>result.operational_markers || []),
    operational_sections:loaded.flatMap(result=>result.operational_sections || []),
    graphs_expected:lines.length,source_time:loaded.map(result=>result.source_time).sort().at(-1) || null,
    checked_at:loaded.map(result=>result.checked_at).filter(Boolean).sort().at(-1) || null};
}

async function warmDailyGraphCache(date, ctx, store) {
  const tasks=Array.from({length:DAILY_GRAPH_COUNT},(_,index)=>index+1).flatMap(line=>{
    const parts=graphParts(line);
    return Array.from({length:parts},(_,index)=>({line,part:index+1,parts}));
  });
  let cursor=0, completed=0;
  const errors=[];
  const workers=Array.from({length:2},async()=>{
    while(cursor<tasks.length) {
      const task=tasks[cursor++];
      try {
        await dailyGraphLine(date,task.line,ctx,store,task.part,task.parts,true);
        completed++;
      } catch(error) {
        // Én utilgjengelig graf skal ikke stoppe oppvarmingen av de andre.
        errors.push({line:task.line,part:task.part,error:errorMessage(error)});
      }
    }
  });
  await Promise.all(workers);
  return {attempted:tasks.length,completed,errors};
}

async function dailyGraphMatches(request, ctx, store) {
  const url=new URL(request.url), date=url.searchParams.get('date') || '';
  if(!dateWithinQueryWindow(date)) return Response.json({detail:'Datoen må være gyldig og innenfor 31 dager'},{status:400});
  const candidates=(url.searchParams.get('trains') || '').split(',').map(x=>x.trim()).filter(x=>/^\d{1,6}$/.test(x)).slice(0,500);
  const locationCode=String(url.searchParams.get('location') || '').toUpperCase();
  if(!validLocationCode(locationCode)) return Response.json({detail:'Ugyldig stedskode'},{status:400});
  const rawLine=url.searchParams.get('line');
  const requestedLine=rawLine==null ? null : Number(rawLine);
  if(rawLine!=null && (!Number.isInteger(requestedLine) || requestedLine<1 || requestedLine>DAILY_GRAPH_COUNT || !graphLinesForLocation(locationCode).includes(requestedLine))) {
    return Response.json({detail:'Ugyldig rutegraflinje'},{status:400});
  }
  const parts=Number(url.searchParams.get('parts') || 1), part=Number(url.searchParams.get('part') || 1);
  if(!Number.isInteger(parts) || parts<1 || parts>16 || !Number.isInteger(part) || part<1 || part>parts) {
    return Response.json({detail:'Ugyldig grafdel'},{status:400});
  }
  const data=await dailyGraphNumbers(date,locationCode,ctx,store,requestedLine,part,parts);
  const possibleAtLocation=data.possible_work_trains.filter(train=>train.route.some(stop=>stop.code===locationCode));
  const possibleWorkTrains=[...possibleAtLocation.reduce((deduped,train)=>{
    const stop=train.route.find(item=>item.code===locationCode);
    const key=`${train.train_no}:${stop?.time || ''}`;
    const previous=deduped.get(key);
    if(!previous || train.route.length>previous.route.length) deduped.set(key,train);
    return deduped;
  },new Map()).values()];
  const operationalSections=data.operational_sections.filter(section=>(section.section_codes || []).includes(locationCode));
  const operationalTrainKeys=new Set(operationalSections.map(section=>`${section.line_number}:${section.train_no}`));
  const operationalMarkers=data.operational_markers.filter(marker=>operationalTrainKeys.has(`${marker.line_number}:${marker.train_no}`));
  return Response.json({date,trains:matchCandidateTrainNumbers(candidates,data.numbers),graphs_loaded:data.graphs_loaded,
    graphs_expected:data.graphs_expected,source_time:data.source_time,possible_work_trains:possibleWorkTrains,
    checked_at:data.checked_at,operational_markers:operationalMarkers,operational_sections:operationalSections},{
    headers:{'Cache-Control':'public, max-age=300'}
  });
}

function dailyGraphLines(request) {
  const url=new URL(request.url);
  const locationCode=String(url.searchParams.get('location') || '').toUpperCase();
  if(!validLocationCode(locationCode)) return Response.json({detail:'Ugyldig stedskode'},{status:400});
  const lines=STATION_GRAPH_LINES[locationCode] || [];
  const routeCodes=[...new Set((url.searchParams.get('route') || '').split(',').map(code=>code.trim().toUpperCase())
    .filter(code=>/^[A-ZÆØÅ0-9]{1,8}$/u.test(code)).slice(0,150))];
  if(routeCodes.length) {
    const scored=lines.map(line=>({line,score:routeCodes.filter(code=>code!==locationCode && (STATION_GRAPH_LINES[code] || []).includes(line)).length}));
    const best=Math.max(0,...scored.map(item=>item.score));
    const matchedLines=best>0?scored.filter(item=>item.score===best).map(item=>item.line):lines;
    return Response.json({location:locationCode,lines,matched_lines:matchedLines},
      {headers:{'Cache-Control':'public, max-age=86400'}});
  }
  return Response.json({location:locationCode,lines},
    {headers:{'Cache-Control':'public, max-age=86400'}});
}

async function proxyNearest(request) {
  const incoming = new URL(request.url);
  const upstream = new URL(ENTUR);
  const rawLat=incoming.searchParams.get('lat'), rawLon=incoming.searchParams.get('lon');
  const lat=Number(rawLat), lon=Number(rawLon);
  if(rawLat==null || rawLat.trim()==='' || rawLon==null || rawLon.trim()==='' ||
    !Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return Response.json({detail:'Ugyldig posisjon'},{status:400});
  }
  upstream.searchParams.set('point.lat', String(lat));
  upstream.searchParams.set('point.lon', String(lon));
  upstream.searchParams.set('size', '100');
  upstream.searchParams.set('lang', 'no');
  upstream.searchParams.set('layers', 'venue');
  upstream.searchParams.set('categories', 'railStation');
  upstream.searchParams.set('boundary.country', 'NOR');
  upstream.searchParams.set('boundary.circle.radius', '20000');
  const response = await fetchUpstream(upstream.toString(), {
    headers: { 'ET-Client-Name': 'johnas-togoversikt' },
    cf: { cacheTtl: 60 },
  });
  const headers=upstreamHeaders(response,'private, max-age=60','Entur Geocoder','application/json; charset=utf-8');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if(request.url.length>4096) return secureResponse(Response.json({detail:'For lang forespørsel'},{status:414}));
      if (!['GET','HEAD'].includes(request.method) && url.pathname.startsWith('/api/')) {
        return secureResponse(new Response('Method Not Allowed',{status:405,headers:{Allow:'GET, HEAD'}}));
      }
      const limited=await enforceRateLimit(request,env);
      if(limited) return secureResponse(limited);
      let response;
      if (url.pathname === '/api/sm') {
        const validationError=validateStopMonitoring(request);
        response=validationError?Response.json({detail:validationError},{status:400}):
          await proxyXml(request, `${SIRI}/sm/stop-monitoring.xml`, [
            'MonitoringRef', 'StartTime', 'PreviewInterval', 'MaximumStopVisits',
            'OperatorRef', 'DestinationRef',
          ], 30);
      } else if (url.pathname === '/api/et') response=await proxyEstimatedTimetable(request,ctx);
      else if (url.pathname === '/api/pt') response=await proxyProductionTimetable(request,ctx);
      else if (url.pathname === '/api/togkart') response=await proxyTogkart(request);
      else if (url.pathname === '/api/togkart-archive') response=await togkartArchive(request,env.ROUTE_GRAPHS);
      else if (url.pathname === '/api/daily-graphs') response=await dailyGraphMatches(request,ctx,env.ROUTE_GRAPHS);
      else if (url.pathname === '/api/daily-graph-lines') response=dailyGraphLines(request);
      else if (url.pathname === '/api/nearest') response=await proxyNearest(request);
      else if (url.pathname === '/health') {
        response=Response.json({status:'ok',mode:'Cloudflare Worker proxy',time:new Date().toISOString(),
          version:env.CF_VERSION_METADATA?.id || null,notifications:Boolean(env.NTFY_TOPIC_URL)},
          {headers:{'Cache-Control':'no-store'}});
      } else return env.ASSETS.fetch(request);
      return secureResponse(response);
    } catch(error) {
      const message=errorMessage(error);
      console.error(JSON.stringify({event:'request_error',path:url.pathname,error:message}));
      ctx?.waitUntil?.(notifyNtfy(env,'Togoversikt: API-feil',`${url.pathname}: ${message}`,`request:${url.pathname}:${message}`));
      return secureResponse(Response.json({detail:'Tjenesten kunne ikke hente togdata akkurat nå.'},{status:502,headers:{'Cache-Control':'no-store'}}));
    }
  },
  async scheduled(controller, env, ctx) {
    const scheduledAt=Number.isFinite(controller?.scheduledTime)?new Date(controller.scheduledTime):new Date();
    const date=OSLO_DATE.format(scheduledAt);
    ctx.waitUntil((async()=>{
      const graphResults=[await warmDailyGraphCache(date,ctx,env.ROUTE_GRAPHS)];
      // Neste dags grafer kontrolleres hver hele time, slik at innstillinger er
      // klare før noen åpner oversikten. Dagens grafer kontrolleres hvert kvarter.
      if(scheduledAt.getUTCMinutes()===0) graphResults.push(await warmDailyGraphCache(addDateDays(date,1),ctx,env.ROUTE_GRAPHS));
      let archiveError=null;
      try { await archiveTogkart(scheduledAt,env.ROUTE_GRAPHS); }
      catch(error) { archiveError=errorMessage(error); }
      let retentionError=null, retention=null;
      if(scheduledAt.getUTCMinutes()===0) {
        try { retention=await maintainKvRetention(env.ROUTE_GRAPHS,scheduledAt); }
        catch(error) { retentionError=errorMessage(error); }
      }
      const graphErrors=graphResults.flatMap(result=>result.errors || []);
      console.log(JSON.stringify({event:'scheduled_complete',date,
        graphs_attempted:graphResults.reduce((sum,result)=>sum+result.attempted,0),
        graphs_completed:graphResults.reduce((sum,result)=>sum+result.completed,0),
        graph_errors:graphErrors.length,archive_error:archiveError,retention,retention_error:retentionError}));
      if(graphErrors.length || archiveError || retentionError) {
        const details=[graphErrors.length?`${graphErrors.length} rutegrafer feilet`:null,
          archiveError?`Togkart-arkiv: ${archiveError}`:null,
          retentionError?`KV-retention: ${retentionError}`:null].filter(Boolean).join('\n');
        await notifyNtfy(env,'Togoversikt: cron-feil',details,`cron:${date}:${graphErrors.length}:${archiveError || 'ok'}`);
      }
    })().catch(async error=>{
      const message=errorMessage(error);
      console.error(JSON.stringify({event:'scheduled_error',date,error:message}));
      await notifyNtfy(env,'Togoversikt: alvorlig cron-feil',message,`cron-fatal:${date}:${message}`);
    }));
  },
};
