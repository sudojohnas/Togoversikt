// Rebuild the checked-in WGS84 coordinates from Bane NOR's public Banekart.
// Optional first argument: a directory containing stations.json, km.json and tracks.json.
import { readFile, writeFile } from 'node:fs/promises';
import LOCATIONS from '../public/locations.json' with { type:'json' };
import BLOCKPOSTS from '../src/blockpost-chainages.json' with { type:'json' };
const site='https://banekart.banenor.no/Geocortex/Essentials/REST/sites/Innsynslsning_413_Prod/map';
async function json(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
  if(!response.ok) throw new Error(`Kartdata: HTTP ${response.status}`);
  const data=await response.json();
  if(data.error) throw new Error(data.error.message);
  return data;
}
async function sourceData() {
  if(process.argv[2]) {
    return Promise.all(['stations','km','tracks'].map(async name=>JSON.parse(await readFile(`${process.argv[2]}/${name}.json`,'utf8'))));
  }
  const service=(await json(`${site}?f=json`)).mapServices.find(item=>item.id==='43');
  const connection=Object.fromEntries(service.connectionString.split(';').map(item=>{
    const split=item.indexOf('='); return [item.slice(0,split),item.slice(split+1)];
  }));
  async function layer(number) {
    const features=[];
    for(;;) {
      const query=new URLSearchParams({f:'json',where:'1=1',outFields:'*',outSR:'4326',
        returnGeometry:'true',token:connection.token || '',resultOffset:String(features.length),resultRecordCount:'1000'});
      const data=await json(`${connection.url}/${number}/query?${query}`);
      if(!Array.isArray(data.features) || !data.features.length) throw new Error('Tomt kartlag');
      features.push(...data.features);
      if(!data.exceededTransferLimit) return features;
    }
  }
  return Promise.all([layer(3),layer(7),layer(13)]);
}
const [stations,kilometres,tracks]=await sourceData();
const normalName=name=>String(name).toLocaleLowerCase('no').replace(/[^a-zæøå0-9]/gu,'');
const output={};
for(const location of LOCATIONS) {
  if(location.kind==='Blokkpost') continue;
  const matches=stations.filter(station=>normalName(station.attributes.navn)===normalName(location.name));
  if(matches.length===1) output[location.code]=[matches[0].geometry.y,matches[0].geometry.x];
}
// Locate each kilometre marker on the track, then interpolate along that track.
// Straight interpolation between markers would cut across curves and tunnels.
const distance=(a,b)=>Math.hypot((b[0]-a[0])*Math.cos((a[1]+b[1])*Math.PI/360),b[1]-a[1])*111195;
function pathData(points) {
  const cumulative=[0];
  for(let i=1;i<points.length;i++) cumulative.push(cumulative[i-1]+distance(points[i-1],points[i]));
  function project(point) {
    let best={error:Infinity};
    const scale=Math.cos(point[1]*Math.PI/180);
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],dx=(b[0]-a[0])*scale,dy=b[1]-a[1];
      const denominator=dx*dx+dy*dy;
      const fraction=denominator ? Math.max(0,Math.min(1,((point[0]-a[0])*scale*dx+(point[1]-a[1])*dy)/denominator)) : 0;
      const candidate=[a[0]+fraction*(b[0]-a[0]),a[1]+fraction*(b[1]-a[1])];
      const error=distance(point,candidate);
      if(error<best.error) best={error,position:cumulative[i-1]+fraction*(cumulative[i]-cumulative[i-1])};
    }
    return best;
  }
  function at(position) {
    const i=cumulative.findIndex((value,index)=>index>0 && value>=position);
    if(i<0) return points.at(-1);
    const fraction=(position-cumulative[i-1])/(cumulative[i]-cumulative[i-1] || 1);
    return points[i-1].map((value,axis)=>value+fraction*(points[i][axis]-value));
  }
  return {project,at};
}
const paths=new Map();
for(const [code,blockpost] of Object.entries(BLOCKPOSTS)) {
  if(!LOCATIONS.some(location=>location.code===code)) throw new Error(`Ukjent stedskode: ${code}`);
  const markers=kilometres.filter(item=>item.attributes.banekortnavn===blockpost.track)
    .sort((a,b)=>a.attributes.sporkilometer-b.attributes.sporkilometer);
  const lower=markers.findLast(item=>item.attributes.sporkilometer<=blockpost.km);
  const upper=markers.find(item=>item.attributes.sporkilometer>=blockpost.km);
  if(!lower || !upper || upper.attributes.sporkilometer-lower.attributes.sporkilometer>1.1) throw new Error(`Mangler kilometerdata: ${code}`);
  if(!paths.has(blockpost.track)) paths.set(blockpost.track,tracks.filter(item=>item.attributes.banekortnavn===blockpost.track)
    .flatMap(item=>item.geometry.paths).map(pathData));
  const a=[lower.geometry.x,lower.geometry.y],b=[upper.geometry.x,upper.geometry.y];
  const candidates=paths.get(blockpost.track).map(path=>({path,a:path.project(a),b:path.project(b)}))
    .sort((left,right)=>left.a.error+left.b.error-right.a.error-right.b.error);
  const chosen=candidates[0];
  if(!chosen || chosen.a.error>150 || chosen.b.error>150) throw new Error(`Kilometerpunkt utenfor banen: ${code}`);
  const range=upper.attributes.sporkilometer-lower.attributes.sporkilometer;
  const fraction=range ? (blockpost.km-lower.attributes.sporkilometer)/range : 0;
  const [lon,lat]=chosen.path.at(chosen.a.position+fraction*(chosen.b.position-chosen.a.position));
  output[code]=[lat,lon];
}
if(!output.MVB || Object.keys(output).length<500) throw new Error('Ufullstendig koordinatgrunnlag');
const sorted=Object.fromEntries(Object.entries(output).sort(([a],[b])=>a.localeCompare(b,'no'))
  .map(([code,values])=>[code,values.map(value=>Number(value.toFixed(7)))]));
await writeFile('src/location-coordinates.json',`${JSON.stringify(sorted,null,2)}\n`);
console.log(`Lagret ${Object.keys(output).length} jernbanesteder, inkludert ${Object.keys(BLOCKPOSTS).length} blokkposter.`);
