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
    str:item.str,x:item.transform[4],y:item.transform[5],width:item.width,height:item.height,transform:Array.from(item.transform),
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

function pointFromMatrix(matrix,x,y) {
  return {x:matrix[0]*x+matrix[2]*y+matrix[4],y:matrix[1]*x+matrix[3]*y+matrix[5]};
}

function pointToSegmentDistance(point,segment) {
  const dx=segment.b.x-segment.a.x, dy=segment.b.y-segment.a.y, lengthSquared=dx*dx+dy*dy;
  if(!lengthSquared) return Math.hypot(point.x-segment.a.x,point.y-segment.a.y);
  const ratio=Math.max(0,Math.min(1,((point.x-segment.a.x)*dx+(point.y-segment.a.y)*dy)/lengthSquared));
  return Math.hypot(point.x-(segment.a.x+ratio*dx),point.y-(segment.a.y+ratio*dy));
}

export function matchGraphPathLabel(crossing, segment, labels) {
  const dx=segment.b.x-segment.a.x, dy=segment.b.y-segment.a.y, magnitude=Math.hypot(dx,dy);
  if(!magnitude) return null;
  let best=null;
  for(const label of labels) {
    const labelMagnitude=Math.hypot(label.vx,label.vy);
    if(!labelMagnitude) continue;
    const parallel=Math.abs((dx*label.vx+dy*label.vy)/(magnitude*labelMagnitude));
    const perpendicular=Math.abs((crossing.y-label.y)*label.vx-(crossing.x-label.x)*label.vy)/labelMagnitude;
    const distance=pointToSegmentDistance(label,segment);
    const score=perpendicular+80*(1-parallel)+0.03*distance;
    if((!best || score<best.score) && distance<300) best={...label,score,distance};
  }
  return best && best.score<=25 ? best : null;
}

function graphPathSegments(operators, OPS, initialState) {
  let state={...initialState,matrix:[...initialState.matrix],dash:[]}, stack=[];
  const segments=[];
  for(let i=0;i<operators.fnArray.length;i++) {
    const fn=operators.fnArray[i], args=operators.argsArray[i];
    if(fn===OPS.save) stack.push({...state,matrix:[...state.matrix],dash:[...state.dash]});
    else if(fn===OPS.restore) state=stack.pop() || state;
    else if(fn===OPS.transform) state.matrix=multiplyTransform(state.matrix,Array.from(args));
    else if(fn===OPS.setStrokeRGBColor) state.stroke=String(args?.[0] || '').toLowerCase();
    else if(fn===OPS.setLineWidth) state.width=Number(args?.[0]);
    else if(fn===OPS.setDash) state.dash=Array.from(args?.[0] || []);
    else if(fn===OPS.constructPath) {
      const raw=Array.from(args?.[1]?.[0] || []);
      let cursor=null;
      for(let j=0;j<raw.length;) {
        const operation=raw[j++];
        if(operation===0) cursor=pointFromMatrix(state.matrix,raw[j++],raw[j++]);
        else if(operation===1) {
          const next=pointFromMatrix(state.matrix,raw[j++],raw[j++]);
          if(cursor) segments.push({a:cursor,b:next,stroke:state.stroke,width:state.width,dash:state.dash});
          cursor=next;
        } else if(operation===2) j+=6;
        else if(operation===3) j+=4;
        else if(operation!==4) break;
      }
    }
  }
  return segments;
}

export function graphStrokeHints(stroke, trainNo='') {
  const color=String(stroke || '').toLowerCase();
  return {
    work_hint:!['#000000','#010101'].includes(color) && String(trainNo).length>=4,
    cancelled_hint:color==='#fed349',
  };
}

function pathCrossingOccurrences(segments, labels, stations, hours, page, line) {
  const minX=hours[0].x-3, maxX=hours.at(-1).x+3;
  const minY=Math.min(...stations.map(station=>station.y))-3;
  const maxY=Math.max(...stations.map(station=>station.y))+3;
  const trainColors=new Set(['#000000','#010101','#0000ff','#fed349','#ff0000']);
  const candidates=segments.filter(segment=>{
    const dx=Math.abs(segment.b.x-segment.a.x), dy=Math.abs(segment.b.y-segment.a.y);
    return trainColors.has(segment.stroke) && segment.width>0 && segment.width<=2 && !segment.dash.length && dx>0.1 && dy>0.1 &&
      segment.a.x>=minX && segment.a.x<=maxX && segment.b.x>=minX && segment.b.x<=maxX &&
      segment.a.y>=minY && segment.a.y<=maxY && segment.b.y>=minY && segment.b.y<=maxY;
  });
  const occurrences=[];
  for(const segment of candidates) for(const station of stations) {
    if(!((segment.a.y<=station.y && segment.b.y>=station.y)||(segment.b.y<=station.y && segment.a.y>=station.y))) continue;
    const ratio=(station.y-segment.a.y)/(segment.b.y-segment.a.y);
    const x=segment.a.x+ratio*(segment.b.x-segment.a.x);
    if(x<minX || x>maxX) continue;
    const label=matchGraphPathLabel({x,y:station.y},segment,labels);
    const hour=interpolateHour(x,hours), time=clockFromHour(hour);
    if(!label || !time) continue;
    const hints=graphStrokeHints(segment.stroke,label.train_no);
    occurrences.push({train_no:label.train_no,page,x,y:station.y,station_code:station.code,time,
      minute:Math.round(hour*60),...hints,line_number:line});
  }
  return occurrences;
}

export function graphPageLayout(view) {
  const width=Number(view?.[2])-Number(view?.[0]);
  const height=Number(view?.[3])-Number(view?.[1]);
  return {width,height,stationXMin:width-60,hourYMin:height-80,hourXMin:100,hourXMax:width-90};
}

async function possibleWorkTrainsFromDocument(pdf, pages, date, line, knownStationCodes=[], sectionStationCodes=[]) {
  const {OPS}=await getResolvedPDFJS();
  const known=new Set(knownStationCodes), sectionStations=new Set(sectionStationCodes), occurrences=[], sectionLabels=[];

  for(const {pageNumber,pageItems} of pages) {
    const pageIndex=pageNumber-1;
    const page=await pdf.getPage(pageIndex+1);
    const layout=graphPageLayout(page.view);
    const stations=pageItems
      .map(item=>({code:String(item.str || '').trim().toUpperCase(),x:Number(item.x),y:Number(item.y)}))
      .filter(item=>item.x>=layout.stationXMin && known.has(item.code));
    const hours=pageItems
      .map(item=>({raw:String(item.str || '').trim(),x:Number(item.x),y:Number(item.y)}))
      .filter(item=>item.y>layout.hourYMin && item.x>=layout.hourXMin && item.x<=layout.hourXMax && /^\d{1,2}$/.test(item.raw))
      .map(item=>({hour:Number(item.raw),x:item.x})).sort((a,b)=>a.x-b.x);
    if(!stations.length || hours.length<2) continue;

    const pathLabels=pageItems.map(item=>({
      train_no:String(item.str || '').trim(),x:Number(item.x),y:Number(item.y),
      vx:Number(item.transform?.[0]),vy:Number(item.transform?.[1]),
    })).filter(item=>/^\d{3,6}$/.test(item.train_no) && Number.isFinite(item.vx) && Number.isFinite(item.vy) && Math.abs(item.vy)>0.05);

    const operators=await page.getOperatorList();
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
        } else if(!rotated && text.blue && /^\d{4,6}$/.test(trainNo)) {
          const preferred=stations.filter(item=>sectionStations.has(item.code));
          const ordered=[...(preferred.length>=2?preferred:stations)].sort((left,right)=>right.y-left.y);
          const above=ordered.filter(item=>item.y>=y).sort((left,right)=>left.y-right.y)[0];
          const below=ordered.filter(item=>item.y<=y).sort((left,right)=>right.y-left.y)[0];
          const hour=interpolateHour(x,hours), time=clockFromHour(hour);
          if(time && above && below && above.code!==below.code && Math.abs(above.y-below.y)<=70) {
            sectionLabels.push({train_no:trainNo,page:pageIndex+1,time,minute:Math.round(hour*60),
              section_codes:[above.code,below.code],work_hint:true});
          }
        }
        text=null;
      }
    }
    const crossings=pathCrossingOccurrences(graphPathSegments(operators,OPS,{matrix:[1,0,0,1,0,0],stroke:'',width:0}),
      pathLabels,stations,hours,pageIndex+1,line);
    const crossingKeys=new Set(crossings.map(item=>`${item.train_no}:${item.page}:${item.station_code}`));
    for(let index=occurrences.length-1;index>=0;index--) {
      const item=occurrences[index];
      if(item.page===pageIndex+1 && crossingKeys.has(`${item.train_no}:${item.page}:${item.station_code}`)) occurrences.splice(index,1);
    }
    occurrences.push(...crossings);
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
        origin_code:route[0].code,destination_code:route.at(-1).code,work_hint:segment.some(item=>item.work_hint),
        cancelled_hint:segment.some(item=>item.cancelled_hint),route});
    }
  }
  return {trains,operational_markers:occurrences.map(item=>({
    train_no:item.train_no,line_number:line,station_code:item.station_code,time:item.time,minute:item.minute,
    work_hint:item.work_hint,cancelled_hint:item.cancelled_hint,
  })),operational_sections:sectionLabels.map(item=>({...item,line_number:line}))};
}

export async function extractPossibleWorkTrains(data, date, line, knownStationCodes=[], sectionStationCodes=[]) {
  const pdf=await getDocumentProxy(new Uint8Array(data));
  const {items}=await extractTextItems(pdf);
  const pages=items.map((pageItems,index)=>({pageNumber:index+1,pageItems}));
  return (await possibleWorkTrainsFromDocument(pdf,pages,date,line,knownStationCodes,sectionStationCodes)).trains;
}

export async function extractDailyGraphData(data, date, line, knownStationCodes=[], includePossibleWorkTrains=true, part=1, parts=1, sectionStationCodes=[]) {
  const pdf=await getDocumentProxy(new Uint8Array(data));
  const first=Math.floor((part-1)*pdf.numPages/parts)+1;
  const last=Math.floor(part*pdf.numPages/parts);
  const pageNumbers=Array.from({length:Math.max(0,last-first+1)},(_,index)=>first+index);
  const pages=await Promise.all(pageNumbers.map(async pageNumber=>({pageNumber,pageItems:await pageTextItems(pdf,pageNumber)})));
  const items=pages.map(page=>page.pageItems);
  const workData=includePossibleWorkTrains
    ? await possibleWorkTrainsFromDocument(pdf,pages,date,line,knownStationCodes,sectionStationCodes)
    : {trains:[],operational_markers:[],operational_sections:[]};
  return {
    numbers:graphNumbersFromItems(items),
    possible_work_trains:workData.trains,
    operational_markers:workData.operational_markers,
    operational_sections:workData.operational_sections,
  };
}

export function matchCandidateTrainNumbers(candidates, graphNumbers) {
  const available=new Set(graphNumbers.map(String));
  return [...new Set(candidates.map(String).filter(value=>available.has(value)))];
}
