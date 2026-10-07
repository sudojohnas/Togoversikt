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

test('also keeps requested train metadata when the train passes between listed calls', () => {
  const xml='<Siri><DatedTimetableVersionFrame><OperatorRef>VY</OperatorRef><LineRef>RE20</LineRef>'+
    '<DatedVehicleJourney><DatedVehicleJourneyCode>125:2026-10-07</DatedVehicleJourneyCode><ProductCategoryRef>Rt</ProductCategoryRef>'+
    '<DatedCall><StopPointRef>SBO</StopPointRef></DatedCall><DatedCall><StopPointRef>HLD</StopPointRef></DatedCall></DatedVehicleJourney>'+
    '<DatedVehicleJourney><DatedVehicleJourneyCode>127:2026-10-07</DatedVehicleJourneyCode><DatedCall><StopPointRef>HLD</StopPointRef></DatedCall></DatedVehicleJourney>'+
    '</DatedTimetableVersionFrame></Siri>';
  const filtered=filterProductionTimetableXml(xml,'BG',['125']);
  assert.match(filtered,/125:2026-10-07/);
  assert.match(filtered,/<OperatorRef>VY<\/OperatorRef>/);
  assert.match(filtered,/<ProductCategoryRef>Rt<\/ProductCategoryRef>/);
  assert.doesNotMatch(filtered,/127:2026-10-07/);
});
