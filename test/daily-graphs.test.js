import test from 'node:test';
import assert from 'node:assert/strict';
import { graphUrl, matchCandidateTrainNumbers } from '../src/daily-graphs.js';

test('builds the public Bane NOR daily graph URL', () => {
  const url=new URL(graphUrl('2026-09-28',11));
  assert.equal(url.searchParams.get('dateInput'),'2026-09-28');
  assert.equal(url.searchParams.get('selectLine'),'11');
});

test('returns only planned trains found in daily graphs', () => {
  assert.deepEqual(matchCandidateTrainNumbers(['5749','85702','99999'],['5749','85702','2382']),['5749','85702']);
});
