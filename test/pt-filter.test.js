import test from 'node:test';
import assert from 'node:assert/strict';
import { filterEstimatedTimetableXml, filterProductionTimetableXml } from '../src/pt-filter.js';

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

test('compacts production journeys to endpoints and the selected location', () => {
  const xml='<Siri><DatedTimetableVersionFrame><DatedVehicleJourney><DatedVehicleJourneyCode>1:2026-10-08</DatedVehicleJourneyCode><DatedCalls><DatedCall><StopPointRef>BGN</StopPointRef></DatedCall><DatedCall><StopPointRef>DRM</StopPointRef></DatedCall><DatedCall><StopPointRef>OSL</StopPointRef></DatedCall><DatedCall><StopPointRef>LLS</StopPointRef></DatedCall></DatedCalls></DatedVehicleJourney></DatedTimetableVersionFrame></Siri>';
  const compact=filterProductionTimetableXml(xml,'OSL');
  assert.match(compact,/<StopPointRef>BGN<\/StopPointRef>/);
  assert.doesNotMatch(compact,/<StopPointRef>DRM<\/StopPointRef>/);
  assert.match(compact,/<StopPointRef>OSL<\/StopPointRef>/);
  assert.match(compact,/<StopPointRef>LLS<\/StopPointRef>/);
  assert.match(filterProductionTimetableXml(xml,'OSL',[],false),/<StopPointRef>DRM<\/StopPointRef>/);
});

test('compacts estimated timetables to journeys and calls for one location', () => {
  const xml='<Siri><EstimatedJourneyVersionFrame><EstimatedVehicleJourney><DatedVehicleJourneyRef>1:2026-10-08</DatedVehicleJourneyRef><OriginName>Bergen</OriginName><DestinationName>Oslo S</DestinationName><RecordedCalls><RecordedCall><StopPointRef>DRM</StopPointRef></RecordedCall><RecordedCall><StopPointRef>OSL</StopPointRef><ActualArrivalTime>2026-10-08T12:00:00+02:00</ActualArrivalTime></RecordedCall><RecordedCall><StopPointRef>LYS</StopPointRef></RecordedCall></RecordedCalls><EstimatedCalls><EstimatedCall><StopPointRef>LYS</StopPointRef></EstimatedCall><EstimatedCall><StopPointRef>OSL</StopPointRef><ExpectedArrivalTime>2026-10-08T12:00:00+02:00</ExpectedArrivalTime></EstimatedCall></EstimatedCalls></EstimatedVehicleJourney><EstimatedVehicleJourney><DatedVehicleJourneyRef>2:2026-10-08</DatedVehicleJourneyRef><EstimatedCalls><EstimatedCall><StopPointRef>TRD</StopPointRef></EstimatedCall></EstimatedCalls></EstimatedVehicleJourney></EstimatedJourneyVersionFrame></Siri>';
  const filtered=filterEstimatedTimetableXml(xml,'OSL');
  assert.match(filtered,/1:2026-10-08/);
  assert.doesNotMatch(filtered,/2:2026-10-08/);
  assert.doesNotMatch(filtered,/<StopPointRef>DRM<\/StopPointRef>/);
  assert.match(filtered,/<StopPointRef>LYS<\/StopPointRef>/);
  assert.match(filtered,/<StopPointRef>OSL<\/StopPointRef>/);
  assert.match(filtered,/<ActualArrivalTime>2026-10-08T12:00:00\+02:00<\/ActualArrivalTime>/);
  assert.match(filtered,/<OriginName>Bergen<\/OriginName>/);
});
