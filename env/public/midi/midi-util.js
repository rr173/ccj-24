'use strict';
/* midi-util.js — 小工具：事件、时间、数值、区间运算 */
(function (global) {
  const MConsole = global.MConsole || (global.MConsole = {});

  function Emitter() { this._h = Object.create(null); }
  Emitter.prototype.on = function (ev, fn) {
    (this._h[ev] = this._h[ev] || []).push(fn);
    return () => this.off(ev, fn);
  };
  Emitter.prototype.off = function (ev, fn) {
    const a = this._h[ev];
    if (!a) return;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  };
  Emitter.prototype.emit = function (ev) {
    const a = this._h[ev];
    if (!a || !a.length) return;
    const args = Array.prototype.slice.call(arguments, 1);
    a.slice().forEach(fn => { try { fn.apply(null, args); } catch (e) { console.error('[emit ' + ev + ']', e); } });
  };

  const now = () => (global.performance && global.performance.now ? global.performance.now() : Date.now());

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /** 秒 → mm:ss.cs（厘秒） */
  function fmtTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    const cs = Math.floor((t * 100) % 100);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
  }

  function shortHash(str, n) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    const hex = (h >>> 0).toString(16).toUpperCase();
    return ('00000000' + hex).slice(-(n || 6));
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 区间 [a,b) 工具：合并、相减、交集、长度 */
  function mergeRanges(ranges) {
    const r = ranges.filter(x => x && x[1] - x[0] > 0)
      .map(x => [x[0], x[1]]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const out = [];
    for (const iv of r) {
      const last = out[out.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else out.push(iv);
    }
    return out;
  }

  /** 从 [start,end) 中减去 cuts（区间数组），返回剩余区间 */
  function subtractRanges(start, end, cuts) {
    let parts = [[start, end]];
    for (const cut of mergeRanges(cuts)) {
      const next = [];
      for (const p of parts) {
        if (cut[1] <= p[0] || cut[0] >= p[1]) { next.push(p); continue; }
        if (cut[0] > p[0]) next.push([p[0], Math.min(cut[0], p[1])]);
        if (cut[1] < p[1]) next.push([Math.max(cut[1], p[0]), p[1]]);
      }
      parts = next;
    }
    return parts.filter(p => p[1] - p[0] > 1e-6);
  }

  function intersectRanges(start, end, ranges) {
    const out = [];
    for (const r of mergeRanges(ranges)) {
      const a = Math.max(start, r[0]), b = Math.min(end, r[1]);
      if (b - a > 1e-6) out.push([a, b]);
    }
    return out;
  }

  function unionLength(ranges) {
    return mergeRanges(ranges).reduce((s, r) => s + (r[1] - r[0]), 0);
  }

  /** 采样折线点集（{t,v}，按 t 升序、线性插值），范围外保持首/尾值 */
  function samplePoints(points, t) {
    if (!points.length) return null;
    if (t <= points[0].t) return points[0].v;
    const last = points[points.length - 1];
    if (t >= last.t) return last.v;
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = points[lo], b = points[hi];
    const k = (t - a.t) / (b.t - a.t || 1);
    return lerp(a.v, b.v, k);
  }

  /** 两个按 t 排序的折线合并：冲突（时间重叠）时 b 覆盖 a */
  function mergePointLanes(aPts, bPts) {
    // 简化策略：找到 b 的时间包络，直接拼接（采纳时按 punch 语义另行处理）
    if (!bPts.length) return aPts.slice();
    if (!aPts.length) return bPts.slice();
    return aPts.concat(bPts).sort((p, q) => p.t - q.t);
  }

  MConsole.util = {
    Emitter, now, clamp, lerp, shortHash, uid, fmtTime,
    mergeRanges, subtractRanges, intersectRanges, unionLength,
    samplePoints, mergePointLanes,
  };
})(typeof window !== 'undefined' ? window : globalThis);
