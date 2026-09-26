import { searchLocations as searchLocationData, nearestLocation, queryTrains, trainDetail } from './data.js';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const osloDateFmt = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'});
const osloTimeFmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
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
const hiddenCategories = new Set();
const hiddenTracks = new Set();

function rowClass(x) {
  const s = String(x.status || '').toLowerCase();
  if (s.includes('innstilt')) return 'cancelled';
  if (s.includes('forsinket')) return 'delayed';
  if (s.includes('passert')) return 'passed';
  return 'ontime';
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('innstilt')) return 'cancelled';
  if (s.includes('forsinket')) return 'delayed';
  if (s.includes('passert')) return 'passed';
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
    x.platform, x.status, x.current_location
  ]));
}

function currentTrainParams() {
  return new URLSearchParams({
    location: $('location').value.trim(),
    location_code: $('location').dataset.code || '',
    date: $('date').value,
    from_time: $('from').value || '00:00',
    to_time: $('to').value || '23:59',
  });
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

function chooseSuggestion(index) {
  const x = suggestions[index];
  if (!x) return;
  $('location').value = x.name;
  $('location').dataset.code = x.code;
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
  if (String(x.status || '').includes('Innstilt')) return `<span class="main-time cancelled-time">${esc(x.planned_time || x.time)}</span>`;
  const sub = delayed && x.planned_time ? `<small>Planlagt ${esc(x.planned_time)}</small>` : '';
  return `<span class="main-time">${esc(x.time)}</span>${sub}`;
}

function statusCell(x) {
  const s = String(x.status || '');
  if (s.includes('Innstilt')) return '<strong>Innstilt</strong>';
  if (s.includes('Forsinket')) {
    const match = s.match(/\+(\d+) min/);
    const delay = match ? `+${match[1]} min` : 'Forsinket';
    return `<strong>${esc(delay)}</strong>`;
  }
  if (s.includes('Passert')) return '<strong>Passert</strong>';
  return `<strong>${esc(s || 'I rute')}</strong>`;
}

function categoryLabel(value) {
  return value === 'Persontog' ? 'Passasjertog' : (value || 'Ukjent');
}

function trackKey(x) {
  return String(x.platform || '–');
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
    $('rows').innerHTML = `<tr><td colspan="7" class="empty">${lastTrainItems.length ? 'Ingen tog samsvarer med filteret.' : 'Ingen tog funnet i valgt tidsrom.'}</td></tr>`;
    updateFilterSummary();
    return;
  }
  $('rows').innerHTML = items.map(x => `<tr class="train-row ${rowClass(x)}" tabindex="0" data-id="${esc(x.journey_id)}">
    <td class="time time-cell">${timeCell(x)}</td>
    <td class="trainno train-cell">${esc(x.train_no)}${x.line && x.line !== '-' ? `<small>${esc(x.line)}</small>` : ''}</td>
    <td class="track-cell"><span class="track-label">Spor </span>${esc(x.platform || '–')}</td>
    <td class="type-text type-cell">${esc(x.category)}</td>
    <td class="operator-cell">${esc(x.operator)}</td>
    <td class="direction route-cell">${esc(x.origin)} <span>→</span> ${esc(x.destination)}</td>
    <td class="status-text status-cell">${statusCell(x)}</td>
  </tr>`).join('');
  bindTrainRows();
  updateFilterSummary();
}

function updateFilterSummary() {
  const count = hiddenCategories.size + hiddenTracks.size;
  $('filter-summary').textContent = count ? `${count} filter${count === 1 ? '' : 'e'} aktiv` : 'Alle tog og spor';
}

function renderFilterOptions() {
  const cats = [...new Set(lastTrainItems.map(x => x.category || 'Ukjent'))].sort((a,b) => categoryLabel(a).localeCompare(categoryLabel(b), 'no'));
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

async function loadTrains() {
  if (autoFromNow && $('date').value === localDate(new Date())) {
    $('from').value = localTime(new Date());
    syncPickerButtons();
  }
  $('rows').innerHTML = '<tr><td colspan="7" class="empty"><span class="spinner"></span> Henter Bane NOR-data …</td></tr>';
  try {
    const d = await queryTrains({
      locationCode: $('location').dataset.code || '',
      location: $('location').value.trim(),
      date: $('date').value,
      fromTime: $('from').value || '00:00',
      toTime: $('to').value || '23:59',
      today: localDate(new Date()),
    });
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
    $('source').textContent = 'Oppdater';
    $('updated').textContent = formatSourceTime(d.source_time);
    $('welcome').hidden = true;
    $('results').hidden = false;
    renderTrainRows();
  } catch (e) {
    $('welcome').hidden = true;
    $('results').hidden = false;
    $('rows').innerHTML = `<tr><td colspan="7" class="empty error">${esc(e.message)}</td></tr>`;
  }
}
function routeTime(stop) {
  if (stop.status === 'Passert') return `${esc(stop.actual || stop.expected || stop.planned || '–')} · Passert`;
  if (stop.actual) return `${esc(stop.actual)}`;
  if (stop.expected && stop.planned && stop.expected !== stop.planned) return `${esc(stop.expected)} · Planlagt ${esc(stop.planned)}`;
  if (stop.expected) return `${esc(stop.expected)}`;
  if (stop.planned) return `${esc(stop.planned)} · Planlagt`;
  return 'Tid ikke oppgitt';
}

async function openDetail(journeyId, force=false) {
  const dialog = $('detail');
  $('detail-content').innerHTML = '<div class="detail-loading"><span class="spinner"></span> Henter togrute …</div>';
  if (!dialog.open) dialog.showModal();
  try {
    const item = lastTrainItems.find(x => x.journey_id === journeyId) || null;
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
      return `<div class="route-stop ${cls} ${stop.selected ? 'selected' : ''}">
        <div class="route-marker"></div>
        <div><strong>${esc(stop.name)} <small>${esc(stop.code || '')}</small></strong>
        <span>${routeTime(stop)}${stop.platform ? ` · spor ${esc(stop.platform)}` : ''}${stop.status === 'Innstilt' ? ' · innstilt' : ''}</span></div>
      </div>`;
    }).join('');
    $('detail-content').innerHTML = `
      <div class="detail-head"><div><div class="kicker">${esc(x.category)}</div><h2>Tog ${esc(x.train_no)}</h2><p>${esc(x.origin)} → ${esc(x.destination)}</p></div><button id="detail-refresh" class="detail-refresh" type="button">Oppdater</button></div>
      <div class="detail-grid">
        <div><span>Operatør</span><strong>${esc(x.operator)}</strong></div>
        <div><span>Status ved valgt punkt</span><strong>${esc(x.status)}</strong></div>
        <div><span>Siste registrerte punkt</span><strong>${esc(x.current_location)}</strong></div>
      </div>
      <h3>Rute og registrerte passeringer</h3>
      <div class="route">${route || '<p class="muted">Ingen rutepunkter tilgjengelig.</p>'}</div>`;
    const refresh = $('detail-refresh');
    if (refresh) refresh.onclick = () => openDetail(journeyId, true);
  } catch (e) {
    $('detail-content').innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
$('location').addEventListener('input', () => {
  $('location').dataset.code = '';
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
let pickerTarget = null;
let calendarCursor = new Date();

function formatDateButton(value) {
  const [y,m,d] = value.split('-').map(Number);
  return `${d}. ${monthNames[m-1]} ${y}`;
}
function syncPickerButtons() {
  $('date-display').textContent = formatDateButton($('date').value);
  $('from-display').textContent = $('from').value;
  $('to-display').textContent = $('to').value;
}
function openPicker(target) {
  pickerTarget = target;
  if (target === 'date') {
    const [y,m,d] = $('date').value.split('-').map(Number);
    calendarCursor = new Date(y,m-1,d);
    renderCalendar();
  } else renderTimePicker(target);
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
function renderTimePicker(target) {
  const input=$(target);
  let [h,m]=input.value.split(':').map(Number);
  $('picker-title').textContent=target==='from'?'Velg fra-tid':'Velg til-tid';
  $('picker-body').innerHTML=`<div class="time-stepper"><div><button data-dh="1">+</button><strong id="pick-hour">${pad(h)}</strong><button data-dh="-1">−</button><span>time</span></div><b>:</b><div><button data-dm="5">+</button><strong id="pick-minute">${pad(m)}</strong><button data-dm="-5">−</button><span>min</span></div></div><div class="time-quick"><button data-time="00:00">00:00</button><button data-time="06:00">06:00</button><button data-time="12:00">12:00</button><button data-time="18:00">18:00</button><button data-time="23:59">23:59</button></div><button id="time-done" class="picker-done" type="button">Ferdig</button>`;
  const paint=()=>{$('pick-hour').textContent=pad(h);$('pick-minute').textContent=pad(m);};
  document.querySelectorAll('[data-dh]').forEach(b=>b.onclick=()=>{h=(h+Number(b.dataset.dh)+24)%24;paint();});
  document.querySelectorAll('[data-dm]').forEach(b=>b.onclick=()=>{m=(m+Number(b.dataset.dm)+60)%60;paint();});
  document.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{[h,m]=b.dataset.time.split(':').map(Number);paint();});
  $('time-done').onclick=()=>{input.value=`${pad(h)}:${pad(m)}`;if(target==='from') autoFromNow=false;syncPickerButtons();$('value-picker').close();if($('location').dataset.code) loadTrains();};
}
$('date-display').onclick=()=>openPicker('date');
$('from-display').onclick=()=>openPicker('from');
$('to-display').onclick=()=>openPicker('to');
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
      hideSuggestions();
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
    title: 'Togoversikt.no',
    text: 'Se tog, passeringer og trafikkstatus på Togoversikt.no',
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

async function checkForUpdates() {
  if (updateCheckRunning || $('results').hidden || !$('location').dataset.code) return;
  if ($('date').value !== localDate(new Date()) || document.hidden) return;
  updateCheckRunning = true;
  try {
    const r = await fetch(`/api/trains?${currentTrainParams()}`);
    if (!r.ok) return;
    const d = await r.json();
    const signature = dataSignature(d);
    if (lastDataSignature !== null && signature !== lastDataSignature) {
      $('update-notice').hidden = false;
    }
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

function refreshTrains() {
  if (autoFromNow && $('date').value === localDate(new Date())) $('from').value = localTime(new Date());
  loadTrains();
}
$('source-card').addEventListener('click', refreshTrains);
$('source-card').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refreshTrains(); }
});

$('apply-update').addEventListener('click', () => {
  if (autoFromNow && $('date').value === localDate(new Date())) $('from').value = localTime(new Date());
  loadTrains();
});

setInterval(checkForUpdates, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdates(); });
