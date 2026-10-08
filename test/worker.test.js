import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { archiveTogkart } from '../src/index.js';

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
  const store={
    async get(key,type){
      const value=values.get(key);
      return type==='json' && value ? JSON.parse(value) : value || null;
    },
    async put(key,value){ values.set(key,value); },
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
  } finally {
    globalThis.fetch=originalFetch;
  }
});
