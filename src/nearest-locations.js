import LOCATIONS from '../public/locations.json' with { type: 'json' };
import COORDINATES from './location-coordinates.json' with { type: 'json' };

export function distanceMetres(lat, lon, otherLat, otherLon) {
  const radians=Math.PI/180;
  const a=Math.sin((otherLat-lat)*radians/2)**2 +
    Math.cos(lat*radians)*Math.cos(otherLat*radians)*Math.sin((otherLon-lon)*radians/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,a)));
}

const nameKey=value=>String(value || '').trim().toLocaleLowerCase('no')
  .replace(/\s+(stasjon|holdeplass)$/u,'').replace(/\s+/g,' ');
const locationsByName=new Map(LOCATIONS.map(location=>[nameKey(location.name),location]));

export function nearestFeatures(lat, lon, upstreamFeatures=[]) {
  const candidates=new Map();
  function add(location, latitude, longitude) {
    if(!location || !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude)>90 || Math.abs(longitude)>180) return;
    const distance=distanceMetres(lat,lon,latitude,longitude);
    if(distance>200000) return;
    // Keep the local railway coordinates when Entur also knows this place.
    if(candidates.has(location.code)) return;
    candidates.set(location.code,{
      type:'Feature',geometry:{type:'Point',coordinates:[longitude,latitude]},
      properties:{name:location.name,code:location.code,kind:location.kind,distance},
    });
  }
  for(const location of LOCATIONS) {
    const coordinates=COORDINATES[location.code];
    if(coordinates) add(location,...coordinates);
  }
  for(const feature of upstreamFeatures) {
    const coordinates=feature?.geometry?.coordinates;
    if(feature?.geometry?.type!=='Point' || !Array.isArray(coordinates)) continue;
    add(locationsByName.get(nameKey(feature?.properties?.name)),coordinates[1],coordinates[0]);
  }
  return [...candidates.values()].sort((a,b)=>a.properties.distance-b.properties.distance ||
    a.properties.code.localeCompare(b.properties.code,'no')).slice(0,100);
}
