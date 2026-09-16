'use strict';
/* midi-transport.js — 走带：播放时把已采纳自动化投射到现场值
 *
 * 调度卡顿安全：播放头位置永远由 Clock 用硬件/帧时间戳投射得出。
 * 即使 rAF 卡顿后连续补帧，每帧采样的是该时刻对应工程位置的折线值，
 * 密集的 CC 记录点绝不会因为一次长任务被堆到同一时刻写回。 */
(function (global) {
  const MConsole = global.MConsole;
  const { clamp } = MConsole.util;

  function Transport(engine, clock, store) {
    this.engine = engine;
    this.clock = clock;
    this.store = store;
    this._lastApplied = Object.create(null);
    clock.on('frame', (pos) => this._onFrame(pos));
    clock.on('stop', (pos) => this._hold(pos));
  }

  Transport.prototype._onFrame = function (pos) {
    const lanes = this.store.state.lanes;
    let changed = false;
    this.store.state.controls.forEach(c => {
      const lane = lanes[c.id];
      if (lane && lane.length) {
        const v = MConsole.util.samplePoints(lane, pos);
        const value = clamp(v, 0, 1);
        if (this._lastApplied[c.id] === undefined || Math.abs(this._lastApplied[c.id] - value) > 0.0008) {
          this.store.state.live[c.id] = value;
          this._lastApplied[c.id] = value;
          changed = true;
        }
      }
    });
    if (changed) this.engine.emit('live-changed');
  };

  Transport.prototype._hold = function (pos) {
    // 停止：保持当前投射值（首尾值守住，不回弹）
    const lanes = this.store.state.lanes;
    this.store.state.controls.forEach(c => {
      const lane = lanes[c.id];
      if (lane && lane.length) {
        const v = MConsole.util.samplePoints(lane, pos);
        if (v !== null) this.store.state.live[c.id] = clamp(v, 0, 1);
      }
    });
    this.engine.emit('live-changed');
  };

  MConsole.Transport = Transport;
})(typeof window !== 'undefined' ? window : globalThis);
