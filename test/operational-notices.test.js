import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOperationalNotices, operationalNoticesForLocation, operationalNoticeGraphUrl } from '../frontend/operational-notices.js';

const notices=[{
  id:'graph:2026-10-06:24:54702:22:54',trainNo:'54702',route:'Halden–Berg',locationCodes:['HLD','BG'],
  startsAt:'2026-10-06T22:54:00+02:00',endsAt:'2026-10-07T06:53:00+02:00',graphDate:'2026-10-06',graphLine:24,
}];

test('operational notice is active only inside its configured interval', () => {
  assert.equal(activeOperationalNotices(new Date('2026-10-06T22:53:59+02:00'),notices).length, 0);
  assert.equal(activeOperationalNotices(new Date('2026-10-06T22:54:00+02:00'),notices).length, 1);
  assert.equal(activeOperationalNotices(new Date('2026-10-07T06:52:59+02:00'),notices).length, 1);
  assert.equal(activeOperationalNotices(new Date('2026-10-07T06:53:00+02:00'),notices).length, 0);
});

test('operational notice links to the matching Bane NOR daily graph', () => {
  const url = new URL(operationalNoticeGraphUrl(notices[0]));
  assert.equal(url.searchParams.get('dateInput'), '2026-10-06');
  assert.equal(url.searchParams.get('selectLine'), '24');
});

test('operational notice is shown only for Halden and Berg', () => {
  const now = new Date('2026-10-07T00:30:00+02:00');
  assert.equal(operationalNoticesForLocation('', now,notices).length, 0);
  assert.equal(operationalNoticesForLocation('OSL', now,notices).length, 0);
  assert.equal(operationalNoticesForLocation('HLD', now,notices).length, 1);
  assert.equal(operationalNoticesForLocation('BG', now,notices).length, 1);
});
