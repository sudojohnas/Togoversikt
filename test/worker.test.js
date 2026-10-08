import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

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
    assert.equal(calls.length,80);
    assert.ok(calls.every(method=>method==='HEAD'));
    calls.length=0;
    pending.length=0;
    await worker.scheduled({scheduledTime:Date.parse('2026-10-08T02:15:00+02:00')},{ROUTE_GRAPHS:store},ctx);
    await Promise.all(pending);
    assert.equal(calls.length,40);
  } finally {
    globalThis.fetch=originalFetch;
  }
});
