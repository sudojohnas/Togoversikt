import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { archiveTogkart, maintainKvRetention } from '../src/index.js';

test('retries a transient SIRI 503 once', async () => {
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async ()=>{
    calls++;
    return calls===1
      ? new Response('utilgjengelig',{status:503})
      : new Response('<Siri/>',{status:200,headers:{'Content-Type':'application/xml'}});
  };
  try {
    const response=await worker.fetch(new Request('https://togoversikt.no/api/et'),{},{});
    assert.equal(response.status,200);
    assert.equal(calls,2);
    assert.equal(await response.text(),'<Siri/>');
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('returns the configured graph lines without parsing PDFs', async () => {
  const response=await worker.fetch(new Request('https://togoversikt.no/api/daily-graph-lines?location=OSL'),{},{});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{location:'OSL',lines:[1,3,6,7,21,23,24,25]});
  const skotterud=await worker.fetch(new Request('https://togoversikt.no/api/daily-graph-lines?location=SKO'),{},{});
  assert.deepEqual(await skotterud.json(),{location:'SKO',lines:[1]});
  const haldenTrain=await worker.fetch(new Request('https://togoversikt.no/api/daily-graph-lines?location=OSL&route=OSL,BG,HLD'),{},{});
  assert.deepEqual(await haldenTrain.json(),{
    location:'OSL',lines:[1,3,6,7,21,23,24,25],matched_lines:[24],
  });
  const bergenTrain=await worker.fetch(new Request('https://togoversikt.no/api/daily-graph-lines?location=OSL&route=OSL,DRM'),{},{});
  assert.deepEqual((await bergenTrain.json()).matched_lines,[6]);
  const gjovikTrain=await worker.fetch(new Request('https://togoversikt.no/api/daily-graph-lines?location=OSL&route=OSL,GJ%C3%98'),{},{});
  assert.deepEqual((await gjovikTrain.json()).matched_lines,[3]);
});

test('scheduled updates warm today every quarter and tomorrow every hour', async () => {
  const originalFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async (_url,options={})=>{
    calls.push(options.method || 'GET');
    return new Response(null,{status:200,headers:{ETag:'"same"'}});
  };
  const store={
    async get(){
      return {possible_work_trains:[],operational_sections:[],checked_at:'2026-10-08T01:59:59+02:00',remote_version:'etag:"same"'};
    },
    async put(){},
  };
  const pending=[];
  const ctx={waitUntil(promise){pending.push(promise);}};
  try {
    await worker.scheduled({scheduledTime:Date.parse('2026-10-08T02:00:00+02:00')},{ROUTE_GRAPHS:store},ctx);
    await Promise.all(pending);
    assert.equal(calls.filter(method=>method==='HEAD').length,80);
    assert.equal(calls.filter(method=>method==='GET').length,1);
    calls.length=0;
    pending.length=0;
    await worker.scheduled({scheduledTime:Date.parse('2026-10-08T02:15:00+02:00')},{ROUTE_GRAPHS:store},ctx);
    await Promise.all(pending);
    assert.equal(calls.filter(method=>method==='HEAD').length,40);
    assert.equal(calls.filter(method=>method==='GET').length,1);
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('archives yesterday until every observed train has reached its terminal', async () => {
  const originalFetch=globalThis.fetch;
  const values=new Map();
  const writeOptions=[];
  const store={
    async get(key,type){
      const value=values.get(key);
      return type==='json' && value ? JSON.parse(value) : value || null;
    },
    async put(key,value,options){ values.set(key,value); writeOptions.push(options); },
  };
  let arrived=false;
  globalThis.fetch=async ()=>Response.json({Fares:[{
    train_no:137,train_id:'137:2026-10-08',origin:'OSL',destination:'HLD',stopindex:arrived?1:0,
    stops:[
      {city:'OSL',std:Date.parse('2026-10-08T23:14:00+02:00')/1000,atd:Date.parse('2026-10-08T23:15:00+02:00')/1000},
      {city:'HLD',sta:Date.parse('2026-10-09T00:46:00+02:00')/1000,
        ...(arrived?{ata:Date.parse('2026-10-09T00:48:01+02:00')/1000}: {})},
    ],
  }]});
  try {
    let result=await archiveTogkart(new Date('2026-10-09T00:15:00+02:00'),store);
    assert.equal(result.dates.find(item=>item.date==='2026-10-08').complete,false);
    arrived=true;
    result=await archiveTogkart(new Date('2026-10-09T00:30:00+02:00'),store);
    assert.equal(result.dates.find(item=>item.date==='2026-10-08').complete,true);
    const response=await worker.fetch(new Request('https://togoversikt.no/api/togkart-archive?date=2026-10-08'),{ROUTE_GRAPHS:store},{});
    const archive=await response.json();
    assert.equal(response.status,200);
    assert.equal(archive.complete,true);
    assert.equal(archive.Fares[0].stops.at(-1).ata,Date.parse('2026-10-09T00:48:01+02:00')/1000);
    assert.ok(writeOptions.length>0);
    assert.ok(writeOptions.every(options=>Number.isInteger(options?.expiration)));
    assert.ok(writeOptions.every(options=>options.expiration>=Date.parse('2026-11-08T00:00:00Z')/1000));
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('rejects invalid expensive API input before contacting upstream', async () => {
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async ()=>{ calls++; throw new Error('skal ikke kalles'); };
  try {
    const graph=await worker.fetch(new Request('https://togoversikt.no/api/daily-graphs?date=2026-10-10&location=IKKEFINNES'),{},{});
    assert.equal(graph.status,400);
    const nearest=await worker.fetch(new Request('https://togoversikt.no/api/nearest?lat=abc&lon=999'),{},{});
    assert.equal(nearest.status,400);
    const pt=await worker.fetch(new Request('https://togoversikt.no/api/pt?StopPointRef=OSL'),{},{});
    assert.equal(pt.status,400);
    const sm=await worker.fetch(new Request('https://togoversikt.no/api/sm?MonitoringRef=OSL&PreviewInterval=PT9999M&MaximumStopVisits=9000'),{},{});
    assert.equal(sm.status,400);
    assert.equal(calls,0);
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('filters Togkart payload to the requested location', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async ()=>Response.json({Fares:[
    {train_no:1,origin:'OSL',destination:'HLD',stops:[{city:'OSL'},{city:'HLD'}]},
    {train_no:2,origin:'BGO',destination:'VOS',stops:[{city:'BGO'},{city:'VOS'}]},
  ]});
  try {
    const response=await worker.fetch(new Request('https://togoversikt.no/api/togkart?location=OSL'),{},{});
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).Fares.map(fare=>fare.train_no),[1]);
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('enforces the expensive endpoint rate limiter', async () => {
  const response=await worker.fetch(new Request('https://togoversikt.no/api/pt?StopPointRef=OSL'),{
    EXPENSIVE_RATE_LIMITER:{async limit(){ return {success:false}; }},
  },{});
  assert.equal(response.status,429);
  assert.equal(response.headers.get('retry-after'),'60');
});

test('reports unexpected API failures to ntfy without exposing the topic', async () => {
  const originalFetch=globalThis.fetch;
  const notifications=[];
  globalThis.fetch=async (url,options={})=>{
    if(String(url)==='https://ntfy.sh/test-topic') {
      notifications.push({title:options.headers.Title,body:options.body});
      return new Response('ok',{status:200});
    }
    throw new Error('oppstrøms nede');
  };
  const pending=[];
  const env={NTFY_TOPIC_URL:'https://ntfy.sh/test-topic',ROUTE_GRAPHS:{async get(){return null;},async put(){}}};
  try {
    const response=await worker.fetch(new Request('https://togoversikt.no/api/togkart?location=OSL'),env,{waitUntil(promise){pending.push(promise);}});
    await Promise.all(pending);
    assert.equal(response.status,502);
    assert.equal(notifications.length,1);
    assert.equal(notifications[0].title,'Togoversikt: API-feil');
    assert.match(notifications[0].body,/oppstrøms nede/);
  } finally {
    globalThis.fetch=originalFetch;
  }
});

test('health exposes deployment metadata and notification readiness', async () => {
  const response=await worker.fetch(new Request('https://togoversikt.no/health'),{
    CF_VERSION_METADATA:{id:'version-123'},NTFY_TOPIC_URL:'configured',
  },{});
  const data=await response.json();
  assert.equal(data.status,'ok');
  assert.equal(data.mode,'Cloudflare Worker proxy');
  assert.equal(data.version,'version-123');
  assert.equal(data.notifications,true);
  assert.ok(Number.isFinite(Date.parse(data.time)));
});

test('retention removes obsolete parser data and expires current data after 30 days', async () => {
  const values=new Map([
    ['daily-graph:v7:2026-10-10:1','old-parser'],
    ['daily-graph:v8:2026-10-10:1','current'],
    ['togkart-archive:v1:2026-08-01','expired'],
  ]);
  const expirations=new Map();
  const store={
    async list({prefix}) { return {keys:[...values.keys()].filter(name=>name.startsWith(prefix)).map(name=>({name})),list_complete:true}; },
    async get(key) { return values.get(key) ?? null; },
    async put(key,value,options) { values.set(key,value); expirations.set(key,options.expiration); },
    async delete(key) { values.delete(key); },
  };
  const result=await maintainKvRetention(store,new Date('2026-10-10T12:00:00Z'));
  assert.deepEqual(result,{scanned:3,deleted:2,migrated:1});
  assert.equal(values.has('daily-graph:v7:2026-10-10:1'),false);
  assert.equal(values.has('togkart-archive:v1:2026-08-01'),false);
  assert.equal(expirations.get('daily-graph:v8:2026-10-10:1'),Date.parse('2026-11-10T00:00:00Z')/1000);
});
