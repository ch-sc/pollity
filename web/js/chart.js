// Canvas time-series chart: poll scatter + trend lines + election markers,
// with a crosshair tooltip (nearest-X readout of every visible series) and
// nearest-poll inspection when the pointer is close to a dot.

const MS_DAY = 86400000;
const PAD = { top: 16, right: 112, bottom: 30, left: 44 };

const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function fmtDate(t) {
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export class PollChart {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.tooltip = tooltipEl;
    this.ctx = canvas.getContext('2d');
    this.state = null;
    this.hoverX = null;
    this.base = document.createElement('canvas'); // static layers cache
    this.ro = new ResizeObserver(() => { this.dirty = true; this.render(); });
    this.ro.observe(canvas.parentElement);
    this.dragStart = null;   // px where a range-drag began
    this.dragX = null;
    this.dragging = false;
    this.onRangeSelect = null; // (t0, t1) => void — set by the app
    this.onRangeReset = null;  // () => void
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('dblclick', () => this.onRangeReset?.());
    canvas.addEventListener('pointerleave', () => {
      if (this.dragStart !== null) return; // captured drag continues
      this.hoverX = null; this.hideTooltip(); this.render();
    });
  }

  /** state: {grid, trend, polls, series:[{party,color}], elections, t0, t1,
   *          ymax, ink, showDots} */
  setState(state) {
    this.state = state;
    this.dirty = true;
    this.render();
  }

  xToT(x) {
    const { t0, t1 } = this.state;
    return t0 + ((x - PAD.left) / (this.w - PAD.left - PAD.right)) * (t1 - t0);
  }
  tx(t) {
    const { t0, t1 } = this.state;
    return PAD.left + ((t - t0) / (t1 - t0)) * (this.w - PAD.left - PAD.right);
  }
  vy(v) {
    return PAD.top + (1 - v / this.state.ymax) * (this.h - PAD.top - PAD.bottom);
  }

  render() {
    const c = this.canvas, parent = c.parentElement;
    if (!this.state || !parent) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = parent.clientWidth;
    this.h = parent.clientHeight;
    if (c.width !== this.w * dpr || c.height !== this.h * dpr) {
      c.width = this.w * dpr;
      c.height = this.h * dpr;
      c.style.width = this.w + 'px';
      c.style.height = this.h + 'px';
    }
    const s = this.state;
    const plotW = this.w - PAD.left - PAD.right;
    const plotH = this.h - PAD.top - PAD.bottom;
    if (plotW < 50 || plotH < 50) return;

    // Static layers (axes, dots, trends, labels) are cached offscreen so the
    // crosshair can redraw at pointer speed without repainting every mark.
    if (this.dirty || this.base.width !== c.width || this.base.height !== c.height) {
      this.base.width = c.width;
      this.base.height = c.height;
      const ctx = this.base.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      this.drawAxes(ctx, s, plotW, plotH);
      this.drawElections(ctx, s);
      if (s.showDots) this.drawDots(ctx, s);
      this.drawTrends(ctx, s);
      this.drawEndLabels(ctx, s);
      this.dirty = false;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.dragging && this.dragX !== null) this.drawSelection(ctx, s);
    else if (this.hoverX !== null) this.drawCrosshair(ctx, s);
  }

  drawAxes(ctx, s, plotW, plotH) {
    ctx.font = '11px system-ui, sans-serif';
    // y gridlines every clean step
    const step = s.ymax > 40 ? 10 : 5;
    ctx.lineWidth = 1;
    for (let v = 0; v <= s.ymax; v += step) {
      const y = Math.round(this.vy(v)) + 0.5;
      ctx.strokeStyle = v === 0 ? s.ink.baseline : s.ink.grid;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(this.w - PAD.right, y); ctx.stroke();
      ctx.fillStyle = s.ink.muted;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(v + ' %', PAD.left - 8, y);
    }
    // 5%-Hürde emphasis
    if (s.ymax >= 5) {
      const y = Math.round(this.vy(5)) + 0.5;
      ctx.strokeStyle = s.ink.threshold;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(this.w - PAD.right, y); ctx.stroke();
    }
    // x ticks: years, or months if range < ~2.2 years
    const rangeDays = (s.t1 - s.t0) / MS_DAY;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = s.ink.muted;
    if (rangeDays > 800) {
      const y0 = new Date(s.t0).getFullYear() + 1;
      const y1 = new Date(s.t1).getFullYear();
      const every = Math.max(1, Math.ceil((y1 - y0) / (plotW / 60)));
      for (let y = y0; y <= y1; y += every) {
        const t = Date.UTC(y, 0, 1);
        const x = this.tx(t);
        ctx.strokeStyle = s.ink.grid;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, PAD.top); ctx.lineTo(Math.round(x) + 0.5, this.h - PAD.bottom); ctx.stroke();
        ctx.fillText(String(y), x, this.h - PAD.bottom + 8);
      }
    } else {
      const d0 = new Date(s.t0);
      let y = d0.getFullYear(), m = d0.getMonth() + 1;
      const everyM = rangeDays > 400 ? 3 : (rangeDays > 150 ? 2 : 1);
      for (;;) {
        if (m > 11) { m = 0; y++; }
        const t = Date.UTC(y, m, 1);
        if (t > s.t1) break;
        if (m % everyM === 0) {
          const x = this.tx(t);
          ctx.strokeStyle = s.ink.grid;
          ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, PAD.top); ctx.lineTo(Math.round(x) + 0.5, this.h - PAD.bottom); ctx.stroke();
          ctx.fillText(`${MONTHS_DE[m]} ${String(y).slice(2)}`, x, this.h - PAD.bottom + 8);
        }
        m++;
      }
    }
  }

  drawElections(ctx, s) {
    for (const e of s.elections) {
      if (e.t < s.t0 || e.t > s.t1) continue;
      const x = Math.round(this.tx(e.t)) + 0.5;
      ctx.strokeStyle = s.ink.election;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, this.h - PAD.bottom); ctx.stroke();
      ctx.fillStyle = s.ink.muted;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('Wahl', x + 4, PAD.top);
      // result diamonds
      for (const ser of s.series) {
        const v = e.results[ser.party];
        if (v === undefined || v > s.ymax) continue;
        const y = this.vy(v);
        ctx.fillStyle = ser.color;
        ctx.strokeStyle = s.ink.surface;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
  }

  drawDots(ctx, s) {
    ctx.globalAlpha = 0.4;
    for (const ser of s.series) {
      ctx.fillStyle = ser.color;
      for (const p of s.polls) {
        const v = p.results[ser.party];
        if (v === undefined || p.t < s.t0 || p.t > s.t1 || v > s.ymax) continue;
        ctx.beginPath();
        ctx.arc(this.tx(p.t), this.vy(v), 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  drawTrends(ctx, s) {
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const ser of s.series) {
      const vals = s.trend[ser.party];
      if (!vals) continue;
      ctx.strokeStyle = ser.color;
      ctx.setLineDash(ser.dash ? [6, 5] : []);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < s.grid.length; i++) {
        const v = vals[i];
        if (v === null || s.grid[i] < s.t0 || s.grid[i] > s.t1) { pen = false; continue; }
        const x = this.tx(s.grid[i]), y = this.vy(Math.min(v, s.ymax));
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawEndLabels(ctx, s) {
    // Endpoint value labels live in a dedicated right margin (a value-ordered
    // label column); collisions resolve by minimal downward displacement so
    // the vertical order always matches the values.
    const ends = [];
    for (const ser of s.series) {
      const vals = s.trend[ser.party];
      if (!vals) continue;
      for (let i = s.grid.length - 1; i >= 0; i--) {
        if (vals[i] !== null && s.grid[i] <= s.t1) {
          const ty = this.vy(Math.min(vals[i], s.ymax));
          ends.push({ ser, v: vals[i], y: ty, trueY: ty });
          break;
        }
      }
    }
    ends.sort((a, b) => a.y - b.y);
    const MIN_GAP = 13;
    for (let i = 1; i < ends.length; i++) {
      if (ends[i].y - ends[i - 1].y < MIN_GAP) ends[i].y = ends[i - 1].y + MIN_GAP;
    }
    // push back up if we ran past the bottom
    const maxY = this.h - PAD.bottom - 4;
    for (let i = ends.length - 1; i >= 0; i--) {
      if (ends[i].y > maxY) ends[i].y = maxY;
      if (i < ends.length - 1 && ends[i + 1].y - ends[i].y < MIN_GAP) {
        ends[i].y = ends[i + 1].y - MIN_GAP;
      }
    }
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const e of ends) {
      const x = this.w - PAD.right + 8;
      // end marker dot with surface ring
      const vals = this.state.trend[e.ser.party];
      let lx = null;
      for (let i = this.state.grid.length - 1; i >= 0; i--) {
        if (vals[i] !== null && this.state.grid[i] <= this.state.t1) { lx = this.tx(this.state.grid[i]); break; }
      }
      if (lx !== null) {
        ctx.fillStyle = e.ser.color;
        ctx.strokeStyle = s.ink.surface;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(lx, e.trueY, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.fillStyle = e.ser.color;
      ctx.beginPath(); ctx.arc(x + 3, e.y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = s.ink.text;
      ctx.fillText(`${e.ser.label || e.ser.party} ${e.v.toFixed(1).replace('.', ',')}`, x + 10, e.y);
    }
  }

  drawSelection(ctx, s) {
    const x0 = Math.min(this.dragStart, this.dragX);
    const x1 = Math.max(this.dragStart, this.dragX);
    const yTop = PAD.top, yBot = this.h - PAD.bottom;
    ctx.fillStyle = s.ink.accent;
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = s.ink.accent;
    ctx.lineWidth = 1;
    for (const x of [x0, x1]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yTop);
      ctx.lineTo(Math.round(x) + 0.5, yBot);
      ctx.stroke();
    }
  }

  clampPlotX(px) {
    return Math.max(PAD.left, Math.min(this.w - PAD.right, px));
  }

  onDown(e) {
    if (!this.state || e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < PAD.left || px > this.w - PAD.right) return;
    this.dragStart = px;
    this.dragX = px;
    this.dragging = false;
    this.canvas.setPointerCapture(e.pointerId);
  }

  onUp(e) {
    if (this.dragStart === null) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const wasDrag = this.dragging;
    const a = Math.min(this.dragStart, this.dragX);
    const b = Math.max(this.dragStart, this.dragX);
    this.dragStart = null;
    this.dragX = null;
    this.dragging = false;
    if (wasDrag && this.onRangeSelect) {
      const t0 = this.xToT(a), t1 = this.xToT(b);
      if (t1 - t0 >= 3 * MS_DAY) { this.onRangeSelect(t0, t1); return; }
    }
    this.render();
  }

  drawCrosshair(ctx, s) {
    const x = Math.round(this.hoverX) + 0.5;
    ctx.strokeStyle = s.ink.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, this.h - PAD.bottom); ctx.stroke();
  }

  onMove(e) {
    if (!this.state) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (this.dragStart !== null) {
      this.dragX = this.clampPlotX(px);
      if (!this.dragging && Math.abs(this.dragX - this.dragStart) > 4) this.dragging = true;
      if (this.dragging) { this.hoverX = null; this.hideTooltip(); this.render(); return; }
    }
    if (px < PAD.left || px > this.w - PAD.right) { this.hoverX = null; this.hideTooltip(); this.render(); return; }
    const s = this.state;
    const t = this.xToT(px);

    // nearest poll dot within 12px → poll inspection mode
    let best = null, bestD = 12;
    if (s.showDots) {
      for (const p of s.polls) {
        if (p.t < s.t0 || p.t > s.t1) continue;
        const dx = this.tx(p.t) - px;
        if (Math.abs(dx) > 14) continue;
        for (const ser of s.series) {
          const v = p.results[ser.party];
          if (v === undefined || v > s.ymax) continue;
          const d = Math.hypot(dx, this.vy(v) - py);
          if (d < bestD) { bestD = d; best = p; }
        }
      }
    }

    this.hoverX = best ? this.tx(best.t) : px;
    this.render();
    if (best) this.showPollTooltip(best, e); else this.showTrendTooltip(t, e);
  }

  tooltipRow(color, label, value, strongValue = true) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
    key.style.background = color;
    const name = document.createElement('span');
    name.className = 'tt-name';
    name.textContent = label;
    const val = document.createElement('span');
    val.className = strongValue ? 'tt-val' : 'tt-val tt-val-soft';
    val.textContent = value;
    row.append(key, name, val);
    return row;
  }

  showTrendTooltip(t, evt) {
    const s = this.state;
    const tt = this.tooltip;
    tt.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = fmtDate(t) + ' · Trend';
    tt.appendChild(head);
    const rows = [];
    for (const ser of s.series) {
      // nearest grid index
      const gi = Math.round(((t - s.grid[0]) / (s.grid[s.grid.length - 1] - s.grid[0])) * (s.grid.length - 1));
      const v = s.trend[ser.party]?.[Math.max(0, Math.min(s.grid.length - 1, gi))];
      if (v === null || v === undefined) continue;
      rows.push({ ser, v });
    }
    if (!rows.length) { this.hideTooltip(); return; }
    rows.sort((a, b) => b.v - a.v);
    for (const r of rows) {
      tt.appendChild(this.tooltipRow(r.ser.color, r.ser.party, r.v.toFixed(1).replace('.', ',') + ' %'));
    }
    this.positionTooltip(evt);
  }

  showPollTooltip(p, evt) {
    const s = this.state;
    const tt = this.tooltip;
    tt.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tt-head';
    head.textContent = `${p.institute} · ${fmtDate(p.t)}`;
    tt.appendChild(head);
    if (p.sample || p.client) {
      const sub = document.createElement('div');
      sub.className = 'tt-sub';
      sub.textContent = [p.client, p.sample ? `n = ${p.sample.toLocaleString('de-DE')}` : null]
        .filter(Boolean).join(' · ');
      tt.appendChild(sub);
    }
    const rows = s.series
      .map(ser => ({ ser, v: p.results[ser.party], raw: p.raw?.[ser.party] }))
      .filter(r => r.v !== undefined)
      .sort((a, b) => b.v - a.v);
    for (const r of rows) {
      let label = r.v.toFixed(1).replace('.', ',') + ' %';
      if (r.raw !== undefined && Math.abs(r.raw - r.v) > 0.05) {
        label += ` (roh ${r.raw.toFixed(1).replace('.', ',')})`;
      }
      tt.appendChild(this.tooltipRow(r.ser.color, r.ser.party, label));
    }
    this.positionTooltip(evt);
  }

  positionTooltip(evt) {
    const tt = this.tooltip;
    tt.style.display = 'block';
    const parent = this.canvas.parentElement.getBoundingClientRect();
    const w = tt.offsetWidth, h = tt.offsetHeight;
    let x = evt.clientX - parent.left + 16;
    let y = evt.clientY - parent.top + 12;
    if (x + w > parent.width - 8) x = evt.clientX - parent.left - w - 16;
    if (y + h > parent.height - 8) y = parent.height - h - 8;
    tt.style.left = x + 'px';
    tt.style.top = Math.max(4, y) + 'px';
  }

  hideTooltip() {
    this.tooltip.style.display = 'none';
  }
}
