import { readFile, writeFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';

const endpoint=process.env.TOGOVERSIKT_LOCATIONS_SOURCE ||
  'https://siri.banenor.no/jbv/pt/production-timetable.xml';
const files=['public/locations.json','data/locations.json'];
const parser=new XMLParser({removeNSPrefix:true,ignoreAttributes:true,parseTagValue:false,trimValues:true});
const first=value=>Array.isArray(value)?value[0]:value;

function collectPoints(value, points) {
  if(!value || typeof value!=='object') return;
  const code=first(value.StopPointRef), name=first(value.StopPointName);
  if(typeof code==='string' && typeof name==='string' && code.trim() && name.trim()) {
    points.set(code.trim(),name.trim());
  }
  for(const child of Object.values(value)) collectPoints(child,points);
}

const response=await fetch(endpoint,{headers:{'User-Agent':'Togoversikt.no location updater'}});
if(!response.ok) throw new Error(`Bane NOR svarte med HTTP ${response.status}`);
const points=new Map();
collectPoints(parser.parse(await response.text()),points);
if(points.size<100) throw new Error(`Fant bare ${points.size} navngitte rutepunkter; avbryter oppdateringen`);

const locations=JSON.parse(await readFile(files[0],'utf8'));
const knownCodes=new Set(locations.map(item=>item.code));
for(const [code,name] of points) {
  if(!knownCodes.has(code)) locations.push({name,code,kind:'Stoppested'});
}
locations.sort((a,b)=>a.name.localeCompare(b.name,'no') || a.code.localeCompare(b.code,'no'));
const output=`${JSON.stringify(locations,null,2)}\n`;
await Promise.all(files.map(file=>writeFile(file,output)));
console.log(`Lagret ${locations.length} søkbare steder (${points.size} aktive rutepunkter fra Bane NOR).`);
