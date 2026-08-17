// Trend estimation and house-effect (institute bias) correction.
//
// Polls are noisy samples of a latent voting intention; institutes differ in
// method and show systematic offsets ("house effects", Jackman 2005,
// "Pooling the polls over an election campaign"). We offer four estimators,
// all computed client-side so the user can switch live:
//
//  raw        — Gaussian kernel trend over the unadjusted polls.
//  meandev    — one-shot mean-deviation correction (dkriesel-style): a house's
//               bias per party is its average deviation from the cross-institute
//               trend; subtract it, re-estimate the trend.
//  iterative  — alternate trend and bias estimation until convergence: a
//               fixed-point approximation of the state-space MLE where the
//               kernel smoother plays the latent state. Biases are centered
//               (poll-count-weighted) per party for identifiability.
//  anchored   — election-anchored bias (Jackman's anchor idea): a house's bias
//               is its average final-poll error vs. actual election results;
//               houses without pre-election polls fall back to the iterative
//               estimate.
//
// Bias estimates are shrunk toward 0 with factor n/(n+k) (empirical-Bayes
// flavored) so institutes with few polls are not over-corrected.

const MS_DAY = 86400000;
const SHRINK_K = 5;
const MIN_OBS = 2;

function kernelWeight(dtDays, bwDays) {
  const z = dtDays / bwDays;
  return Math.exp(-0.5 * z * z);
}

/** Weighted Gaussian-kernel local mean per party, evaluated on a time grid. */
export function kernelTrend(polls, parties, grid, bwDays) {
  const trend = {};
  for (const party of parties) {
    const pts = [];
    for (const p of polls) {
      const v = p.results[party];
      if (v !== undefined && v !== null) {
        pts.push([p.t, v, Math.sqrt((p.sample || 1000) / 1000)]);
      }
    }
    const out = new Array(grid.length).fill(null);
    if (pts.length) {
      const cutoff = 5 * bwDays * MS_DAY;
      let lo = 0;
      for (let i = 0; i < grid.length; i++) {
        const t = grid[i];
        while (lo < pts.length && pts[lo][0] < t - cutoff) lo++;
        let sw = 0, swv = 0, n = 0;
        for (let j = lo; j < pts.length && pts[j][0] <= t + cutoff; j++) {
          const w = kernelWeight((pts[j][0] - t) / MS_DAY, bwDays) * pts[j][2];
          sw += w; swv += w * pts[j][1]; n++;
        }
        // Require real local support: no line where there were no polls nearby.
        out[i] = (n >= 1 && sw > 0.02) ? swv / sw : null;
      }
    }
    trend[party] = out;
  }
  return trend;
}

/** Linear interpolation of a trend array onto an arbitrary time. */
function trendAt(grid, values, t) {
  if (!values) return null;
  let lo = 0, hi = grid.length - 1;
  if (t <= grid[0]) return values[0];
  if (t >= grid[hi]) return values[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= t) lo = mid; else hi = mid;
  }
  const a = values[lo], b = values[hi];
  if (a === null || b === null) return a !== null ? a : b;
  const f = (t - grid[lo]) / (grid[hi] - grid[lo]);
  return a + f * (b - a);
}

/** Per-institute, per-party mean deviation from a reference trend. */
function estimateBias(polls, parties, grid, trend) {
  const acc = new Map(); // inst -> party -> [sum, n]
  for (const p of polls) {
    let m = acc.get(p.institute);
    if (!m) acc.set(p.institute, (m = {}));
    for (const party of parties) {
      const v = p.results[party];
      if (v === undefined || v === null) continue;
      const ref = trendAt(grid, trend[party], p.t);
      if (ref === null) continue;
      (m[party] ??= [0, 0]);
      m[party][0] += v - ref;
      m[party][1] += 1;
    }
  }
  const bias = new Map();
  for (const [inst, m] of acc) {
    const b = {};
    for (const party in m) {
      const [sum, n] = m[party];
      if (n >= MIN_OBS) b[party] = (sum / n) * (n / (n + SHRINK_K));
    }
    bias.set(inst, b);
  }
  return bias;
}

/** Center biases per party (weighted by each institute's poll count) so the
 *  corrections cancel across the field — identifiability constraint. */
function centerBias(bias, polls, parties) {
  const counts = new Map();
  for (const p of polls) counts.set(p.institute, (counts.get(p.institute) || 0) + 1);
  for (const party of parties) {
    let sw = 0, swb = 0;
    for (const [inst, b] of bias) {
      if (b[party] !== undefined) { const w = counts.get(inst) || 0; sw += w; swb += w * b[party]; }
    }
    if (sw > 0) {
      const mean = swb / sw;
      for (const [, b] of bias) if (b[party] !== undefined) b[party] -= mean;
    }
  }
  return bias;
}

function applyBias(polls, bias) {
  return polls.map(p => {
    const b = bias.get(p.institute);
    if (!b) return p;
    const results = {};
    for (const party in p.results) {
      const v = p.results[party];
      results[party] = b[party] !== undefined ? Math.max(0, v - b[party]) : v;
    }
    return { ...p, results, raw: p.raw || p.results };
  });
}

/** Election-anchored bias: average error of an institute's final pre-election
 *  polls (within `windowDays` before each election) vs. the actual result. */
function anchoredBias(polls, parties, elections, windowDays = 45) {
  const acc = new Map();
  for (const e of elections) {
    const et = e.t;
    // last poll per institute inside the window
    const last = new Map();
    for (const p of polls) {
      if (p.t <= et && p.t >= et - windowDays * MS_DAY) {
        const prev = last.get(p.institute);
        if (!prev || p.t > prev.t) last.set(p.institute, p);
      }
    }
    for (const [inst, p] of last) {
      let m = acc.get(inst);
      if (!m) acc.set(inst, (m = {}));
      for (const party of parties) {
        const v = p.results[party], r = e.results[party];
        if (v === undefined || r === undefined) continue;
        (m[party] ??= [0, 0]);
        m[party][0] += v - r;
        m[party][1] += 1;
      }
    }
  }
  const bias = new Map();
  for (const [inst, m] of acc) {
    const b = {};
    for (const party in m) {
      const [sum, n] = m[party];
      b[party] = (sum / n) * (n / (n + 1)); // gentle shrink; few anchor points
    }
    bias.set(inst, b);
  }
  return bias;
}

export function makeGrid(t0, t1, n = 360) {
  const grid = new Array(n);
  for (let i = 0; i < n; i++) grid[i] = t0 + (i * (t1 - t0)) / (n - 1);
  return grid;
}

/**
 * Run the full pipeline.
 * @returns {{trend, polls, bias}} trend per party on `grid`, bias-corrected
 * polls (for the scatter layer), and the bias table (Map inst -> {party: pp}).
 */
export function compute(algorithm, polls, parties, elections, grid, bwDays) {
  if (algorithm === 'raw' || polls.length === 0) {
    return { trend: kernelTrend(polls, parties, grid, bwDays), polls, bias: null };
  }
  if (algorithm === 'anchored') {
    let bias = anchoredBias(polls, parties, elections);
    // Institutes without anchor data: fall back to one iterative pass.
    const trend0 = kernelTrend(applyBias(polls, bias), parties, grid, bwDays);
    const residual = centerBias(
      estimateBias(applyBias(polls, bias), parties, grid, trend0), polls, parties);
    for (const [inst, rb] of residual) {
      if (!bias.has(inst)) bias.set(inst, rb);
    }
    const corrected = applyBias(polls, bias);
    return { trend: kernelTrend(corrected, parties, grid, bwDays), polls: corrected, bias };
  }
  const rounds = algorithm === 'iterative' ? 6 : 1;
  let corrected = polls;
  let bias = new Map();
  for (let r = 0; r < rounds; r++) {
    const trend = kernelTrend(corrected, parties, grid, bwDays);
    const delta = estimateBias(corrected, parties, grid, trend);
    // accumulate: bias += delta
    for (const [inst, d] of delta) {
      const b = bias.get(inst) || {};
      for (const party in d) b[party] = (b[party] || 0) + d[party];
      bias.set(inst, b);
    }
    centerBias(bias, polls, parties);
    corrected = applyBias(polls, bias);
  }
  return { trend: kernelTrend(corrected, parties, grid, bwDays), polls: corrected, bias };
}
