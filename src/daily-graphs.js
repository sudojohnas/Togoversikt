import { extractTextItems } from 'unpdf';

export const DAILY_GRAPH_COUNT = 25;
export const DAILY_GRAPH_URL = 'https://www.banenor.no/for-deg-i-bransjen/togselskap/kapasitetsfordeling/daglige-rutegrafer/';

export function graphUrl(date, line) {
  const url=new URL(DAILY_GRAPH_URL);
  url.searchParams.set('dateInput',date);
  url.searchParams.set('selectLine',String(line));
  return url.toString();
}

export function graphResponseVersion(headers) {
  const disposition=String(headers?.get?.('content-disposition') || '');
  const filename=disposition.match(/filename\*?=(?:UTF-8''|["']?)([^"';\r\n]+)/i)?.[1]?.trim() || '';
  const etag=String(headers?.get?.('etag') || '').trim();
  const modified=String(headers?.get?.('last-modified') || '').trim();
  const length=String(headers?.get?.('content-length') || '').trim();
  if(etag) return `etag:${etag}`;
  if(modified) return `modified:${modified}|length:${length}`;
  if(filename) return `file:${filename}|length:${length}`;
  return length ? `length:${length}` : '';
}

export async function extractDailyGraphNumbers(data) {
  const {items}=await extractTextItems(new Uint8Array(data));
  return items.flat().map(item=>String(item.str || '').trim()).filter(value=>/^\d{1,6}$/.test(value));
}

export function matchCandidateTrainNumbers(candidates, graphNumbers) {
  const available=new Set(graphNumbers.map(String));
  return [...new Set(candidates.map(String).filter(value=>available.has(value)))];
}
