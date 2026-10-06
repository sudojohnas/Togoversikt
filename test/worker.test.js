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
