'use strict';
/* midi-clock.js — 工程时钟
 *
 * - 所有时间换算基于锚点：proj = projAnchor + (perf - perfAnchor)/1000
 *   MIDI 事件携带 receivedTime（与 performance.now() 同一时基），直接投射，
 *   即使主线程卡顿、消息成簇到达，每条事件仍落在各自的硬件时间戳上，不会堆到单点。
 * - rAF 的时间戳同样使用回调参数而非 Date.now()，视觉刷新延迟不改变工程位置。
 * - 挂起信号：标签页隐藏立即挂起；定时间隔远超预算（后台节流）挂起；长卡顿只报延迟不挂采集。 */
(function (global) {
  const MConsole = global.MConsole;
  const { Emitter, now, clamp } = MConsole.util;

  const THROTTLE_OVERRUN_MS = 700;   // 定时任务超过该延迟视为被节流
  const JANK_WARN_MS = 120;          // 视觉卡顿提示阈值（不挂采集）

  function Clock() {
    Emitter.call(this);
    this.playing = false;
    this.pos = 0;
    this.loop = false;
    this.loopIn = 0;
    this.loopOut = 0;
    this._perfAnchor = 0;
    this._projAnchor = 0;
    this._lastFramePerf = 0;
    this._rafId = 0;
    this._watchId = 0;
    this._watchExpected = 0;
    this.lastFrameLagMs = 0;
    this._suspendedFor = null;       // 'hidden' | 'throttle'
    this._bindVis();
  }
  Clock.prototype = Object.create(Emitter.prototype);

  Clock.prototype._bindVis = function () {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._noteSuspend('hidden');
    });
  };

  Clock.prototype._noteSuspend = function (reason) {
    if (this._suspendedFor) return;
    this._suspendedFor = reason;
    this._suspendPerf = now();
    this.emit('clock-suspend', reason);
  };
  Clock.prototype.clearSuspend = function () { this._suspendedFor = null; };
  /** 挂起持续的墙钟秒数（标签页隐藏期间 rAF 冻结，但墙钟仍在走） */
  Clock.prototype.suspendedElapsed = function () {
    if (!this._suspendedFor || this._suspendPerf == null) return 0;
    return Math.max(0, (now() - this._suspendPerf) / 1000);
  };

  Clock.prototype.setLoop = function (on, lo, hi) {
    if (on && hi > lo) { this.loop = true; this.loopIn = lo; this.loopOut = hi; }
    else { this.loop = false; lo = hi = 0; }
    this.emit('loop-changed');
  };

  Clock.prototype.play = function (fromPos, perf) {
    perf = perf || now();
    this.playing = true;
    this._perfAnchor = perf;
    this._projAnchor = fromPos !== undefined ? fromPos : this.pos;
    this.pos = this._projAnchor;
    this._lastFramePerf = perf;
    this._startLoops(perf);
    this.emit('play', this.pos);
  };

  Clock.prototype.stop = function (perf) {
    if (this.playing) {
      this.pos = this.project(perf || now());
    }
    this.playing = false;
    this._stopLoops();
    this.emit('stop', this.pos);
  };

  Clock.prototype.seek = function (pos, perf) {
    pos = Math.max(0, pos);
    if (this.playing) {
      this._perfAnchor = perf || now();
      this._projAnchor = pos;
    }
    this.pos = pos;
    this.emit('seek', pos);
  };

  /** 把任意 performance 时基的时间戳（如 MIDI receivedTime）投射到工程时钟 */
  Clock.prototype.project = function (perf) {
    if (!this.playing) return this.pos;
    let t = this._projAnchor + (perf - this._perfAnchor) / 1000;
    if (this.loop && this.loopOut > this.loopIn) {
      const span = this.loopOut - this.loopIn;
      if (t >= this.loopOut) t = this.loopIn + ((t - this.loopIn) % span);
    }
    t = Math.max(0, t);
    this.pos = t; // 测试环境无 rAF 时也能推进位置（浏览器里由帧循环覆盖）
    return t;
  };

  Clock.prototype._startLoops = function () {
    const frame = (perf) => {
      if (!this.playing) return;
      const gap = perf - this._lastFramePerf;
      this._lastFramePerf = perf;
      this.lastFrameLagMs = Math.max(0, gap - 16.7);
      if (gap > JANK_WARN_MS) this.emit('jank', gap);
      this.pos = this.project(perf);
      this.emit('frame', this.pos, perf, gap);
      this._rafId = requestAnimationFrame(frame);
    };
    this._rafId = requestAnimationFrame(frame);

    this._watchExpected = now() + 250;
    this._watchId = setInterval(() => {
      const t = now();
      const over = t - this._watchExpected;
      this._watchExpected = t + 250;
      if (this.playing && over > THROTTLE_OVERRUN_MS) {
        // 后台标签把定时器压到 ~1/s：立即挂起采集
        if (typeof document !== 'undefined' && document.hidden) this._noteSuspend('hidden');
        else this._noteSuspend('throttle');
      }
    }, 250);
  };

  Clock.prototype._stopLoops = function () {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._watchId) clearInterval(this._watchId);
    this._rafId = this._watchId = 0;
  };

  /** 挂起后恢复播放（时钟连续；gap 由采集层记录） */
  Clock.prototype.resume = function (perf) {
    this.clearSuspend();
    if (this.playing) {
      // 以当前 pos 重新锚定，墙钟流逝的部分不补放
      this.play(this.pos, perf || now());
    }
  };

  MConsole.Clock = Clock;
})(typeof window !== 'undefined' ? window : globalThis);
