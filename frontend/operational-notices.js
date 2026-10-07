const DAILY_GRAPH_URL = 'https://www.banenor.no/for-deg-i-bransjen/togselskap/kapasitetsfordeling/daglige-rutegrafer/';
const osloDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'});

export function activeOperationalNotices(now = new Date(), notices = []) {
  const timestamp = now.getTime();
  return notices.filter(notice => {
    const start = Date.parse(notice.startsAt);
    const end = Date.parse(notice.endsAt);
    if(Number.isFinite(start) && Number.isFinite(end)) return timestamp >= start && timestamp < end;
    return String(notice.activeDate || notice.graphDate || '') === osloDate.format(now);
  });
}

export function operationalNoticesForLocation(locationCode, now = new Date(), notices = []) {
  const code = String(locationCode || '').toUpperCase();
  return activeOperationalNotices(now, notices).filter(notice =>
    !notice.locationCodes?.length || notice.locationCodes.includes(code)
  );
}

export function mergeOperationalNotices(...noticeLists) {
  return [...new Map(noticeLists.flat().filter(Boolean).map(notice => [notice.id, notice])).values()];
}

export function operationalNoticeGraphUrl(notice) {
  const url = new URL(DAILY_GRAPH_URL);
  url.searchParams.set('dateInput', notice.graphDate);
  url.searchParams.set('selectLine', String(notice.graphLine));
  return url.toString();
}
