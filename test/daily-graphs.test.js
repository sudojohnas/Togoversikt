import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDailyGraphData, graphPageLayout, graphResponseVersion, graphStrokeHints, graphUrl, matchCandidateTrainNumbers, matchGraphPathLabel } from '../src/daily-graphs.js';

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

test('exports a combined graph extractor for one-pass PDF processing', () => {
  assert.equal(typeof extractDailyGraphData,'function');
});

test('matches a station crossing to the nearby aligned train number', () => {
  const segment={a:{x:190,y:870},b:{x:200,y:895}};
  const label=matchGraphPathLabel({x:198,y:890},segment,[
    {train_no:'125',x:280,y:850,vx:3,vy:8},
    {train_no:'143',x:180,y:848,vx:3,vy:8},
    {train_no:'999',x:198,y:850,vx:8,vy:-3},
  ]);
  assert.equal(label?.train_no,'143');
});

test('does not attach an unrelated train number to a graph path', () => {
  const segment={a:{x:190,y:870},b:{x:200,y:895}};
  assert.equal(matchGraphPathLabel({x:198,y:890},segment,[
    {train_no:'999',x:600,y:200,vx:8,vy:-3},
  ]),null);
});

test('supports both portrait and landscape A3 graph coordinates', () => {
  assert.deepEqual(graphPageLayout([0,0,842,1191]),{
    width:842,height:1191,stationXMin:782,hourYMin:1111,hourXMin:100,hourXMax:752,
  });
  assert.deepEqual(graphPageLayout([0,0,1191,842]),{
    width:1191,height:842,stationXMin:1131,hourYMin:762,hourXMin:100,hourXMax:1101,
  });
});

test('treats yellow and light-brown graph paths as cancelled', () => {
  assert.deepEqual(graphStrokeHints('#fed349','102'),{work_hint:false,cancelled_hint:true});
  assert.equal(graphStrokeHints('#ffff00','102').cancelled_hint,true);
  assert.equal(graphStrokeHints('#ffa54f','102').cancelled_hint,true);
  assert.equal(graphStrokeHints('#ffaa00','102').cancelled_hint,true);
  assert.equal(graphStrokeHints('#aa5500','102').cancelled_hint,false);
  assert.deepEqual(graphStrokeHints('#0000ff','54702'),{work_hint:true,cancelled_hint:false});
});
