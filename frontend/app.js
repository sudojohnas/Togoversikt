import { searchLocations as searchLocationData, nearestLocation, queryTrains, routeGraphsForLocation, trainDetail } from './data.js';
import { mergeOperationalNotices, operationalNoticesForLocation } from './operational-notices.js';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const osloDateFmt = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'});
const osloTimeFmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const osloShortDateFmt = new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',day:'numeric',month:'short',year:'numeric'});
const localDate = d => osloDateFmt.format(d);
const localTime = d => osloTimeFmt.format(d);
let searchTimer = null;
let suggestions = [];
let activeSuggestion = -1;
let autoFromNow = true;
let lastDataSignature = null;
let updateCheckRunning = false;
let lastTrainItems = [];
let activeLocationCode = null;
let loadRequestId = 0;
let boardMode = 'both';
let boardModeManuallySelected = false;
const hiddenCategories = new Set();
const hiddenTracks = new Set();
let lastOperationalNotices = [];

const noticeDateFmt = new Intl.DateTimeFormat('nb-NO', {
  timeZone:'Europe/Oslo', weekday:'short', day:'numeric', month:'short',
});

function noticeTime(value) {
  const date = new Date(value);
  return `${noticeDateFmt.format(date)} kl. ${localTime(date)}`;
}

function noticeTimeSummary(notice) {
  if(Number.isFinite(Date.parse(notice.startsAt)) && Number.isFinite(Date.parse(notice.endsAt))) {
    return `${noticeTime(notice.startsAt)} – ${noticeTime(notice.endsAt)}`;
  }
  const times=[...new Set(notice.knownTimes || [])];
  if(times.length>1) return `Registrerte tider: ${times.join(' og ')}`;
  if(times.length===1) return `Kun ett tidspunkt funnet: ${times[0]}`;
  return 'Tidsrom ikke funnet i rutegrafen';
}

function renderOperationalNotices() {
  const container = $('operational-notices');
  const notices = operationalNoticesForLocation($('location').dataset.code,new Date(),lastOperationalNotices);
  container.hidden = !notices.length;
  container.innerHTML = notices.map(notice => `
    <article class="operational-notice">
      <div class="operational-notice-mark" aria-hidden="true">!</div>
      <div class="operational-notice-copy">
        <div class="kicker">OBS</div>
        <h2>Tog ${esc(notice.trainNo)} · ${esc(notice.route)}</h2>
        <p class="operational-notice-time">${esc(noticeTimeSummary(notice))}</p>
        <p>${esc(notice.message)} <strong>Sjekk rutegrafen.</strong></p>
        ${(notice.missing || []).length ? `<p class="operational-notice-missing"><strong>Mangler:</strong> ${esc(notice.missing.join(' og '))}.</p>` : ''}
      </div>
    </article>`).join('');
}

renderOperationalNotices();
setInterval(renderOperationalNotices, 60000);

function rowClass(x) {
  const s = String(x.status || '').toLowerCase();
  if (s.includes('innstilt')) return 'cancelled';
  if (s.includes('forsinket')) return 'delayed';
  if (s.includes('passert') || s.includes('ankommet')) return 'passed';
  return 'ontime';
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('innstilt')) return 'cancelled';
  if (s.includes('forsinket')) return 'delayed';
  if (s.includes('passert') || s.includes('ankommet')) return 'passed';
  return 'normal';
}

function formatSourceTime(value) {
  if (!value) return 'SIRI';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'Sist oppdatert –' : `Sist oppdatert ${localTime(d)}`;
}

function dataSignature(data) {
  return JSON.stringify((data.items || []).map(x => [
    x.journey_id, x.time, x.planned_time, x.expected_time, x.actual_time,
    x.platform, x.status, x.current_location, x.graph_fallback, x.graph_checked_at, x.event_type
  ]));
}

function currentTrainQuery(fromTime=$('from').value || '00:00') {
  return {
    location: $('location').value.trim(),
    locationCode: $('location').dataset.code || '',
    date: $('date').value,
    fromTime,
    toTime: $('to').value || '23:59',
    today: localDate(new Date()),
    eventType: boardMode,
  };
}
async function fetchLocations(q) { return searchLocationData(q); }

function hideSuggestions() {
  $('suggestions').hidden = true;
  activeSuggestion = -1;
}

function drawSuggestions() {
  if (!suggestions.length) {
    $('suggestions').innerHTML = '<div class="suggestion-empty">Ingen treff</div>';
    $('suggestions').hidden = false;
    return;
  }
  $('suggestions').innerHTML = suggestions.map((x, i) => `
    <button class="suggestion ${i === activeSuggestion ? 'active' : ''}" type="button" data-index="${i}">
      <span><strong>${esc(x.name)}</strong><small>${esc(x.kind)}</small></span>
      <b>${esc(x.code)}</b>
    </button>`).join('');
  $('suggestions').hidden = false;
  $('suggestions').querySelectorAll('.suggestion').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault();
      chooseSuggestion(Number(btn.dataset.index));
    });
  });
}

function resetFromToNow() {
  if ($('date').value !== localDate(new Date())) return;
  $('from').value = localTime(new Date());
  autoFromNow = true;
  syncPickerButtons();
}

function chooseSuggestion(index) {
  const x = suggestions[index];
  if (!x) return;
  $('location').value = x.name;
  $('location').dataset.code = x.code;
  lastOperationalNotices = [];
  renderOperationalNotices();
  boardModeManuallySelected = false;
  resetFromToNow();
  hideSuggestions();
  loadTrains();
}

async function updateSuggestions() {
  const q = $('location').value.trim();
  if (!q) { hideSuggestions(); return; }
  suggestions = await fetchLocations(q);
  activeSuggestion = -1;
  drawSuggestions();
}
function timeCell(x) {
  const delayed = String(x.status || '').toLowerCase().includes('forsinket');
  const eventType = x.event_type === 'arrival' ? 'arrival' : 'departure';
  const event = boardMode === 'both' ? `<small class="event-kind ${eventType}">${eventType === 'arrival' ? 'Ankomst' : 'Avgang'}</small>` : '';
  if (String(x.status || '').includes('Innstilt')) return `<span class="main-time cancelled-time">${esc(x.planned_time || x.time)}</span>${event}`;
  const sub = delayed && x.planned_time ? `<small>Planlagt ${esc(x.planned_time)}</small>` : '';
  return `<span class="main-time">${esc(x.time)}</span>${event}${sub}`;
}

function statusCell(x) {
  const s = String(x.status || '');
  const passing = x.passing ? '<span class="desktop-passing">Passerende</span>' : '';
  if (x.graph_only) {
    const fetched = new Date(x.graph_checked_at || '');
    const fetchedLabel = Number.isNaN(fetched.getTime()) ? ''
      : `kl. ${localTime(fetched)} ${localDate(fetched) === localDate(new Date()) ? 'i dag' : osloShortDateFmt.format(fetched)}`;
    return `${passing}<strong>Hentet fra rutegraf</strong><small>${fetchedLabel ? `${esc(fetchedLabel)} · ` : ''}Ingen sanntidsdata</small>`;
  }
  const graph = x.graph_fallback ? '<small>Hentet fra rutegraf</small>' : '';
  if (s.includes('Innstilt')) return `${passing}<strong>Innstilt</strong>`;
  if (s.includes('Forsinket')) {
    const match = s.match(/\+(\d+) min/);
    const delay = match ? `+${match[1]} min` : 'Forsinket';
    return `${passing}<strong>${esc(delay)}</strong>`;
  }
  if (s.includes('Passert')) return `${passing}<strong>Passert</strong>`;
  if (s.includes('Ankommet')) return `${passing}<strong>Ankommet</strong>`;
  return `${passing}<strong>${esc(s || 'I rute')}</strong>${graph}`;
}

function unconfirmedNote(x) {
  const remaining=Number(x.unconfirmed_remaining_minutes);
  if(!Number.isFinite(remaining) || remaining<=0) return '';
  return `<small class="unconfirmed-note">Ingen ny info mottatt · fjernes om ${remaining} min</small>`;
}

function categoryLabel(value) {
  if (value === 'Persontog') return 'Passasjertog';
  if (!value || value === 'Ukjent') return 'Ukjente';
  return value;
}

function trackKey(x) {
  return String(x.platform || '–');
}

function trainItemKey(x) {
  return `${x.journey_id}::${x.event_type || 'auto'}`;
}

function filteredTrainItems() {
  return lastTrainItems.filter(x => !hiddenCategories.has(x.category) && !hiddenTracks.has(trackKey(x)));
}

function bindTrainRows() {
  $('rows').querySelectorAll('.train-row').forEach(row => {
    const open = () => openDetail(row.dataset.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

function renderTrainRows() {
  const items = filteredTrainItems();
  if (!items.length) {
    const noTrains = boardMode === 'arrival' ? 'Ingen ankomster funnet i valgt tidsrom.'
      : boardMode === 'departure' ? 'Ingen avganger funnet i valgt tidsrom.' : 'Ingen ankomster eller avganger funnet i valgt tidsrom.';
    $('rows').innerHTML = `<tr><td colspan="7" class="empty">${lastTrainItems.length ? 'Ingen tog samsvarer med filteret.' : noTrains}</td></tr>`;
    updateFilterSummary();
    return;
  }
  $('rows').innerHTML = items.map(x => {
    const operator=String(x.operator || '').trim();
    const platform=String(x.platform || '').trim();
    return `<tr class="train-row ${rowClass(x)}" tabindex="0" data-id="${esc(trainItemKey(x))}">
    <td class="time time-cell">${timeCell(x)}</td>
    <td class="trainno train-cell">${esc(x.train_no)}${x.line && x.line !== '-' ? `<small>${esc(x.line)}</small>` : ''}</td>
    <td class="track-cell">${platform ? `<span class="track-value"><span class="track-label">Spor </span>${esc(platform)}</span>` : ''}${x.passing ? '<span class="passing-label">Passerende</span>' : ''}</td>
    <td class="type-text type-cell">${esc(x.category)}${operator ? `<span class="mobile-operator"> · ${esc(operator)}</span>` : ''}</td>
    <td class="operator-cell">${esc(operator)}</td>
    <td class="direction route-cell">${esc(x.origin)} <span>→</span> ${esc(x.destination)}${unconfirmedNote(x)}</td>
    <td class="status-text status-cell">${statusCell(x)}</td>
  </tr>`;
  }).join('');
  bindTrainRows();
  updateFilterSummary();
}

function updateFilterSummary() {
  const count = hiddenCategories.size + hiddenTracks.size;
  $('filter-summary').textContent = count ? `${count} filter${count === 1 ? '' : 'e'} aktiv` : 'Alle tog og spor';
}

function renderFilterOptions() {
  const alwaysCategories = ['Persontog', 'Godstog', 'Bane NOR-bestilt', 'Ukjent'];
  const cats = [...new Set([...alwaysCategories, ...lastTrainItems.map(x => x.category || 'Ukjent')])]
    .sort((a,b) => categoryLabel(a).localeCompare(categoryLabel(b), 'no'));
  const tracks = [...new Set(lastTrainItems.map(trackKey))].sort((a,b) => a.localeCompare(b, 'no', {numeric:true}));
  $('filter-categories').innerHTML = cats.map(x => `<label class="filter-option"><input type="checkbox" data-filter-category="${esc(x)}" ${hiddenCategories.has(x) ? '' : 'checked'}><span>${esc(categoryLabel(x))}</span></label>`).join('') || '<p class="muted">Ingen togtyper tilgjengelig.</p>';
  $('filter-tracks').innerHTML = tracks.map(x => `<label class="filter-option"><input type="checkbox" data-filter-track="${esc(x)}" ${hiddenTracks.has(x) ? '' : 'checked'}><span>${x === '–' ? 'Ukjent spor' : `Spor ${esc(x)}`}</span></label>`).join('') || '<p class="muted">Ingen spor tilgjengelig.</p>';
  document.querySelectorAll('[data-filter-category]').forEach(el => el.onchange = () => {
    el.checked ? hiddenCategories.delete(el.dataset.filterCategory) : hiddenCategories.add(el.dataset.filterCategory);
    renderTrainRows();
  });
  document.querySelectorAll('[data-filter-track]').forEach(el => el.onchange = () => {
    el.checked ? hiddenTracks.delete(el.dataset.filterTrack) : hiddenTracks.add(el.dataset.filterTrack);
    renderTrainRows();
  });
}

function resetFilters() {
  hiddenCategories.clear();
  hiddenTracks.clear();
  renderFilterOptions();
  renderTrainRows();
}

function applyTrainData(d) {
  lastDataSignature = dataSignature(d);
  $('update-notice').hidden = true;
  if (d.location_code) $('location').dataset.code = d.location_code;
  if (d.location) $('location').value = d.location;
  if (activeLocationCode && d.location_code && activeLocationCode !== d.location_code) {
    hiddenCategories.clear();
    hiddenTracks.clear();
  }
  activeLocationCode = d.location_code || activeLocationCode;
  lastTrainItems = d.items || [];
  lastOperationalNotices = d.operational_notices || [];
  renderOperationalNotices();
  $('source').textContent = 'Oppdater';
  $('updated').textContent = formatSourceTime(d.source_time);
  $('welcome').hidden = true;
  $('results').hidden = false;
  $('results').removeAttribute('aria-busy');
  $('train-loading').hidden = true;
  $('table-panel').hidden = false;
  renderTrainRows();
}

async function loadRouteGraphs(requestId) {
  const locationCode=$('location').dataset.code || '';
  const locationName=$('location').value.trim() || locationCode;
  if(!locationCode) { $('route-graphs').hidden=true; return; }
  $('route-graphs').hidden=false;
  $('route-graphs-title').textContent=`Rutegrafer fra Bane NOR for ${locationName}`;
  $('route-graphs-description').textContent='Henter aktuelle strekninger …';
  $('route-graph-links').innerHTML='';
  try {
    const graphs=await routeGraphsForLocation(locationCode,$('date').value);
    if(requestId!==loadRequestId) return;
    if(!graphs.length) {
      $('route-graphs-description').textContent='Fant ingen rutegraf koblet til dette stedet.';
      return;
    }
    $('route-graphs-description').textContent=graphs.length===1
      ? 'Åpnes hos Bane NOR i en ny fane.'
      : `${graphs.length} rutegrafer dekker valgt sted · åpnes hos Bane NOR i en ny fane.`;
    const links=graphs.map(graph=>
      `<a href="${esc(graph.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(graph.name)}</span><small>Rutegraf ${esc(graph.line)}</small></a>`
    ).join('');
    $('route-graph-links').innerHTML=graphs.length>3
      ? `<details class="route-graph-picker"><summary><span class="route-graph-picker-copy"><strong>Velg rutegraf fra Bane NOR</strong><small>Åpnes i ny fane</small></span><span class="route-graph-count">${graphs.length}</span><span class="route-graph-chevron" aria-hidden="true"></span></summary><div class="route-graph-menu">${links}</div></details>`
      : links;
  } catch {
    if(requestId!==loadRequestId) return;
    $('route-graphs-description').textContent='Kunne ikke hente aktuelle rutegrafer.';
  }
}

async function loadTrains(allowModeFallback=true) {
  const requestId = ++loadRequestId;
  if (autoFromNow && $('date').value === localDate(new Date())) {
    $('from').value = localTime(new Date());
    syncPickerButtons();
  }
  const locationName = $('location').value.trim();
  $('welcome').hidden = true;
  $('results').hidden = false;
  $('results').setAttribute('aria-busy','true');
  $('train-loading-location').textContent = locationName ? `Valgt sted: ${locationName}` : 'Valgt sted';
  $('train-loading').hidden = false;
  $('table-panel').hidden = true;
  $('update-notice').hidden = true;
  loadRouteGraphs(requestId);
  try {
    let d = await queryTrains(currentTrainQuery());
    if (requestId !== loadRequestId) return;
    if (allowModeFallback && boardMode !== 'both' && !boardModeManuallySelected && !(d.items || []).length) {
      const fallbackMode = boardMode === 'arrival' ? 'departure' : 'arrival';
      try {
        const fallback = await queryTrains({...currentTrainQuery(), eventType:fallbackMode});
        if (requestId !== loadRequestId) return;
        fallback.operational_notices = mergeOperationalNotices(d.operational_notices || [],fallback.operational_notices || []);
        if ((fallback.items || []).length) {
          boardMode = fallbackMode;
          updateBoardModeControls();
          d = fallback;
        }
      } catch (_) {
        // Behold den valgte, tomme visningen hvis alternativet ikke kan lastes.
      }
    }
    if (requestId !== loadRequestId) return;
    applyTrainData(d);
  } catch (e) {
    if (requestId !== loadRequestId) return;
    $('welcome').hidden = true;
    $('results').hidden = false;
    $('results').removeAttribute('aria-busy');
    $('train-loading').hidden = true;
    $('table-panel').hidden = false;
    $('rows').innerHTML = `<tr><td colspan="7" class="empty error">${esc(e.message)}</td></tr>`;
  }
}
function routeEventTime(label, actual, expected, planned) {
  if (actual) return `${label==='ank.'?'Ank.':'Avg.'} ${esc(actual)}`;
  if (expected) return `Forventet ${label} ${esc(expected)}`;
  if (planned) return `Planlagt ${label} ${esc(planned)}`;
  return '';
}
function routeTime(stop) {
  const arrival=routeEventTime('ank.',stop.actual_arrival,stop.expected_arrival,stop.planned_arrival);
  const departure=routeEventTime('avg.',stop.actual_departure,stop.expected_departure,stop.planned_departure);
  const events=[arrival,departure].filter(Boolean);
  if(events.length) return events.join(' · ');
  if (stop.actual) return `${esc(stop.actual)}`;
  if (stop.expected) return `Forventet ${esc(stop.expected)}`;
  if (stop.planned) return `Planlagt ${esc(stop.planned)}`;
  return 'Tid ikke oppgitt';
}

async function openDetail(itemKey, force=false) {
  const dialog = $('detail');
  $('detail-content').innerHTML = '<div class="detail-loading"><span class="spinner"></span> Henter togrute …</div>';
  if (!dialog.open) dialog.showModal();
  try {
    const item = lastTrainItems.find(x => trainItemKey(x) === itemKey) || null;
    const journeyId = item?.journey_id || itemKey;
    const x = await trainDetail({
      journeyId,
      date: $('date').value,
      locationCode: $('location').dataset.code || '',
      today: localDate(new Date()),
      item,
      force,
    });
    if (!x) throw new Error('Toget finnes ikke lenger i datasettet');
    const route = (x.route || []).map(stop => {
      const cls = stop.state === 'current' ? 'current' : stop.state === 'recorded' ? 'passed' : 'upcoming';
      const code = stop.code && stop.code !== stop.name ? ` <small>(${esc(stop.code)})</small>` : '';
      return `<div class="route-stop ${cls} ${stop.selected ? 'selected' : ''}">
        <div class="route-marker"></div>
        <div><strong>${esc(stop.name)}${code}${stop.passing ? '<em class="passing-badge">Passerende</em>' : ''}</strong>
        <span>${routeTime(stop)}${stop.platform ? ` · spor ${esc(stop.platform)}` : ''}${stop.status === 'Innstilt' ? ' · innstilt' : ''}</span></div>
      </div>`;
    }).join('');
    const sourceUrl = x.source_url || item?.graph_url;
    const sourceLink = sourceUrl
      ? `<a class="detail-source-link" href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">Åpne rutegraf hos Bane NOR <span aria-hidden="true">↗</span></a>`
      : '';
    $('detail-content').innerHTML = `
      <div class="detail-head"><div><div class="kicker">${esc(x.category)}</div><h2>Tog ${esc(x.train_no)}</h2><p>${esc(x.origin)} → ${esc(x.destination)}</p></div><button id="detail-refresh" class="detail-refresh" type="button">Oppdater</button></div>
      <div class="detail-grid">
        ${x.operator ? `<div><span>Operatør</span><strong>${esc(x.operator)}</strong></div>` : ''}
        <div><span>Status ved valgt punkt</span><strong>${x.passing ? 'Passerende · ' : ''}${esc(x.status)}</strong></div>
        ${x.passing ? '<div><span>Stopp ved valgt punkt</span><strong>Nei – passerer uten stopp</strong></div>' : ''}
        <div><span>Siste registrerte punkt</span><strong>${esc(x.current_location)}</strong></div>
      </div>
      ${sourceLink}
      <h3>Rute</h3>
      <div class="route">${route || '<p class="muted">Ingen rutepunkter tilgjengelig.</p>'}</div>`;
    const refresh = $('detail-refresh');
    if (refresh) refresh.onclick = () => openDetail(itemKey, true);
  } catch (e) {
    $('detail-content').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
$('location').addEventListener('input', () => {
  $('location').dataset.code = '';
  lastOperationalNotices = [];
  renderOperationalNotices();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(updateSuggestions, 120);
});

$('location').addEventListener('focus', () => {
  if ($('location').value.trim()) updateSuggestions();
});

$('location').addEventListener('keydown', e => {
  if ($('suggestions').hidden || !suggestions.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); activeSuggestion = Math.min(activeSuggestion + 1, suggestions.length - 1); drawSuggestions(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); activeSuggestion = Math.max(activeSuggestion - 1, 0); drawSuggestions(); }
  if (e.key === 'Enter' && activeSuggestion >= 0) { e.preventDefault(); chooseSuggestion(activeSuggestion); }
  if (e.key === 'Escape') hideSuggestions();
});

document.addEventListener('click', e => { if (!e.target.closest('.location-field')) hideSuggestions(); });
const monthNames = ['jan.','feb.','mars','apr.','mai','juni','juli','aug.','sep.','okt.','nov.','des.'];
const dayNames = ['Søndag','Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag'];
let calendarCursor = new Date();

function formatDateButton(value) {
  const [y,m,d] = value.split('-').map(Number);
  const dayName = dayNames[new Date(y,m-1,d).getDay()];
  return `${dayName} ${d}. ${monthNames[m-1]} ${y}`;
}
function syncPickerButtons() {
  $('date-display').textContent = formatDateButton($('date').value);
  $('from-display').textContent = $('from').value;
  $('to-display').textContent = $('to').value;
}
function openDatePicker() {
  const [y,m,d] = $('date').value.split('-').map(Number);
  calendarCursor = new Date(y,m-1,d);
  renderCalendar();
  $('value-picker').showModal();
}
function renderCalendar() {
  const y=calendarCursor.getFullYear(), m=calendarCursor.getMonth();
  const first=new Date(y,m,1), days=new Date(y,m+1,0).getDate();
  const offset=(first.getDay()+6)%7;
  let cells='';
  for(let i=0;i<offset;i++) cells+='<span></span>';
  for(let d=1;d<=days;d++){
    const val=`${y}-${pad(m+1)}-${pad(d)}`;
    const active=val===$('date').value?' active':'';
    cells+=`<button type="button" class="calendar-day${active}" data-date="${val}">${d}</button>`;
  }
  $('picker-title').textContent='Velg dato';
  $('picker-body').innerHTML=`<div class="calendar-nav"><button id="cal-prev" type="button">‹</button><strong>${monthNames[m]} ${y}</strong><button id="cal-next" type="button">›</button></div><div class="weekdays"><span>Ma</span><span>Ti</span><span>On</span><span>To</span><span>Fr</span><span>Lø</span><span>Sø</span></div><div class="calendar-grid">${cells}</div>`;
  $('cal-prev').onclick=()=>{calendarCursor=new Date(y,m-1,1);renderCalendar();};
  $('cal-next').onclick=()=>{calendarCursor=new Date(y,m+1,1);renderCalendar();};
  document.querySelectorAll('.calendar-day').forEach(b=>b.onclick=()=>{
    $('date').value=b.dataset.date;
    if ($('date').value===localDate(new Date())) { $('from').value=localTime(new Date()); autoFromNow=true; }
    else { $('from').value='00:00'; autoFromNow=false; }
    syncPickerButtons(); $('value-picker').close();
    if ($('location').dataset.code) loadTrains();
  });
}
$('date-display').onclick=openDatePicker;
for(const target of ['from','to']) $(target).addEventListener('change',()=>{
  if(!$(target).value) return;
  if(target==='from') autoFromNow=false;
  syncPickerButtons();
  if($('location').dataset.code) loadTrains();
});
$('picker-close').onclick=()=>$('value-picker').close();
$('value-picker').addEventListener('click',e=>{if(e.target===$('value-picker')) $('value-picker').close();});
$('date').value = localDate(new Date());
$('from').value = localTime(new Date());
$('to').value = '23:59';
syncPickerButtons();
$('close-detail').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('click', e => { if (e.target === $('detail')) $('detail').close(); });

async function useMyLocation() {
  const btn = $('locate');
  if (!navigator.geolocation) { alert('Posisjon støttes ikke i denne nettleseren.'); return; }
  if (!window.isSecureContext) { alert('Posisjon krever HTTPS.'); return; }
  btn.disabled = true;
  btn.textContent = 'Finner posisjon';
  navigator.geolocation.getCurrentPosition(async pos => {
    try {
      const x = await nearestLocation(pos.coords.latitude, pos.coords.longitude);
      $('location').value = x.name;
      $('location').dataset.code = x.code;
      lastOperationalNotices = [];
      renderOperationalNotices();
      boardModeManuallySelected = false;
      resetFromToNow();
      hideSuggestions();
      btn.textContent = 'Finner tog';
      await loadTrains();
    } catch (e) { alert(e.message); }
    finally { btn.disabled = false; btn.textContent = 'Min posisjon'; }
  }, err => {
    const message = err.code === 1 ? 'Du må tillate posisjonstilgang for å bruke denne funksjonen.' : 'Kunne ikke hente posisjonen din.';
    alert(message);
    btn.disabled = false; btn.textContent = 'Min posisjon';
  }, {enableHighAccuracy: true, timeout: 12000, maximumAge: 60000});
}

$('locate').addEventListener('click', useMyLocation);


const SHARE_URL = 'https://togoversikt.no';

async function shareSite() {
  const btn = $('share');
  const payload = {
    title: 'Togoversikt',
    text: 'Se tog, passeringer og trafikkstatus på Togoversikt',
    url: SHARE_URL,
  };
  try {
    if (navigator.share) {
      await navigator.share(payload);
      return;
    }
    await navigator.clipboard.writeText(SHARE_URL);
    const old = btn.innerHTML;
    btn.textContent = 'Lenke kopiert';
    setTimeout(() => { btn.innerHTML = old; }, 1800);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      const old = btn.innerHTML;
      btn.textContent = 'Lenke kopiert';
      setTimeout(() => { btn.innerHTML = old; }, 1800);
    } catch (_) {
      prompt('Kopier lenken:', SHARE_URL);
    }
  }
}

$('share').addEventListener('click', shareSite);

const menuToggle = $('menu-toggle');
const siteMenuPanel = $('site-menu-panel');
const trainMapFrame = $('train-map-frame');

function setMenuOpen(open) {
  siteMenuPanel.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Lukk meny' : 'Åpne meny');
  if (open) $('open-train-map').focus();
}

function showTrainMap() {
  setMenuOpen(false);
  $('overview-view').hidden = true;
  $('train-map-view').hidden = false;
  if (!trainMapFrame.src) trainMapFrame.src = trainMapFrame.dataset.src;
  history.replaceState(null, '', '#togkart');
  $('close-train-map').focus();
}

function hideTrainMap() {
  $('train-map-view').hidden = true;
  $('overview-view').hidden = false;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  menuToggle.focus();
}

menuToggle.addEventListener('click', () => setMenuOpen(siteMenuPanel.hidden));
$('open-train-map').addEventListener('click', showTrainMap);
$('close-train-map').addEventListener('click', hideTrainMap);
trainMapFrame.addEventListener('load', () => $('train-map-loading').classList.add('loaded'));
siteMenuPanel.addEventListener('click', e => {
  if (e.target.closest('a')) setMenuOpen(false);
});
document.addEventListener('click', e => {
  if (!e.target.closest('.site-menu')) setMenuOpen(false);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !siteMenuPanel.hidden) {
    setMenuOpen(false);
    menuToggle.focus();
  }
});
if (location.hash === '#togkart') showTrainMap();

async function checkForUpdates() {
  if (updateCheckRunning || $('results').hidden || !$('location').dataset.code) return;
  if ($('date').value !== localDate(new Date()) || document.hidden) return;
  updateCheckRunning = true;
  try {
    const requestedCode = $('location').dataset.code;
    const checkFrom = autoFromNow ? localTime(new Date()) : ($('from').value || '00:00');
    const d = await queryTrains(currentTrainQuery(checkFrom));
    const signature = dataSignature(d);
    if ($('location').dataset.code !== requestedCode) return;
    if (lastDataSignature !== null && signature !== lastDataSignature) $('update-notice').hidden = false;
  } catch (_) {
    // Bakgrunnssjekk skal aldri forstyrre brukeren.
  } finally {
    updateCheckRunning = false;
  }
}


$('filter-open').addEventListener('click', () => { renderFilterOptions(); $('filter-dialog').showModal(); });
$('filter-close').addEventListener('click', () => $('filter-dialog').close());
$('filter-done').addEventListener('click', () => $('filter-dialog').close());
$('filter-reset').addEventListener('click', resetFilters);
$('filter-dialog').addEventListener('click', e => { if (e.target === $('filter-dialog')) $('filter-dialog').close(); });

function updateBoardModeControls() {
  for(const [id,mode] of [['show-arrivals','arrival'],['show-departures','departure'],['show-both','both']]) {
    const active=boardMode===mode;
    $(id).classList.toggle('active',active);
    $(id).setAttribute('aria-pressed',String(active));
  }
  $('time-heading').textContent = boardMode === 'arrival' ? 'Ankomst' : boardMode === 'departure' ? 'Avgang' : 'Tid';
}

function setBoardMode(mode) {
  if (!['arrival','departure','both'].includes(mode)) return;
  boardMode = mode;
  boardModeManuallySelected = true;
  updateBoardModeControls();
  if ($('location').dataset.code) loadTrains(false);
}

$('show-arrivals').addEventListener('click', () => setBoardMode('arrival'));
$('show-departures').addEventListener('click', () => setBoardMode('departure'));
$('show-both').addEventListener('click', () => setBoardMode('both'));

function refreshTrains() {
  if (autoFromNow && $('date').value === localDate(new Date())) $('from').value = localTime(new Date());
  loadTrains();
}
$('source-card').addEventListener('click', refreshTrains);
$('source-card').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refreshTrains(); }
});

$('apply-update').addEventListener('click', refreshTrains);

setInterval(checkForUpdates, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdates(); });
