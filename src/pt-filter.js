export function filterProductionTimetableXml(xml, locationCode, trainNumbers=[]) {
  const needle=`<StopPointRef>${locationCode}</StopPointRef>`;
  const requested=new Set(trainNumbers.map(String));
  return String(xml).replace(/<DatedTimetableVersionFrame>[\s\S]*?<\/DatedTimetableVersionFrame>/g,frame=>{
    let found=false;
    const filtered=frame.replace(/<DatedVehicleJourney>[\s\S]*?<\/DatedVehicleJourney>/g,journey=>{
      const code=journey.match(/<DatedVehicleJourneyCode>([^<]+)<\/DatedVehicleJourneyCode>/)?.[1] || '';
      const trainNo=String(code).split(':')[0];
      if(journey.includes(needle) || requested.has(trainNo)) { found=true; return journey; }
      return '';
    });
    return found ? filtered : '';
  });
}
