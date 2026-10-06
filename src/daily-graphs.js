import { extractTextItems, getDocumentProxy, getResolvedPDFJS } from 'unpdf';

export const DAILY_GRAPH_COUNT = 25;
export const DAILY_GRAPH_URL = 'https://www.banenor.no/for-deg-i-bransjen/togselskap/kapasitetsfordeling/daglige-rutegrafer/';

export function graphUrl(date, line) {
  const url=new URL(DAILY_GRAPH_URL);
  url.searchParams.set('dateInput',date);
  url.searchParams.set('selectLine',String(line));
  return url.toString();
}

export function graphResponseVersion(headers) {
  const disposition=String(headers?.get?.('content-disposition') || '');
  const filename=disposition.match(/filename\*?=(?:UTF-8''|["']?)([^"';\r\n]+)/i)?.[1]?.trim() || '';
  const etag=String(headers?.get?.('etag') || '').trim();
  const modified=String(headers?.get?.('last-modified') || '').trim();
  const length=String(headers?.get?.('content-length') || '').trim();
  if(etag) return `etag:${etag}`;
  if(modified) return `modified:${modified}|length:${length}`;
  if(filename) return `file:${filename}|length:${length}`;
  return length ? `length:${length}` : '';
}

function graphNumbersFromItems(items) {
  return items.flat().map(item=>String(item.str || '').trim()).filter(value=>/^\d{1,6}$/.test(value));
}

async function pageTextItems(pdf, pageNumber) {
  const content=await (await pdf.getPage(pageNumber)).getTextContent();
  return content.items.filter(item=>item.str!=null).map(item=>({
    str:item.str,x:item.transform[4],y:item.transform[5],width:item.width,height:item.height,
  }));
}

export async function extractDailyGraphNumbers(data) {
  const {items}=await extractTextItems(new Uint8Array(data));
  return graphNumbersFromItems(items);
}

function multiplyTransform(a,b) {
  return [
    a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5],
  ];
}

function interpolateHour(x, hours) {
  if(hours.length<2) return null;
  let left=hours[0], right=hours.at(-1);
  for(let i=1;i<hours.length;i++) {
    if(x<=hours[i].x) { left=hours[i-1]; right=hours[i]; break; }
  }
  if(right.x===left.x) return null;
  return left.hour+(x-left.x)*(right.hour-left.hour)/(right.x-left.x);
}

function clockFromHour(value) {
  if(!Number.isFinite(value) || value<0 || value>=24) return null;
  const total=Math.max(0,Math.min(1439,Math.round(value*60)));
  return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}

async function possibleWorkTrainsFromDocument(pdf, pages, date, line, knownStationCodes=[]) {
  const {OPS}=await getResolvedPDFJS();
  const known=new Set(knownStationCodes), occurrences=[];

  for(const {pageNumber,pageItems} of pages) {
    const pageIndex=pageNumber-1;
    const stations=pageItems
      .map(item=>({code:String(item.str || '').trim().toUpperCase(),x:Number(item.x),y:Number(item.y)}))
      .filter(item=>item.x>=785 && known.has(item.code));
    const hours=pageItems
      .map(item=>({raw:String(item.str || '').trim(),x:Number(item.x),y:Number(item.y)}))
      .filter(item=>item.y>1100 && item.x>=100 && item.x<=750 && /^\d{1,2}$/.test(item.raw))
      .map(item=>({hour:Number(item.raw),x:item.x})).sort((a,b)=>a.x-b.x);
    if(!stations.length || hours.length<2) continue;

    const page=await pdf.getPage(pageIndex+1), operators=await page.getOperatorList();
    let state={fill:'',stroke:'',matrix:[1,0,0,1,0,0]}, stack=[], text=null;
    for(let i=0;i<operators.fnArray.length;i++) {
      const fn=operators.fnArray[i], args=operators.argsArray[i];
      if(fn===OPS.save) stack.push({fill:state.fill,stroke:state.stroke,matrix:[...state.matrix]});
      else if(fn===OPS.restore) state=stack.pop() || state;
      else if(fn===OPS.setFillRGBColor) state.fill=String(args?.[0] || '').toLowerCase();
      else if(fn===OPS.setStrokeRGBColor) state.stroke=String(args?.[0] || '').toLowerCase();
      else if(fn===OPS.transform) state.matrix=multiplyTransform(state.matrix,Array.from(args));
      else if(fn===OPS.beginText) text={value:'',blue:true,matrix:[...state.matrix]};
      else if((fn===OPS.showText || fn===OPS.showSpacedText) && text) {
        text.blue=text.blue && state.fill==='#0000ff' && state.stroke==='#0000ff';
        for(const glyph of args?.[0] || []) if(glyph && typeof glyph==='object' && glyph.unicode) text.value+=glyph.unicode;
      } else if(fn===OPS.endText && text) {
        const trainNo=text.value.trim(), [a,b,c,d,x,y]=text.matrix;
        const rotated=Math.abs(b)>0.05 || Math.abs(c)>0.05;
        if(rotated && /^\d{4,6}$/.test(trainNo)) {
          const station=stations.reduce((best,item)=>Math.abs(item.y-y)<Math.abs(best.y-y)?item:best,stations[0]);
          const hour=interpolateHour(x,hours), time=clockFromHour(hour);
          if(time && Math.abs(station.y-y)<=48) occurrences.push({train_no:trainNo,page:pageIndex+1,x,y,
            station_code:station.code,time,minute:Math.round(hour*60),work_hint:text.blue});
        }
        text=null;
      }
    }
  }

  const grouped=new Map();
  for(const occurrence of occurrences) {
    if(!grouped.has(occurrence.train_no)) grouped.set(occurrence.train_no,[]);
    grouped.get(occurrence.train_no).push(occurrence);
  }
  const trains=[];
  for(const [trainNo,raw] of grouped) {
    const unique=[...new Map(raw.map(item=>[`${item.page}:${Math.round(item.x)}:${Math.round(item.y)}`,item])).values()];
    if(!unique.length) continue;
    const segments=[];
    for(const occurrence of unique.sort((a,b)=>a.minute-b.minute)) {
      const current=segments.at(-1);
      // The same train number can be drawn more than once in a graph. A long
      // gap means a new path, not a many-hour stop in the route we expose.
      if(!current || occurrence.minute-current.at(-1).minute>180) segments.push([occurrence]);
      else current.push(occurrence);
    }
    for(const [segmentIndex,segment] of segments.entries()) {
      const route=[...new Map(segment.map(item=>[`${item.station_code}:${item.time}`,{
        code:item.station_code,time:item.time,minute:item.minute,
      }])).values()];
      if(!route.length) continue;
      trains.push({journey_id:`graph:${date}:${line}:${trainNo}:${route[0].time}:${segmentIndex+1}`,train_no:trainNo,line_number:line,
        origin_code:route[0].code,destination_code:route.at(-1).code,work_hint:segment.some(item=>item.work_hint),route});
    }
  }
  return trains;
}

export async function extractPossibleWorkTrains(data, date, line, knownStationCodes=[]) {
  const pdf=await getDocumentProxy(new Uint8Array(data));
  const {items}=await extractTextItems(pdf);
  const pages=items.map((pageItems,index)=>({pageNumber:index+1,pageItems}));
  return possibleWorkTrainsFromDocument(pdf,pages,date,line,knownStationCodes);
}

export async function extractDailyGraphData(data, date, line, knownStationCodes=[], includePossibleWorkTrains=true, part=1, parts=1) {
  const pdf=await getDocumentProxy(new Uint8Array(data));
  const first=Math.floor((part-1)*pdf.numPages/parts)+1;
  const last=Math.floor(part*pdf.numPages/parts);
  const pageNumbers=Array.from({length:Math.max(0,last-first+1)},(_,index)=>first+index);
  const pages=await Promise.all(pageNumbers.map(async pageNumber=>({pageNumber,pageItems:await pageTextItems(pdf,pageNumber)})));
  const items=pages.map(page=>page.pageItems);
  return {
    numbers:graphNumbersFromItems(items),
    possible_work_trains:includePossibleWorkTrains
      ? await possibleWorkTrainsFromDocument(pdf,pages,date,line,knownStationCodes) : [],
  };
}

export function matchCandidateTrainNumbers(candidates, graphNumbers) {
  const available=new Set(graphNumbers.map(String));
  return [...new Set(candidates.map(String).filter(value=>available.has(value)))];
}
