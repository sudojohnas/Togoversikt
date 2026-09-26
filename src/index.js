const SIRI = 'https://siri.banenor.no/jbv';
const ENTUR = 'https://api.entur.io/geocoder/v1/reverse';

function copyParams(source, target, allowed) {
  for (const key of allowed) {
    for (const value of source.getAll(key)) target.append(key, value);
  }
}

async function proxyXml(request, upstreamBase, allowed, ttl) {
  const incoming = new URL(request.url);
  const upstream = new URL(upstreamBase);
  copyParams(incoming.searchParams, upstream.searchParams, allowed);
  const response = await fetch(upstream.toString(), {
    cf: { cacheEverything: true, cacheTtl: ttl },
    headers: { 'User-Agent': 'Togoversikt.no/1.0' },
  });
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', `public, max-age=${ttl}`);
  headers.set('X-Togoversikt-Upstream', 'Bane NOR SIRI');
  return new Response(response.body, { status: response.status, headers });
}

async function proxyNearest(request) {
  const incoming = new URL(request.url);
  const upstream = new URL(ENTUR);
  for (const key of ['lat', 'lon']) {
    const value = incoming.searchParams.get(key);
    if (value == null) return Response.json({ detail: 'Mangler posisjon' }, { status: 400 });
  }
  upstream.searchParams.set('point.lat', incoming.searchParams.get('lat'));
  upstream.searchParams.set('point.lon', incoming.searchParams.get('lon'));
  upstream.searchParams.set('size', '10');
  upstream.searchParams.set('lang', 'no');
  upstream.searchParams.set('layers', 'venue');
  upstream.searchParams.set('categories', 'railStation');
  const response = await fetch(upstream.toString(), {
    headers: { 'ET-Client-Name': 'johnas-togoversikt' },
    cf: { cacheTtl: 60 },
  });
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, max-age=60');
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && url.pathname.startsWith('/api/')) {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (url.pathname === '/api/sm') {
      return proxyXml(request, `${SIRI}/sm/stop-monitoring.xml`, [
        'MonitoringRef', 'StartTime', 'PreviewInterval', 'MaximumStopVisits',
        'OperatorRef', 'DestinationRef',
      ], 30);
    }
    if (url.pathname === '/api/et') {
      return proxyXml(request, `${SIRI}/et/EstimatedTimetable.xml`, [
        'PreviewInterval', 'OperatorRef', 'ServiceFeatureRef',
        'Lines.LineDirection.LineRef', 'Lines.LineDirection.DirectionRef',
      ], 30);
    }
    if (url.pathname === '/api/pt') {
      return proxyXml(request, `${SIRI}/pt/production-timetable.xml`, [
        'ValidityPeriod.StartTime', 'ValidityPeriod.EndTime',
      ], 600);
    }
    if (url.pathname === '/api/nearest') return proxyNearest(request);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', mode: 'Cloudflare Worker proxy', time: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },
};
