import { partyColor, sortParties, shortName, DASHED } from './parties.js';
import { compute, makeGrid } from './algorithms.js';
import { PollChart } from './chart.js';

const MS_DAY = 86400000;

const ALGORITHMS = [
  ['raw', 'Rohdaten (Kern-Trend)'],
  ['meandev', 'Mittelwert-Korrektur'],
  ['iterative', 'Iterative Hauseffekte'],
  ['anchored', 'Wahl-verankert'],
];

const ALGO_HELP = {
  raw: 'Gaußscher Kern-Trend über die unkorrigierten Umfragen. Institutsbedingte Verzerrungen (Hauseffekte) bleiben enthalten.',
  meandev: 'Hauseffekt = mittlere Abweichung eines Instituts vom institutsübergreifenden Trend (Ansatz wie bei dkriesel.com). Wird einmalig geschätzt und abgezogen.',
  iterative: 'Trend und Hauseffekte werden abwechselnd neu geschätzt bis zur Konvergenz — eine Fixpunkt-Näherung des State-Space-Modells von Jackman (2005, „Pooling the Polls"). Effekte werden pro Partei zentriert.',
  anchored: 'Hauseffekt = mittlerer Fehler der letzten Umfragen eines Instituts vor vergangenen Wahlen gegenüber dem amtlichen Ergebnis (Jackmans Verankerungs-Idee). Institute ohne Vorwahl-Umfragen erhalten den iterativen Schätzwert.',
};

const RANGES = [
  ['election', 'Seit letzter Wahl'],
  ['1y', '1 Jahr'],
  ['2y', '2 Jahre'],
  ['5y', '5 Jahre'],
  ['all', 'Alles'],
];

const SMOOTHING = [
  ['0.5', 'Fein'],
  ['1', 'Standard'],
  ['2', 'Glatt'],
];

const state = {
  region: 'bund',
  algo: 'iterative',
  range: 'election',
  lastPreset: 'election', // restored on double-click after a custom zoom
  from: null,             // ISO dates when range === 'custom'
  to: null,
  smoothing: '1',
  hiddenParties: new Set(),
  hiddenInstitutes: new Set(),
  showDots: true,
};

let renderRangesFn = null;

function isoDate(t) {
  return new Date(t).toISOString().slice(0, 10);
}

function setCustomRange(t0, t1) {
  state.range = 'custom';
  state.from = isoDate(t0);
  state.to = isoDate(t1);
  renderRangesFn?.();
  render();
}

const regionCache = new Map();
let index = null;
let chart = null;
let current = null; // loaded region data

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- URL hash

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('r')) state.region = h.get('r');
  if (h.get('a')) state.algo = h.get('a');
  if (h.get('t')) state.range = h.get('t');
  if (h.get('f')) state.from = h.get('f');
  if (h.get('b')) state.to = h.get('b');
  if (state.range === 'custom' && !(state.from && state.to)) state.range = 'election';
  if (state.range !== 'custom') state.lastPreset = state.range;
  if (h.get('s')) state.smoothing = h.get('s');
  if (h.get('hp')) state.hiddenParties = new Set(h.get('hp').split('|').filter(Boolean));
  if (h.get('hi')) state.hiddenInstitutes = new Set(h.get('hi').split('|').filter(Boolean));
  if (h.get('d') === '0') state.showDots = false;
}

function writeHash() {
  const h = new URLSearchParams();
  h.set('r', state.region);
  h.set('a', state.algo);
  h.set('t', state.range);
  if (state.range === 'custom' && state.from && state.to) {
    h.set('f', state.from);
    h.set('b', state.to);
  }
  if (state.smoothing !== '1') h.set('s', state.smoothing);
  if (state.hiddenParties.size) h.set('hp', [...state.hiddenParties].join('|'));
  if (state.hiddenInstitutes.size) h.set('hi', [...state.hiddenInstitutes].join('|'));
  if (!state.showDots) h.set('d', '0');
  history.replaceState(null, '', '#' + h.toString());
}

// ---------------------------------------------------------------- helpers

function mode() {
  const stamped = document.documentElement.dataset.theme;
  if (stamped) return stamped;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function inkTokens() {
  const css = getComputedStyle(document.documentElement);
  const get = n => css.getPropertyValue(n).trim();
  return {
    surface: get('--surface-1'), grid: get('--gridline'), baseline: get('--baseline'),
    muted: get('--text-muted'), text: get('--text-primary'),
    threshold: get('--threshold'), election: get('--election-line'),
    crosshair: get('--crosshair'), accent: get('--accent'),
  };
}

function fmtPP(v) {
  const s = (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', ',');
  return s;
}

function fmtPct(v) {
  return v.toFixed(1).replace('.', ',');
}

// ---------------------------------------------------------------- data

async function loadRegion(key) {
  if (regionCache.has(key)) return regionCache.get(key);
  const resp = await fetch(`data/regions/${key}.json`);
  const data = await resp.json();
  for (const p of data.polls) p.t = Date.parse(p.date);
  for (const e of data.elections) e.t = Date.parse(e.date);
  regionCache.set(key, data);
  return data;
}

// ---------------------------------------------------------------- pipeline

function computeView() {
  const data = current;
  const now = data.polls.length ? data.polls[data.polls.length - 1].t : Date.now();

  let t0, t1;
  if (state.range === 'custom' && state.from && state.to
      && Date.parse(state.to) > Date.parse(state.from)) {
    t0 = Date.parse(state.from);
    t1 = Date.parse(state.to) + MS_DAY; // inclusive end date
  } else {
    if (state.range === 'all') {
      t0 = data.polls.length ? data.polls[0].t : now - 365 * MS_DAY;
    } else if (state.range === 'election') {
      const past = data.elections.filter(e => e.t <= now);
      t0 = past.length ? past[past.length - 1].t : now - 4 * 365 * MS_DAY;
    } else {
      const years = { '1y': 1, '2y': 2, '5y': 5 }[state.range];
      t0 = now - years * 365 * MS_DAY;
    }
    t1 = now + Math.max(7 * MS_DAY, (now - t0) * 0.01);
  }

  const instAll = new Map();
  for (const p of data.polls) {
    if (p.t >= t0 && p.t <= t1) instAll.set(p.institute, (instAll.get(p.institute) || 0) + 1);
  }
  const polls = data.polls.filter(p =>
    p.t >= t0 && p.t <= t1 && !state.hiddenInstitutes.has(p.institute));

  const partyCounts = new Map();
  for (const p of polls) for (const k in p.results) partyCounts.set(k, (partyCounts.get(k) || 0) + 1);
  // Parties present in ≥2% of window polls (drops one-off fringe columns).
  const partiesAll = sortParties([...partyCounts.keys()]
    .filter(k => partyCounts.get(k) >= Math.max(2, polls.length * 0.02)));
  const parties = partiesAll.filter(p => !state.hiddenParties.has(p));

  // Bandwidth adapts to both the visible range and the poll density, so
  // sparse state-level series still yield a continuous, honest trend.
  const rangeDays = (t1 - t0) / MS_DAY;
  const avgGap = rangeDays / Math.max(1, polls.length);
  const bw = Math.min(150, Math.max(4, rangeDays / 80, 2.5 * avgGap)) * parseFloat(state.smoothing);
  const grid = makeGrid(t0, t1, 380);

  const elections = data.elections.filter(e => e.t >= t0 - 30 * MS_DAY && e.t <= t1);
  const result = compute(state.algo, polls, parties, data.elections, grid, bw);

  let ymax = 5;
  for (const party of parties) {
    for (const v of result.trend[party] || []) if (v !== null && v > ymax) ymax = v;
    for (const p of result.polls) {
      const v = p.results[party];
      if (v !== undefined && v > ymax) ymax = v;
    }
  }
  ymax = Math.min(100, Math.ceil((ymax + 2) / 5) * 5);

  return { polls, parties, partiesAll, instAll, grid, bw, t0, t1, ymax, elections, result };
}

function render() {
  if (!current) return;
  const view = computeView();
  const m = mode();
  chart.setState({
    grid: view.grid,
    trend: view.result.trend,
    polls: view.result.polls,
    series: view.parties.map(p => ({
      party: p,
      label: shortName(p),
      color: partyColor(p, m),
      dash: DASHED.has(p),
    })),
    elections: view.elections,
    t0: view.t0,
    t1: view.t1,
    ymax: view.ymax,
    ink: inkTokens(),
    showDots: state.showDots,
  });
  chart.hideTooltip();
  updateDateInputs(view);
  renderPartyChips(view, m);
  renderInstituteChips(view);
  renderBiasTable(view, m);
  renderPollTable(view, m);
  $('algo-help').textContent = ALGO_HELP[state.algo];
  writeHash();
}

// Mirror the effective range into the von–bis inputs (skip while typing).
function updateDateInputs(view) {
  const from = $('date-from'), to = $('date-to');
  if (document.activeElement !== from) from.value = isoDate(view.t0);
  if (document.activeElement !== to) to.value = isoDate(view.t1 - MS_DAY);
}

// ---------------------------------------------------------------- controls

function chip(label, active, onClick, colorDot) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (active ? ' active' : '');
  if (colorDot) {
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.style.background = colorDot;
    b.appendChild(dot);
  }
  b.appendChild(document.createTextNode(label));
  b.addEventListener('click', onClick);
  return b;
}

function renderPartyChips(view, m) {
  const el = $('party-filter');
  el.replaceChildren();
  for (const party of view.partiesAll) {
    const hidden = state.hiddenParties.has(party);
    el.appendChild(chip(party, !hidden, () => {
      hidden ? state.hiddenParties.delete(party) : state.hiddenParties.add(party);
      render();
    }, partyColor(party, m)));
  }
}

function renderInstituteChips(view) {
  const el = $('institute-filter');
  el.replaceChildren();
  const insts = [...view.instAll.entries()].sort((a, b) => b[1] - a[1]);
  for (const [inst, count] of insts) {
    const hidden = state.hiddenInstitutes.has(inst);
    el.appendChild(chip(`${inst} (${count})`, !hidden, () => {
      hidden ? state.hiddenInstitutes.delete(inst) : state.hiddenInstitutes.add(inst);
      render();
    }));
  }
}

function renderBiasTable(view, m) {
  const wrap = $('bias-wrap');
  const table = $('bias-table');
  table.replaceChildren();
  const bias = view.result.bias;
  if (!bias || bias.size === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  const counts = new Map();
  for (const p of view.polls) counts.set(p.institute, (counts.get(p.institute) || 0) + 1);
  const insts = [...bias.keys()].filter(i => counts.get(i)).sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(document.createElement('th')).textContent = 'Institut';
  for (const party of view.parties) {
    const th = document.createElement('th');
    const dot = document.createElement('span');
    dot.className = 'chip-dot';
    dot.style.background = partyColor(party, m);
    th.append(dot, document.createTextNode(party));
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const inst of insts) {
    const tr = document.createElement('tr');
    const td0 = document.createElement('td');
    td0.textContent = `${inst} (${counts.get(inst) || 0})`;
    tr.appendChild(td0);
    for (const party of view.parties) {
      const td = document.createElement('td');
      const v = bias.get(inst)?.[party];
      if (v === undefined || Math.abs(v) < 0.05) {
        td.textContent = v === undefined ? '–' : '±0,0';
        td.className = 'bias-zero';
      } else {
        td.textContent = fmtPP(v);
        td.className = v > 0 ? 'bias-pos' : 'bias-neg';
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function renderPollTable(view, m) {
  const table = $('poll-table');
  table.replaceChildren();
  const cap = 400;
  const polls = [...view.polls].reverse();

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['Datum', 'Institut', 'Auftraggeber', 'n']) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.appendChild(th);
  }
  for (const party of view.parties) {
    const th = document.createElement('th');
    th.textContent = party;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const p of polls.slice(0, cap)) {
    const tr = document.createElement('tr');
    const cells = [
      p.date.split('-').reverse().join('.'),
      p.institute,
      p.client || '–',
      p.sample ? p.sample.toLocaleString('de-DE') : '–',
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    for (const party of view.parties) {
      const td = document.createElement('td');
      const raw = (p.raw || p.results)[party];
      td.textContent = raw !== undefined ? fmtPct(raw) : '–';
      td.className = 'num';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  $('poll-table-note').textContent = polls.length > cap
    ? `Zeigt die ${cap} neuesten von ${polls.length} Umfragen (Rohwerte).`
    : `${polls.length} Umfragen (Rohwerte).`;
}

function buildStaticControls() {
  const rs = $('region-select');
  rs.replaceChildren();
  for (const r of index.regions) {
    const opt = document.createElement('option');
    opt.value = r.key;
    opt.textContent = r.level === 'federal' ? r.name : r.name;
    rs.appendChild(opt);
  }
  rs.value = state.region;
  rs.addEventListener('change', async () => {
    state.region = rs.value;
    state.hiddenParties.clear();
    state.hiddenInstitutes.clear();
    await switchRegion();
  });

  const as = $('algo-select');
  as.replaceChildren();
  for (const [k, label] of ALGORITHMS) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = label;
    as.appendChild(opt);
  }
  as.value = state.algo;
  as.addEventListener('change', () => { state.algo = as.value; render(); });

  const rr = $('range-buttons');
  const renderRanges = () => {
    rr.replaceChildren();
    for (const [k, label] of RANGES) {
      rr.appendChild(chip(label, state.range === k, () => {
        state.range = k;
        state.lastPreset = k;
        renderRanges();
        render();
      }));
    }
    $('date-range').classList.toggle('active', state.range === 'custom');
  };
  renderRangesFn = renderRanges;
  renderRanges();

  const applyDateInputs = () => {
    const f = $('date-from').value, b = $('date-to').value;
    if (f && b && Date.parse(b) > Date.parse(f)) setCustomRange(Date.parse(f), Date.parse(b));
  };
  $('date-from').addEventListener('change', applyDateInputs);
  $('date-to').addEventListener('change', applyDateInputs);

  const ss = $('smoothing-select');
  ss.replaceChildren();
  for (const [k, label] of SMOOTHING) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = label;
    ss.appendChild(opt);
  }
  ss.value = state.smoothing;
  ss.addEventListener('change', () => { state.smoothing = ss.value; render(); });

  const dots = $('dots-toggle');
  dots.checked = state.showDots;
  dots.addEventListener('change', () => { state.showDots = dots.checked; render(); });

  $('theme-toggle').addEventListener('click', () => {
    const next = mode() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('pollity-theme', next);
    render();
  });
}

async function switchRegion() {
  const data = await loadRegion(state.region);
  current = data;
  const meta = index.regions.find(r => r.key === state.region);
  $('source-link').href = data.source;
  $('data-stand').textContent = `Datenstand: ${new Date(index.scraped_at).toLocaleDateString('de-DE')}` +
    (meta?.last_poll ? ` · letzte Umfrage: ${meta.last_poll.split('-').reverse().join('.')}` : '');
  render();
}

async function main() {
  const saved = localStorage.getItem('pollity-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  readHash();
  chart = new PollChart($('chart'), $('tooltip'));
  chart.onRangeSelect = (t0, t1) => setCustomRange(t0, t1);
  chart.onRangeReset = () => {
    if (state.range === 'custom') {
      state.range = state.lastPreset;
      renderRangesFn?.();
      render();
    }
  };
  index = await (await fetch('data/index.json')).json();
  if (!index.regions.some(r => r.key === state.region)) state.region = 'bund';
  buildStaticControls();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
  await switchRegion();
}

main();
