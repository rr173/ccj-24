'use strict';
/* midi-timeline.js — 自动化时间线（canvas）
 * 层：标尺 / 每控件泳道（已采纳折线）/ take 半透明带（含争议斜纹、缺口、可采纳框选）/ 播放头。
 * 交互：标尺点按拖动=定位；在 take 带上拖选=给该 take 添加拼选范围；
 *       在已采纳折线上拖动=素材坐标变化（采集期间记争议）。 */
(function (global) {
  const MConsole = global.MConsole;
  const { clamp, samplePoints, fmtTime, mergeRanges } = MConsole.util;

  const RULER_H = 24;
  const LANE_H = 26;
  const PAD_L = 92;

  function Timeline(engine, clock, store, canvas, scrollEl, zoomInput) {
    this.engine = engine;
    this.clock = clock;
    this.store = store;
    this.canvas = canvas;
    this.scrollEl = scrollEl;
    this.ctx = canvas.getContext('2d');
    this.pxPerSec = parseFloat(zoomInput.value) || 120;
    this.drag = null;          // {kind:'seek'|'select'|'material', takeId?, x0?, y?}
    this._follow = true;
    this._bindUI(zoomInput);
  }

  Timeline.prototype._bindUI = function (zoomInput) {
    const c = this.canvas;
    zoomInput.addEventListener('input', () => {
      this.pxPerSec = parseFloat(zoomInput.value);
      this.render();
    });
    this.scrollEl.addEventListener('scroll', () => this.render());

    const posFromEvent = (ev) => {
      const rect = c.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, t: (ev.clientX - rect.left - PAD_L) / this.pxPerSec };
    };

    c.addEventListener('pointerdown', (ev) => {
      const p = posFromEvent(ev);
      c.setPointerCapture(ev.pointerId);
      if (p.y < RULER_H) {
        this.drag = { kind: 'seek', x0: p.x };
        this.clock.seek(Math.max(0, p.t));
      } else {
        const hit = this._hitTakeBand(p);
        if (hit && this._canSelect(hit.take)) {
          this.drag = { kind: 'select', takeId: hit.take.id, t0: p.t, t1: p.t };
        } else {
          this.drag = { kind: 'material', t0: p.t, t1: p.t, laneCid: this._laneAt(p.y) };
        }
      }
      this.render();
    });
    c.addEventListener('pointermove', (ev) => {
      if (!this.drag) return;
      const p = posFromEvent(ev);
      if (this.drag.kind === 'seek') this.clock.seek(Math.max(0, p.t));
      else { this.drag.t1 = p.t; this.render(); }
    });
    const up = (ev) => {
      if (!this.drag) return;
      const p = posFromEvent(ev);
      const d = this.drag;
      if (d.kind === 'select') {
        const lo = Math.max(0, Math.min(d.t0, p.t));
        const hi = Math.max(d.t0, p.t);
        if (hi - lo > 0.02) {
          const r = this.engine.addSelection(d.takeId, lo, hi);
          if (!r.ok) this.engine.emit('notice', r.reason);
        }
      } else if (d.kind === 'material') {
        const lo = Math.max(0, Math.min(d.t0, d.t1));
        const hi = Math.max(d.t0, d.t1);
        if (hi - lo > 0.02) {
          // 素材坐标变化：采集期间圈争议；非采集仅提示
          this.engine.noteMaterialDrag(lo, hi, d.laneCid);
          if (!this.engine.capture) this.engine.emit('notice', '仅采集期间拖动素材会圈争议范围');
        }
      }
      this.drag = null;
      this.render();
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    this.clock.on('frame', () => this._maybeRender());
  };

  Timeline.prototype._canSelect = function (take) {
    return take.fp === this.store.state.projectFp;
  };

  Timeline.prototype._laneAt = function (y) {
    const idx = Math.floor((y - RULER_H) / LANE_H);
    const ctl = this.store.state.controls[idx];
    return ctl ? ctl.id : null;
  };

  Timeline.prototype._hitTakeBand = function (p) {
    // take 带绘制在泳道下半部；取该时刻最新的、含该泳道的 take
    const t = p.t;
    const cid = this._laneAt(p.y);
    if (!cid) return null;
    const laneIdx = Math.floor((p.y - RULER_H) / LANE_H);
    const bandTop = RULER_H + laneIdx * LANE_H + LANE_H - 9;
    if (p.y < bandTop) return null;
    for (const take of this.store.state.takes) {
      if (t < take.start || t > take.end) continue;
      if (take.points.some(s => s.controlId === cid)) return { take };
    }
    return null;
  };

  Timeline.prototype._maybeRender = function () {
    // 播放时跟随播放头
    if (this.clock.playing) {
      const px = PAD_L + this.clock.pos * this.pxPerSec;
      const view = this.scrollEl.scrollLeft + this.scrollEl.clientWidth;
      if (this._follow && (px > view - 60 || px < this.scrollEl.scrollLeft + 40)) {
        this.scrollEl.scrollLeft = Math.max(0, px - this.scrollEl.clientWidth * 0.35);
      }
    }
    this.render();
  };

  Timeline.prototype.duration = function () {
    let d = 20;
    Object.values(this.store.state.lanes).forEach(lane => lane.forEach(p => { d = Math.max(d, p.t + 4); }));
    this.store.state.takes.forEach(t => { d = Math.max(d, t.end + 4); });
    const cap = this.engine.capture;
    if (cap) d = Math.max(d, this.clock.pos + 4);
    return d;
  };

  Timeline.prototype.render = function () {
    const c = this.canvas, ctx = this.ctx;
    const controls = this.store.state.controls;
    const dur = this.duration();
    const w = PAD_L + dur * this.pxPerSec + 200;
    const h = RULER_H + controls.length * LANE_H + 6;
    const dpr = global.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      c.style.width = w + 'px'; c.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';

    this._drawRuler(w, h);
    controls.forEach((ctl, i) => this._drawLane(ctl, i, w));
    this._drawTakes(w);
    this._drawSelectionDrag();
    this._drawPlayhead(h);
  };

  Timeline.prototype._drawRuler = function (w, h) {
    const ctx = this.ctx;
    ctx.fillStyle = '#101218';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = '#2a2e38';
    ctx.beginPath(); ctx.moveTo(0, RULER_H - .5); ctx.lineTo(w, RULER_H - .5); ctx.stroke();
    const step = this.pxPerSec < 90 ? 2 : 1;
    for (let t = 0; t * this.pxPerSec < w; t += step) {
      const x = PAD_L + t * this.pxPerSec;
      ctx.strokeStyle = '#333947';
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.fillStyle = '#7e8796';
      ctx.fillText(fmtTime(t), x + 3, RULER_H / 2);
    }
  };

  Timeline.prototype._drawLane = function (ctl, i, w) {
    const ctx = this.ctx;
    const top = RULER_H + i * LANE_H;
    ctx.fillStyle = i % 2 ? '#171a21' : '#141720';
    ctx.fillRect(0, top, w, LANE_H);
    ctx.strokeStyle = '#232733';
    ctx.beginPath(); ctx.moveTo(0, top + LANE_H - .5); ctx.lineTo(w, top + LANE_H - .5); ctx.stroke();
    // 名称
    ctx.fillStyle = '#9aa3b2';
    ctx.fillText(ctl.name.slice(0, 6), 6, top + LANE_H / 2);
    ctx.strokeStyle = '#2a2e38';
    ctx.beginPath(); ctx.moveTo(PAD_L, top); ctx.lineTo(PAD_L, top + LANE_H); ctx.stroke();

    const lane = this.store.state.lanes[ctl.id];
    if (lane && lane.length) {
      ctx.strokeStyle = '#4f8ef7';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const maxT = this.duration();
      let started = false;
      for (let t = 0; t <= maxT; t += 0.05) {
        const v = samplePoints(lane, t);
        const x = PAD_L + t * this.pxPerSec;
        const y = top + 4 + (1 - clamp(v, 0, 1)) * (LANE_H - 8);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  };

  Timeline.prototype._drawTakes = function () {
    const ctx = this.ctx;
    const ctlIndex = {};
    this.store.state.controls.forEach((c, i) => { ctlIndex[c.id] = i; });
    const foreign = (t) => t.fp !== this.store.state.projectFp;
    this.store.state.takes.slice().reverse().forEach(take => {
      // 全局 gap（橙斜纹）跨所有该 take 泳道
      take.gaps.forEach(g => this._hatch(g[0], g[1], '#8a5a2a', 0.55, take, ctlIndex));
      take.points.forEach(seg => {
        const i = ctlIndex[seg.controlId];
        if (i === undefined) return;
        const top = RULER_H + i * LANE_H;
        const x0 = PAD_L + take.start * this.pxPerSec;
        const x1 = PAD_L + take.end * this.pxPerSec;
        // take 底带
        ctx.fillStyle = foreign(take) ? 'rgba(140,140,160,.08)' : 'rgba(79,142,247,.14)';
        ctx.fillRect(x0, top + 3, x1 - x0, LANE_H - 12);
        // 折线（监听/比对用）
        ctx.strokeStyle = foreign(take) ? '#6a7080' : '#8fd0ff';
        ctx.beginPath();
        seg.pts.forEach((p, k) => {
          const x = PAD_L + p.t * this.pxPerSec;
          const y = top + 4 + (1 - clamp(p.v, 0, 1)) * (LANE_H - 8);
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        // 争议（红斜纹，按分段）
        (seg.disputes || take.disputes || []).forEach(r => {
          if (r[1] < take.start || r[0] > take.end) return;
          this._hatch(Math.max(r[0], take.start), Math.min(r[1], take.end), '#d05050', 0.5, null, null, top + 3, LANE_H - 12);
        });
      });
      // gap 再叠一次
      take.gaps.forEach(g => {
        if (g[1] < take.start || g[0] > take.end) return;
        take.points.forEach(seg => {
          const i = ctlIndex[seg.controlId];
          if (i === undefined) return;
          const top = RULER_H + i * LANE_H;
          this._hatch(Math.max(g[0], take.start), Math.min(g[1], take.end), '#8a5a2a', 0.6, null, null, top + 3, LANE_H - 12);
        });
      });
    });
    // 已确认的拼选范围（绿框）
    this.engine.compSelection.forEach(sel => {
      const x0 = PAD_L + sel.in * this.pxPerSec, x1 = PAD_L + sel.out * this.pxPerSec;
      ctx.strokeStyle = '#7fe0a0';
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x0, RULER_H); ctx.lineTo(x0, this.canvas.height);
      ctx.moveTo(x1, RULER_H); ctx.lineTo(x1, this.canvas.height); ctx.stroke();
      ctx.setLineDash([]);
    });
  };

  Timeline.prototype._hatch = function (t0, t1, color, alpha, take, ctlIndex, forceTop, forceH) {
    const ctx = this.ctx;
    const x0 = PAD_L + t0 * this.pxPerSec, x1 = PAD_L + t1 * this.pxPerSec;
    ctx.save();
    ctx.beginPath();
    if (forceTop !== undefined) ctx.rect(x0, forceTop, x1 - x0, forceH);
    else ctx.rect(x0, RULER_H, x1 - x0, this.store.state.controls.length * LANE_H);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    for (let x = x0 - 12; x < x1 + 12; x += 7) {
      ctx.beginPath(); ctx.moveTo(x, (forceTop !== undefined ? forceTop : RULER_H));
      ctx.lineTo(x + 8, (forceTop !== undefined ? forceTop + forceH : RULER_H + this.store.state.controls.length * LANE_H));
      ctx.stroke();
    }
    ctx.restore();
  };

  Timeline.prototype._drawSelectionDrag = function () {
    if (!this.drag || this.drag.kind !== 'select') return;
    const ctx = this.ctx;
    const x0 = PAD_L + Math.min(this.drag.t0, this.drag.t1) * this.pxPerSec;
    const x1 = PAD_L + Math.max(this.drag.t0, this.drag.t1) * this.pxPerSec;
    ctx.fillStyle = 'rgba(127,224,160,.18)';
    ctx.fillRect(x0, RULER_H, x1 - x0, this.store.state.controls.length * LANE_H);
    ctx.strokeStyle = '#7fe0a0';
    ctx.strokeRect(x0, RULER_H, x1 - x0, this.store.state.controls.length * LANE_H);
  };

  Timeline.prototype._drawPlayhead = function (h) {
    const ctx = this.ctx;
    const x = PAD_L + this.clock.pos * this.pxPerSec;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); ctx.stroke();
  };

  MConsole.Timeline = Timeline;
})(typeof window !== 'undefined' ? window : globalThis);
