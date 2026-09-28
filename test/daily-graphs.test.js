import test from 'node:test';
import assert from 'node:assert/strict';
import { graphResponseVersion, graphUrl, matchCandidateTrainNumbers } from '../src/daily-graphs.js';

test('builds the public Bane NOR daily graph URL', () => {
  const url=new URL(graphUrl('2026-09-28',11));
  assert.equal(url.searchParams.get('dateInput'),'2026-09-28');
  assert.equal(url.searchParams.get('selectLine'),'11');
});

test('returns only planned trains found in daily graphs', () => {
  assert.deepEqual(matchCandidateTrainNumbers(['5749','85702','99999'],['5749','85702','2382']),['5749','85702']);
});

test('uses the Bane NOR PDF filename and size as a graph version', () => {
  const headers=new Headers({'Content-Disposition':'inline; filename=DG_172.pdf','Content-Length':'71224'});
  assert.equal(graphResponseVersion(headers),'file:DG_172.pdf|length:71224');
});

test('prefers a strong ETag when the graph source provides one', () => {
  const headers=new Headers({'ETag':'"graph-173"','Content-Disposition':'inline; filename=DG_173.pdf'});
  assert.equal(graphResponseVersion(headers),'etag:"graph-173"');
});
