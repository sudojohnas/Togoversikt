import { DAILY_GRAPH_COUNT, extractDailyGraphData, graphResponseVersion, graphUrl, matchCandidateTrainNumbers } from './daily-graphs.js';
import STATION_GRAPH_LINES from './station-graph-map.json' with { type: 'json' };
import LOCATIONS from '../public/locations.json' with { type: 'json' };
import { filterProductionTimetableXml } from './pt-filter.js';

const SIRI = 'https://siri.banenor.no/jbv';
const ENTUR = 'https://api.entur.io/geocoder/v1/reverse';
const TOGKART = 'https://api.togkart-prod.geodataonline.no/api/fares/getongoing';
const GRAPH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const GRAPH_CACHE_SECONDS = 31 * 24 * 60 * 60;
const MAX_WORK_GRAPH_BYTES = 350 * 1024;
const GRAPH_PARSER_VERSION = 'v5';
const TRANSIENT_UPSTREAM_STATUSES = new Set([502, 503, 504]);
const SECTION_STATION_CODES = LOCATIONS.filter(location=>location.kind==='Stasjon').map(location=>location.code);

function copyParams(source, target, allowed) {
  for (const key of allowed) {
    for (const value of source.getAll(key)) target.append(key, value);
  }
}

async function fetchUpstream(url, options) {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(url, options);
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
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  headers.set('X-Togoversikt-Upstream', 'Bane NOR SIRI');
  return new Response(response.body, { status: response.status, headers });
}

async function proxyProductionTimetable(request, ctx) {
  const incoming=new URL(request.url), locationCode=String(incoming.searchParams.get('StopPointRef') || '').toUpperCase();
  if(!/^[A-ZÆØÅ0-9]{1,8}$/u.test(locationCode)) return Response.json({detail:'Mangler gyldig stedskode'},{status:400});
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
  const response=await fetch(upstream.toString(),{
    cf:{cacheEverything:true,cacheTtl:600},headers:{'User-Agent':'Togoversikt.no/1.0'}
  });
  const xml=await response.text();
  const result=new Response(response.ok?filterProductionTimetableXml(xml,locationCode,trainNumbers):xml,{
    status:response.status,headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'public, max-age=600','X-Togoversikt-Upstream':'Bane NOR SIRI PT'}
  });
  if(cache && response.ok) {
    const stored=cache.put(request,result.clone());
    if(ctx?.waitUntil) ctx.waitUntil(stored); else await stored;
  }
  return result;
}


async function proxyTogkart() {
  const upstream = new URL(TOGKART);
  const bucket = Math.floor(Date.now() / 30000) * 30 + 60;
  upstream.searchParams.set('timestamp', String(bucket));
  const response = await fetch(upstream.toString(), {
    cf: { cacheEverything: true, cacheTtl: 20 },
    headers: { 'User-Agent': 'Togoversikt.no/1.0' },
  });
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=20');
  headers.set('X-Togoversikt-Upstream', 'Bane NOR Togkart');
  return new Response(response.body, { status: response.status, headers });
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
  if(persist && store) await store.put(storeKey,JSON.stringify(data));
}

async function dailyGraphLine(date, line, ctx, store, part=1, parts=1) {
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
  if(!cached && parts>1) {
    const completeCacheKey=new Request(`https://togoversikt.no/__cache/daily-graphs/${GRAPH_PARSER_VERSION}/${date}/${line}`);
    const completeResponse=cache ? await cache.match(completeCacheKey) : null;
    cached=completeResponse ? await completeResponse.json() : null;
    if(!cached && store) cached=await store.get(`daily-graph:${GRAPH_PARSER_VERSION}:${date}:${line}`,'json');
  }
  const checkedAt=Date.parse(cached?.checked_at || '');
  if(cached && Array.isArray(cached.possible_work_trains) && Array.isArray(cached.operational_sections) && Number.isFinite(checkedAt) && Date.now()-checkedAt<GRAPH_CHECK_INTERVAL_MS) return cached;

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
    graphs_expected:lines.length,source_time:loaded.map(result=>result.source_time).sort().at(-1) || null};
}

async function dailyGraphMatches(request, ctx, store) {
  const url=new URL(request.url), date=url.searchParams.get('date') || '';
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({detail:'Ugyldig dato'},{status:400});
  const candidates=(url.searchParams.get('trains') || '').split(',').map(x=>x.trim()).filter(x=>/^\d{1,6}$/.test(x)).slice(0,500);
  const locationCode=String(url.searchParams.get('location') || '').toUpperCase();
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
  return Response.json({date,trains:matchCandidateTrainNumbers(candidates,data.numbers),graphs_loaded:data.graphs_loaded,
    graphs_expected:data.graphs_expected,source_time:data.source_time,possible_work_trains:possibleWorkTrains,
    operational_markers:data.operational_markers,operational_sections:data.operational_sections},{
    headers:{'Cache-Control':'public, max-age=300'}
  });
}

function dailyGraphLines(request) {
  const url=new URL(request.url);
  const locationCode=String(url.searchParams.get('location') || '').toUpperCase();
  return Response.json({location:locationCode,lines:STATION_GRAPH_LINES[locationCode] || []},
    {headers:{'Cache-Control':'public, max-age=86400'}});
}

async function proxyNearest(request) {
  const incoming = new URL(request.url);
  const upstream = new URL(ENTUR);
  for (const key of ['lat', 'lon']) {
    const value = incoming.searchParams.get(key);
    if (value == null) return Response.json({ detail: 'Mangler posisjon' }, { status: 400 });
  }
  upstream.searchParams.set('point.lat', incoming.searchParams.get('lat'));
  upstream.searchParams.set('point.lon', incoming.searchParams.get('lon'));
  upstream.searchParams.set('size', '100');
  upstream.searchParams.set('lang', 'no');
  upstream.searchParams.set('layers', 'venue');
  upstream.searchParams.set('categories', 'railStation');
  upstream.searchParams.set('boundary.country', 'NOR');
  upstream.searchParams.set('boundary.circle.radius', '20000');
  const response = await fetch(upstream.toString(), {
    headers: { 'ET-Client-Name': 'johnas-togoversikt' },
    cf: { cacheTtl: 60 },
  });
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, max-age=60');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && url.pathname.startsWith('/api/')) {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (url.pathname === '/api/sm') {
      return proxyXml(request, `${SIRI}/sm/stop-monitoring.xml`, [
        'MonitoringRef', 'StartTime', 'PreviewInterval', 'MaximumStopVisits',
        'OperatorRef', 'DestinationRef',
      ], 30);
    }
    if (url.pathname === '/api/et') {
      return proxyXml(request, `${SIRI}/et/EstimatedTimetable.xml`, [
        'PreviewInterval', 'OperatorRef', 'ServiceFeatureRef',
        'Lines.LineDirection.LineRef', 'Lines.LineDirection.DirectionRef',
      ], 30);
    }
    if (url.pathname === '/api/pt') {
      return proxyProductionTimetable(request,ctx);
    }
    if (url.pathname === '/api/togkart') return proxyTogkart();
    if (url.pathname === '/api/daily-graphs') return dailyGraphMatches(request,ctx,env.ROUTE_GRAPHS);
    if (url.pathname === '/api/daily-graph-lines') return dailyGraphLines(request);
    if (url.pathname === '/api/nearest') return proxyNearest(request);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', mode: 'Cloudflare Worker proxy', time: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    ctx.waitUntil(dailyGraphNumbers(date,'',ctx,env.ROUTE_GRAPHS));
  },
};
