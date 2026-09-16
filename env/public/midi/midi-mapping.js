'use strict';
/* midi-mapping.js — 值域映射、响应曲线、反相、越界裁切、高频平滑
 *
 * 管线：raw(0..127)
 *   -> 归一化（按 inMin/inMax；越界按 clip 配置裁切或保留超调）
 *   -> 反相
 *   -> 响应曲线（linear / exp / log / s）
 *   -> 投射到 outMin/outMax
 *   -> 平滑（one-pole 低通；首值立即落位，停止后尾值必达，绝不削掉首尾） */
(function (global) {
  const MConsole = global.MConsole;
  const { clamp } = MConsole.util;

  /** 响应曲线：输入输出都是 0..1 */
  function applyCurve(x, curve) {
    x = clamp(x, 0, 1);
    switch (curve) {
      case 'exp': // 指数（前置量小，推子后段增长快）
        return x * x;
      case 'log': // 对数（前段增长快）
        return 1 - (1 - x) * (1 - x);
      case 'scurve': { // S 曲线：两端缓、中段陡
        return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
      }
      case 'linear':
      default:
        return x;
    }
  }

  /**
   * 把原始 CC 值映射到工程值（0..1 标称，outMin/outMax 可越界表达超调）
   * cfg: { inMin, inMax, outMin, outMax, invert, curve, clip }
   * 返回 { value, clipped }
   */
  function mapRaw(raw, cfg) {
    const inLo = Math.min(cfg.inMin, cfg.inMax);
    const inHi = Math.max(cfg.inMin, cfg.inMax);
    let clipped = false;
    if (raw < inLo || raw > inHi) {
      clipped = true;
      if (cfg.clip) raw = clamp(raw, inLo, inHi);
    }
    const span = (inHi - inLo) || 1;
    let n = (raw - inLo) / span;
    if (cfg.clip) n = clamp(n, 0, 1);
    else n = clamp(n, -0.5, 1.5); // 未裁切时允许有限超调
    if (cfg.invert) n = 1 - n;
    // 线性直接透传（保留超调）；非线性曲线只在 [0,1] 内弯曲，超调段线性外推
    let curved;
    if (cfg.curve === 'linear' || cfg.curve === undefined) {
      curved = n;
    } else if (n >= 0 && n <= 1) {
      curved = applyCurve(n, cfg.curve);
    } else {
      // 用端点切线外推，保持方向且不再夹断
      const d0 = curveDerivative(0, cfg.curve), d1 = curveDerivative(1, cfg.curve);
      curved = n < 0 ? n * d0 : 1 + (n - 1) * d1;
    }
    let v = cfg.outMin + curved * (cfg.outMax - cfg.outMin);
    if (cfg.clip) v = clamp(v, Math.min(cfg.outMin, cfg.outMax), Math.max(cfg.outMin, cfg.outMax));
    else v = clamp(v, Math.min(cfg.outMin, cfg.outMax) - 0.5, Math.max(cfg.outMin, cfg.outMax) + 0.5);
    return { value: v, clipped };
  }

  function curveDerivative(x, curve) {
    const e = 1e-4;
    return (applyCurve(clamp(x + e, 0, 1), curve) - applyCurve(clamp(x - e, 0, 1), curve)) / (2 * e);
  }

  /**
   * One-pole 平滑器。amount 0..1（越大越平滑）。
   * 首个值不做平滑（首值守住）；flush() 把目标立即落位（尾值守住）。
   */
  function Smoother(amount) {
    this.amount = amount || 0;
    this._y = null;
    this._target = null;
    this._hasPending = false;
  }
  Smoother.prototype.setAmount = function (a) { this.amount = clamp(a, 0, 0.99); };
  Smoother.prototype.reset = function (v) {
    if (v === undefined) { this._y = null; this._target = null; this._hasPending = false; return; }
    this._y = v; this._target = v; this._hasPending = false;
  };
  Smoother.prototype.push = function (v) {
    this._target = v;
    if (this._y === null) { this._y = v; return v; } // 首值立即落位
    if (this.amount <= 0) { this._y = v; return v; }
    // alpha 越小越快；amount=0.95 时 alpha≈0.66
    const alpha = 1 - Math.pow(this.amount, 1.5);
    this._y = this._y + (v - this._y) * alpha;
    this._hasPending = true;
    return this._y;
  };
  Smoother.prototype.flush = function () {
    // 手势结束：尾值必达，不允许停在半路
    if (this._target !== null) this._y = this._target;
    this._hasPending = false;
    return this._y;
  };
  Smoother.prototype.value = function () { return this._y; };
  Smoother.prototype.target = function () { return this._target; };
  /** 无新数据时由时钟驱动继续逼近（限步数，到 0.05% 内即落位） */
  Smoother.prototype.tick = function () {
    if (!this._hasPending) return this._y;
    const alpha = 1 - Math.pow(this.amount, 1.5);
    this._y = this._y + (this._target - this._y) * alpha;
    if (Math.abs(this._target - this._y) < 0.0005) { this._y = this._target; this._hasPending = false; }
    return this._y;
  };

  MConsole.mapping = { applyCurve, mapRaw, Smoother };
})(typeof window !== 'undefined' ? window : globalThis);
