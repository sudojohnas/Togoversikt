import test from 'node:test';
import assert from 'node:assert/strict';
import { filterProductionTimetableXml } from '../src/pt-filter.js';

test('keeps only timetable journeys that visit the selected location', () => {
  const xml='<Siri><DatedTimetableVersionFrame><LineRef>-</LineRef>'+
    '<DatedVehicleJourney><DatedVehicleJourneyCode>5749:2026-09-28</DatedVehicleJourneyCode><DatedCall><StopPointRef>ROS</StopPointRef></DatedCall></DatedVehicleJourney>'+
    '<DatedVehicleJourney><DatedVehicleJourneyCode>1:2026-09-28</DatedVehicleJourneyCode><DatedCall><StopPointRef>OSL</StopPointRef></DatedCall></DatedVehicleJourney>'+
    '</DatedTimetableVersionFrame><DatedTimetableVersionFrame><LineRef>L1</LineRef>'+
    '<DatedVehicleJourney><DatedVehicleJourneyCode>2:2026-09-28</DatedVehicleJourneyCode><DatedCall><StopPointRef>LLS</StopPointRef></DatedCall></DatedVehicleJourney>'+
    '</DatedTimetableVersionFrame></Siri>';
  const filtered=filterProductionTimetableXml(xml,'ROS');
  assert.match(filtered,/5749:2026-09-28/);
  assert.doesNotMatch(filtered,/1:2026-09-28/);
  assert.doesNotMatch(filtered,/2:2026-09-28/);
  assert.doesNotMatch(filtered,/<LineRef>L1<\/LineRef>/);
});
