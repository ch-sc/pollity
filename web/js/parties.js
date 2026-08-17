// Party metadata: canonical display order and domain colors (validated for
// light/dark surfaces with the dataviz palette validator; Union black and
// Sonstige gray are deliberate domain-color exceptions — identity relief is
// carried by the legend, direct end-labels, tooltips and the table view).

export const PARTY_ORDER = [
  'CDU/CSU', 'CDU', 'CSU', 'SPD', 'GRÜNE', 'FDP', 'LINKE', 'AfD', 'BSW',
  'FW', 'PIRATEN', 'SSW', 'NPD', 'REP', 'DVU', 'BIW/BD', 'BIW', 'Schill',
  'Sonstige', 'Nichtwähler/Unentschl.',
];

// Meta-series (not party shares of decided voters). Drawn dashed as the
// secondary encoding, since they are deliberately de-emphasized grays/slates.
export const DASHED = new Set(['Nichtwähler/Unentschl.']);

// Short names for tight spots (chart end-labels).
const SHORT = { 'Nichtwähler/Unentschl.': 'Nichtw.' };
export function shortName(party) {
  return SHORT[party] || party;
}

const COLORS = {
  'CDU/CSU': { light: '#1f1f1f', dark: '#cfcfcf' },
  'CDU':     { light: '#1f1f1f', dark: '#cfcfcf' },
  'CSU':     { light: '#1f1f1f', dark: '#cfcfcf' },
  'SPD':     { light: '#c50014', dark: '#ff5058' },
  'GRÜNE':   { light: '#65a30d', dark: '#7bc043' },
  'FDP':     { light: '#d4af00', dark: '#ffd94d' },
  'LINKE':   { light: '#be3075', dark: '#e0629f' },
  'AfD':     { light: '#0f7ec2', dark: '#38a8e8' },
  'BSW':     { light: '#7d1f7d', dark: '#c45fc0' },
  'FW':      { light: '#b45309', dark: '#c9631a' },
  'PIRATEN': { light: '#0d9488', dark: '#14b8a6' },
  'SSW':     { light: '#2e5e9e', dark: '#6f9fd8' },
  'NPD':     { light: '#6b4423', dark: '#a97e56' },
  'REP':     { light: '#8a6b2f', dark: '#b99a5e' },
  'DVU':     { light: '#7a5230', dark: '#ad835f' },
  'BIW/BD':  { light: '#4c6b8a', dark: '#8fb0cf' },
  'BIW':     { light: '#4c6b8a', dark: '#8fb0cf' },
  'Schill':  { light: '#5b21b6', dark: '#a78bfa' },
  'Sonstige':{ light: '#898781', dark: '#8f8d87' },
  'Nichtwähler/Unentschl.': { light: '#54718c', dark: '#8aa7c4' },
};

// Fallback slots for parties we have no mapping for (regional one-offs).
const FALLBACK = [
  { light: '#0e7490', dark: '#22d3ee' },
  { light: '#9d174d', dark: '#f472b6' },
  { light: '#4d7c0f', dark: '#a3e635' },
  { light: '#6d28d9', dark: '#c4b5fd' },
];
const assigned = new Map();

export function partyColor(party, mode) {
  if (COLORS[party]) return COLORS[party][mode];
  if (!assigned.has(party)) assigned.set(party, FALLBACK[assigned.size % FALLBACK.length]);
  return assigned.get(party)[mode];
}

export function sortParties(parties) {
  return [...parties].sort((a, b) => {
    const ia = PARTY_ORDER.indexOf(a), ib = PARTY_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b, 'de');
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}
