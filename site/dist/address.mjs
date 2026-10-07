// Search any SF address against the city's EAS address points (data/addresses.json, built by
// prepare_data.py). Normalization mirrors prepare_data.normalize, plus cleanup for typed input.
const SUFFIXES = {STREET:'ST', STR:'ST', AVENUE:'AVE', AV:'AVE', BOULEVARD:'BLVD', LANE:'LN', DRIVE:'DR', COURT:'CT',
  ROAD:'RD', TERRACE:'TER', PLACE:'PL', ALLEY:'ALY', CIRCLE:'CIR', HIGHWAY:'HWY', PLAZA:'PLZ', STAIRWAY:'STWY'};
const ORDINALS = {FIRST:'1ST', SECOND:'2ND', THIRD:'3RD', FOURTH:'4TH', FIFTH:'5TH', SIXTH:'6TH', SEVENTH:'7TH',
  EIGHTH:'8TH', NINTH:'9TH', TENTH:'10TH', ELEVENTH:'11TH', TWELFTH:'12TH'};

export function normalizeAddress(text) {
  let value = String(text ?? '').toUpperCase().replace(/[.'’]/g, '');
  value = value.split(',')[0];                                   // drop ", San Francisco, CA 94110"
  value = value.replace(/\s(#|APT|UNIT|STE|SUITE)\b.*$/, '');      // drop unit designators
  value = value.replace(/\s(SAN FRANCISCO|SF)(\sCA)?(\s\d{5})?$/, '').replace(/\sCA(\s\d{5})?$/, '').replace(/\s\d{5}$/, '');
  value = value.replace(/\s+/g, ' ').trim().replace(/^0+(?=\d)/, '').replace(/^(\d+)([A-Z])(?= )/, '$1 $2');
  value = value.split(' ').map((token, i) => i ? SUFFIXES[token] ?? ORDINALS[token] ?? token : token).join(' ');
  return value.replace(/\b0+(\d+(?:ST|ND|RD|TH))\b/g, '$1');
}

export const looksLikeAddress = text => /^\s*\d+[A-Za-z]?\s+[A-Za-z0-9]/.test(text ?? '');

const decoded = new WeakMap();
function decodeStreet(index, street) {
  let cache = decoded.get(index);
  if (!cache) decoded.set(index, cache = new Map());
  if (!cache.has(street)) {
    let [lat, lng] = index.base;
    cache.set(street, index.streets[street].split(';').map(part => {
      const [number, dlat, dlng] = part.split(',');
      lat += Number(dlat); lng += Number(dlng);
      return {number, address:`${number} ${street}`, lat:lat / 1e5, lng:lng / 1e5};
    }));
  }
  return cache.get(street);
}

// Exact house-number matches on streets matching what was typed ("MAIN" also finds "MAIN ST"). When no
// street has that exact number, offer the nearest number on file (within 100) for the best street instead.
export function suggestAddresses(index, text, limit = 5) {
  const match = normalizeAddress(text).match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?) (.+)$/);
  if (!index || !match) return [];
  const [, number, street] = match;
  // Exact street first, then completions with the fewest extra words (MISSION -> MISSION ST before MISSION BAY BLVD).
  const rank = name => name === street ? 0 : name.startsWith(street + ' ') ? 1 : name.startsWith(street) ? 2 : -1;
  const extra = name => name.split(' ').length - street.split(' ').length;
  const streets = Object.keys(index.streets).map(name => [name, rank(name)]).filter(([, r]) => r >= 0)
    .sort((a, b) => a[1] - b[1] || extra(a[0]) - extra(b[0]) || a[0].localeCompare(b[0])).map(([name]) => name).slice(0, 12);
  const exact = streets.flatMap(name => decodeStreet(index, name).filter(a => a.number === number))
    .slice(0, limit).map(a => ({...a, exact:true}));
  if (exact.length || !streets.length) return exact;
  const target = parseInt(number, 10);
  const nearest = decodeStreet(index, streets[0]).reduce((best, a) =>
    Math.abs(parseInt(a.number, 10) - target) < Math.abs(parseInt(best.number, 10) - target) ? a : best);
  return Math.abs(parseInt(nearest.number, 10) - target) <= 100 ? [{...nearest, exact:false}] : [];
}
