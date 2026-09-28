export function filterProductionTimetableXml(xml, locationCode) {
  const needle=`<StopPointRef>${locationCode}</StopPointRef>`;
  return String(xml).replace(/<DatedTimetableVersionFrame>[\s\S]*?<\/DatedTimetableVersionFrame>/g,frame=>{
    let found=false;
    const filtered=frame.replace(/<DatedVehicleJourney>[\s\S]*?<\/DatedVehicleJourney>/g,journey=>{
      if(journey.includes(needle)) { found=true; return journey; }
      return '';
    });
    return found ? filtered : '';
  });
}
