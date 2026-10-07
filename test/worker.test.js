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
});
