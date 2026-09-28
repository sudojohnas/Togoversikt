import { extractTextItems } from 'unpdf';

export const DAILY_GRAPH_COUNT = 25;
export const DAILY_GRAPH_URL = 'https://www.banenor.no/for-deg-i-bransjen/togselskap/kapasitetsfordeling/daglige-rutegrafer/';

export function graphUrl(date, line) {
  const url=new URL(DAILY_GRAPH_URL);
  url.searchParams.set('dateInput',date);
  url.searchParams.set('selectLine',String(line));
  return url.toString();
}

export async function extractDailyGraphNumbers(data) {
  const {items}=await extractTextItems(new Uint8Array(data));
  return items.flat().map(item=>String(item.str || '').trim()).filter(value=>/^\d{1,6}$/.test(value));
}

export function matchCandidateTrainNumbers(candidates, graphNumbers) {
  const available=new Set(graphNumbers.map(String));
  return [...new Set(candidates.map(String).filter(value=>available.has(value)))];
}
