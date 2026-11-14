const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatDays(days) {
  const ranges = [];
  for (const day of days ?? []) {
    const index = WEEKDAYS.indexOf(day);
    const last = ranges.at(-1);
    if (last && index === last[1] + 1) last[1] = index;
    else ranges.push([index, index]);
  }
  if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === 6) return 'Daily';
  return ranges.map(([first, last]) =>
    first === last ? WEEKDAYS[first] : `${WEEKDAYS[first]}–${WEEKDAYS[last]}`).join(', ');
}

function formatTime(time) {
  if (!time) return '';
  const [hour, minute] = time.split(':');
  return `${Number(hour) % 12 || 12}:${minute} ${Number(hour) < 12 ? 'a.m.' : 'p.m.'}`;
}

export function scheduleText(segment) {
  if (segment.status === 'no_tow_signs') return 'City record says no tow signs needed';
  if (segment.status === 'all_day') return '24 hours daily';
  const days = formatDays(segment.weekdays);
  const start = formatTime(segment.start_time);
  const end = formatTime(segment.end_time);
  const hours = start && end ? `${start}–${end}` : '';
  return [days, hours].filter(Boolean).join(', ') || 'Schedule unavailable';
}
