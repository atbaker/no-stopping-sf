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
export function filterPermits(permits, filters) {
  const query = (filters.query || '').trim().toLowerCase();
  return permits.filter(p =>
    (!query || [p.address,p.number,p.account].some(v => (v || '').toLowerCase().includes(query))) &&
    (!filters.date || dateState(p, filters.date) === 'covering') &&
    (!filters.tow || p.tow_status === filters.tow) &&
    (!filters.type || p.type === filters.type) &&
    (!filters.neighborhood || p.neighborhood === filters.neighborhood));
}
export function summarize(permits) {
  return {total: permits.length, enforceable: permits.filter(p=>p.tow_status==='Enforceable').length,
    not_enforceable: permits.filter(p=>p.tow_status==='Not Enforceable').length,
    unknown: permits.filter(p=>!['Enforceable','Not Enforceable'].includes(p.tow_status)).length,
    mapped: permits.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lng)).length};
}
