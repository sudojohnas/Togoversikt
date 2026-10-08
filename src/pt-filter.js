export function filterProductionTimetableXml(xml, locationCode, trainNumbers=[], compact=true) {
  const needle=`<StopPointRef>${locationCode}</StopPointRef>`;
  const requested=new Set(trainNumbers.map(String));
  return String(xml).replace(/<DatedTimetableVersionFrame>[\s\S]*?<\/DatedTimetableVersionFrame>/g,frame=>{
    let found=false;
    const filtered=frame.replace(/<DatedVehicleJourney>[\s\S]*?<\/DatedVehicleJourney>/g,journey=>{
      const code=journey.match(/<DatedVehicleJourneyCode>([^<]+)<\/DatedVehicleJourneyCode>/)?.[1] || '';
      const trainNo=String(code).split(':')[0];
      if(journey.includes(needle) || requested.has(trainNo)) {
        found=true;
        if(!compact) return journey;
        return journey.replace(/<DatedCalls>[\s\S]*?<\/DatedCalls>/g,block=>{
          const calls=block.match(/<DatedCall>[\s\S]*?<\/DatedCall>/g) || [];
          const kept=calls.filter((call,index)=>index===0 || index===calls.length-1 || call.includes(needle));
          return `<DatedCalls>${[...new Set(kept)].join('')}</DatedCalls>`;
        });
      }
      return '';
    });
    return found ? filtered : '';
  });
}

export function filterEstimatedTimetableXml(xml, locationCode) {
  const needle=`<StopPointRef>${locationCode}</StopPointRef>`;
  return String(xml).replace(/<EstimatedJourneyVersionFrame>[\s\S]*?<\/EstimatedJourneyVersionFrame>/g,frame=>{
    let found=false;
    const filtered=frame.replace(/<EstimatedVehicleJourney>[\s\S]*?<\/EstimatedVehicleJourney>/g,journey=>{
      if(!journey.includes(needle)) return '';
      found=true;
      return journey
        .replace(/<RecordedCalls>[\s\S]*?<\/RecordedCalls>/g,block=>{
          const calls=block.match(/<RecordedCall>[\s\S]*?<\/RecordedCall>/g) || [];
          const kept=calls.filter((call,index)=>index===calls.length-1 || call.includes(needle));
          return kept.length?`<RecordedCalls>${[...new Set(kept)].join('')}</RecordedCalls>`:'';
        })
        .replace(/<EstimatedCalls>[\s\S]*?<\/EstimatedCalls>/g,block=>{
          const calls=block.match(/<EstimatedCall>[\s\S]*?<\/EstimatedCall>/g) || [];
          return `<EstimatedCalls>${calls.filter(call=>call.includes(needle)).join('')}</EstimatedCalls>`;
        });
    });
    return found?filtered:'';
  });
}
