import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres, nearestFeatures } from '../src/nearest-locations.js';
import COORDINATES from '../src/location-coordinates.json' with { type:'json' };
import BLOCKPOSTS from '../src/blockpost-chainages.json' with { type:'json' };
import LOCATIONS from '../public/locations.json' with { type:'json' };
import worker from '../src/index.js';
import { nearestLocation } from '../frontend/data.js';

const frogner={type:'Feature',properties:{name:'Frogner stasjon'},geometry:{type:'Point',coordinates:[11.10384,60.02327]}};

test('selects Melvoll near MVB instead of Entur’s Frogner passenger station',()=>{
  for(const [lat,lon] of [[60.0206,11.1191],[60.021,11.119],[60.0202,11.119]]) {
    const features=nearestFeatures(lat,lon,[frogner]);
    assert.equal(features[0].properties.code,'MVB');
    assert.equal(features[0].properties.kind,'Blokkpost');
    assert.ok(features.find(feature=>feature.properties.code==='FRO'));
  }
});

test('still selects Frogner when the user is at Frogner station',()=>{
  assert.equal(nearestFeatures(60.02327,11.10384,[frogner])[0].properties.code,'FRO');
});

test('includes every mapped block post and keeps station codes consistent',()=>{
  assert.ok(Object.keys(BLOCKPOSTS).length>=100);
  for(const [code,coordinates] of Object.entries(COORDINATES)) {
    assert.ok(LOCATIONS.some(location=>location.code===code),code);
    assert.ok(coordinates.every(Number.isFinite),code);
  }
  for(const code of Object.keys(BLOCKPOSTS)) {
    assert.equal(nearestFeatures(...COORDINATES[code])[0].properties.code,code);
  }
});

test('uses exact Entur names and geographic distance rather than fuzzy search or result order',()=>{
  const unknown={...frogner,properties:{name:'Frogner ukjent sted'}};
  const valid={...frogner,properties:{name:'Frogner stasjon'}};
  const features=nearestFeatures(60.0206,11.1191,[unknown,valid]);
  assert.equal(features[0].properties.code,'MVB');
  assert.equal(features.filter(feature=>feature.properties.code==='FRO').length,1);
  assert.ok(features.every((feature,index)=>index===0 || features[index-1].properties.distance<=feature.properties.distance));
  assert.deepEqual(nearestFeatures(0,0),[]);
  assert.ok(Math.abs(distanceMetres(60,11,60.001,11)-111.2)<.1);
});

test('nearest API returns MVB even when Entur only returns Frogner or is unavailable',async()=>{
  const original=globalThis.fetch;
  try {
    for(const status of [200,503]) {
      globalThis.fetch=async()=>Response.json({features:[frogner]},{status});
      const response=await worker.fetch(new Request('https://togoversikt.no/api/nearest?lat=60.0206&lon=11.1191'),{},{});
      assert.equal(response.status,200);
      assert.equal((await response.json()).features[0].properties.code,'MVB');
    }
  } finally {globalThis.fetch=original;}
});

test('frontend resolves the API station code without fuzzy name matching',async()=>{
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async url=>String(url)==='/locations.json' ? Response.json(LOCATIONS) :
      Response.json({features:nearestFeatures(60.0206,11.1191,[frogner])});
    const location=await nearestLocation(60.0206,11.1191);
    assert.equal(location.code,'MVB');
    assert.equal(location.name,'Melvoll Bp.');
  } finally {globalThis.fetch=original;}
});
