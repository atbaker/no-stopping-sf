const sfClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const weekdays = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function sfDateTime(now) {
  const parts = sfClock.formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday'),
    time: `${get('hour')}:${get('minute')}`,
  };
}

export function sfToday(now = new Date()) {
  return sfDateTime(now).date;
}
export function dateState(p, date) {
  if (!p.start_date || !p.end_date || p.start_date > p.end_date) return 'unknown';
  if (date < p.start_date) return 'upcoming';
  if (date > p.end_date) return 'ended';
  return 'covering';
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const utc = new Date(date + 'T00:00:00Z');
  return Number.isFinite(utc.getTime()) && utc.toISOString().slice(0, 10) === date;
}

function scheduleState(permit, local) {
  const { tow_start_date: start, tow_end_date: end, tow_segments: segments } = permit;
  if (!validDate(start) || !validDate(end) || start > end) return 'unknown';
  if (local.date < start || local.date > end) return 'outside_dates';
  if (!Array.isArray(segments) || !segments.length) return 'unknown';

  let hasSchedule = false;
  let hasUnknown = false;
  for (const segment of segments) {
    if (segment?.status === 'no_tow_signs') continue;
    if (segment?.status === 'all_day') return 'within_hours';
    const { weekdays: days, start_time: from, end_time: to } = segment ?? {};
    if (segment?.status !== 'listed' || !Array.isArray(days) || !days.length ||
        !days.every(day => weekdays.has(day)) || typeof from !== 'string' || typeof to !== 'string' ||
        !clockTime.test(from) || !clockTime.test(to) || from >= to) {
      hasUnknown = true;
      continue;
    }
    hasSchedule = true;
    if (days.includes(local.weekday) && local.time >= from && local.time < to) {
      return 'within_hours';
    }
  }
  if (hasUnknown) return 'unknown';
  return hasSchedule ? 'outside_hours' : 'no_tow_signs';
}

// Classify the listed schedule independently of the city's reported Tow Status.
// "Outside hours" requires an in-range date and all applicable segments to be confidently off.
export function permitScheduleState(permit, at = new Date()) {
  return scheduleState(permit, sfDateTime(at));
}

// Great-circle distance in meters between two {lat, lng} points.
export function distanceMeters(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}
export function filterPermits(permits, filters) {
  const query = (filters.query || '').trim().toLowerCase();
  const local = filters.schedule ? sfDateTime(filters.at ?? new Date()) : null;
  return permits.filter(p =>
    (!query || [p.address,p.number,p.account].some(v => (v || '').toLowerCase().includes(query))) &&
    (!filters.date || dateState(p, filters.date) === 'covering') &&
    (!filters.tow || p.tow_status === filters.tow) &&
    (!local || scheduleState(p, local) === filters.schedule) &&
    (!filters.type || p.type === filters.type) &&
    (!filters.neighborhood || p.neighborhood === filters.neighborhood) &&
    (!filters.bounds || (Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= filters.bounds.south &&
      p.lat <= filters.bounds.north && p.lng >= filters.bounds.west && p.lng <= filters.bounds.east)));
}
export function summarize(permits) {
  return {total: permits.length, enforceable: permits.filter(p=>p.tow_status==='Enforceable').length,
    not_enforceable: permits.filter(p=>p.tow_status==='Not Enforceable').length,
    unknown: permits.filter(p=>!['Enforceable','Not Enforceable'].includes(p.tow_status)).length,
    mapped: permits.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)).length};
}
// Neighborhoods ranked by share of enforceable permits. Small samples and unmapped permits are left out
// so a neighborhood with one or two permits can't top the list at 0% or 100%.
export function rankNeighborhoods(permits, {minPermits = 10, count = 3} = {}) {
  const rows = new Map();
  for (const p of permits) {
    if (!p.neighborhood || p.neighborhood === 'Unmapped') continue;
    const row = rows.get(p.neighborhood) ?? {name:p.neighborhood, total:0, enforceable:0};
    row.total++; if (p.tow_status === 'Enforceable') row.enforceable++;
    rows.set(p.neighborhood, row);
  }
  const eligible = [...rows.values()].filter(r => r.total >= minPermits).map(r => ({...r, share:r.enforceable/r.total}));
  const top = [...eligible].sort((a,b) => b.share-a.share || b.total-a.total || a.name.localeCompare(b.name)).slice(0, count);
  const bottom = [...eligible].sort((a,b) => a.share-b.share || b.total-a.total || a.name.localeCompare(b.name))
    .filter(r => !top.includes(r)).slice(0, count);
  return {top, bottom, eligible:eligible.length};
}

// The `count` mapped permits nearest to `point`, nearest first.
export function nearestPermits(permits, point, count = 10) {
  return permits.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map(p => ({p, d: distanceMeters(p, point)})).sort((a, b) => a.d - b.d).slice(0, count).map(r => r.p);
}
