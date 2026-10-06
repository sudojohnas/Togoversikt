const DAILY_GRAPH_URL = 'https://www.banenor.no/for-deg-i-bransjen/togselskap/kapasitetsfordeling/daglige-rutegrafer/';

// Tidsavgrensede meldinger som skal vises overordnet, uavhengig av valgt sted.
// Bruk ISO-tid med eksplisitt norsk tidssone, slik at utløpet blir forutsigbart.
export const OPERATIONAL_NOTICES = [
  {
    id: 'train-54702-halden-berg-2026-10-06',
    trainNo: '54702',
    route: 'Halden–Berg',
    locationCodes: ['HLD', 'BG'],
    startsAt: '2026-10-06T22:54:00+02:00',
    endsAt: '2026-10-07T06:53:00+02:00',
    graphDate: '2026-10-06',
    graphLine: 24,
    message: 'Toget er ført mellom Halden og Berg i rutegrafen i dette tidsrommet.',
  },
];

export function activeOperationalNotices(now = new Date(), notices = OPERATIONAL_NOTICES) {
  const timestamp = now.getTime();
  return notices.filter(notice => {
    const start = Date.parse(notice.startsAt);
    const end = Date.parse(notice.endsAt);
    return Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp < end;
  });
}

export function operationalNoticesForLocation(locationCode, now = new Date(), notices = OPERATIONAL_NOTICES) {
  const code = String(locationCode || '').toUpperCase();
  return activeOperationalNotices(now, notices).filter(notice =>
    !notice.locationCodes?.length || notice.locationCodes.includes(code)
  );
}

export function operationalNoticeGraphUrl(notice) {
  const url = new URL(DAILY_GRAPH_URL);
  url.searchParams.set('dateInput', notice.graphDate);
  url.searchParams.set('selectLine', String(notice.graphLine));
  return url.toString();
}
