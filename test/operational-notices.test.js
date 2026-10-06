import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERATIONAL_NOTICES, activeOperationalNotices, operationalNoticeGraphUrl } from '../frontend/operational-notices.js';

test('operational notice is active only inside its configured interval', () => {
  assert.equal(activeOperationalNotices(new Date('2026-10-06T22:53:59+02:00')).length, 0);
  assert.equal(activeOperationalNotices(new Date('2026-10-06T22:54:00+02:00')).length, 1);
  assert.equal(activeOperationalNotices(new Date('2026-10-07T06:52:59+02:00')).length, 1);
  assert.equal(activeOperationalNotices(new Date('2026-10-07T06:53:00+02:00')).length, 0);
});

test('operational notice links to the matching Bane NOR daily graph', () => {
  const url = new URL(operationalNoticeGraphUrl(OPERATIONAL_NOTICES[0]));
  assert.equal(url.searchParams.get('dateInput'), '2026-10-06');
  assert.equal(url.searchParams.get('selectLine'), '24');
});
