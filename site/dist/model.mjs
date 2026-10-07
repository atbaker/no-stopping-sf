export function sfToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function dateState(p, date) {
  if (!p.start_date || !p.end_date || p.start_date > p.end_date) return 'unknown';
  if (date < p.start_date) return 'upcoming';
  if (date > p.end_date) return 'ended';
  return 'covering';
}
// Great-circle distance in meters between two {lat, lng} points.
export function distanceMeters(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}
export function filterPermits(permits, filters) {
  const query = (filters.query || '').trim().toLowerCase();
  return permits.filter(p =>
    (!query || [p.address,p.number,p.account].some(v => (v || '').toLowerCase().includes(query))) &&
    (!filters.date || dateState(p, filters.date) === 'covering') &&
    (!filters.tow || p.tow_status === filters.tow) &&
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
