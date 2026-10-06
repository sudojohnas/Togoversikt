const DAILY_GRAPH_URL = 'https://www.banenor.no/for-deg-i-bransjen/togselskap/kapasitetsfordeling/daglige-rutegrafer/';

export function activeOperationalNotices(now = new Date(), notices = []) {
  const timestamp = now.getTime();
  return notices.filter(notice => {
    const start = Date.parse(notice.startsAt);
    const end = Date.parse(notice.endsAt);
    return Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp < end;
  });
}

export function operationalNoticesForLocation(locationCode, now = new Date(), notices = []) {
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
