'use strict';
/* midi-engine.js — 遥控台核心
 *
 * 职责：配对学习 / 绑定管理 / 实时值映射与平滑 / 武装与采集（take）/
 *       争议检测 / 挂起-续接 / 拼选与采纳（单个撤销单元）/ 监听。
 *
 * 关键时序约束：
 *   - 事件时间一律使用 MIDI receivedTime（performance 时基）经 Clock.project 投射；
 *     主线程卡顿造成消息成簇到达时，点仍按各自硬件时间戳分布，不堆单点。
 *   - 晚到事件（时间戳早于已记录末点）计入 lateDropped，绝不回写已生成版本；
 *     采纳瞬间对 take 做浅拷贝快照，之后到达的输入不可能改动本次采纳。 */
(function (global) {
  const MConsole = global.MConsole;
  const { Emitter, clamp, uid, now } = MConsole.util;
  const { mapRaw, Smoother } = MConsole.mapping;

  const LEARN_DELTA = 4;              // CC 值变化确认阈值（防跳动误绑）
  const LEARN_TIMEOUT_MS = 15000;
  const COALESCE_S = 0.001;           // 同时间戳/亚毫秒事件合并
  const GESTURE_IDLE_MS = 180;        // 超过该间隔无消息视为本次手势结束 → flush 尾值
  const DISPUTE_MOUSE_S = 0.25;       // 鼠标点碰争议半径
  const DISPUTE_DRAG_PAD = 0.15;      // 拖动素材坐标争议向前后扩展
  const SETTLE_MS = 350;              // 停止后等平滑收敛

  function Engine(store, hub, clock) {
    Emitter.call(this);
    this.store = store;
    this.hub = hub;
    this.clock = clock;
    this.learn = null;                // { controlId, last, port, ch, cc, timer }
    this.processors = new Map();      // bindingId -> { smoother, gestureTimer, gestureActive, lastValue }
    this.capture = null;              // 活动采集上下文
    this.compSelection = [];          // [{takeId, in, out}]
    this.monitorTakeIds = new Set();
    this._frameHandler = null;
    this._wire();
  }
  Engine.prototype = Object.create(Emitter.prototype);

  Engine.prototype._wire = function () {
    this.hub.on('cc', e => this._onCC(e));
    this.hub.on('port-lost', rec => this._onPortLost(rec));
    this.clock.on('clock-suspend', reason => this.suspendCapture(reason === 'hidden' ? '标签页失焦' : '浏览器节流'));
    this.clock.on('frame', (pos) => this._tickSmoothers());
    this.clock.on('frame', (pos) => this._monitorFrame(pos));
  };

  // ---------------- 配对学习 ----------------
  Engine.prototype.startLearn = function (controlId) {
    this.cancelLearn();
    this.learn = {
      controlId, last: null, lastRaw: null,
      port: null, ch: null, cc: null,
      timer: setTimeout(() => this.cancelLearn(true), LEARN_TIMEOUT_MS),
    };
    this.emit('learn-changed', this.learn);
  };
  Engine.prototype.cancelLearn = function (timeout) {
    if (this.learn && this.learn.timer) clearTimeout(this.learn.timer);
    this.learn = null;
    this.emit('learn-changed', null);
    if (timeout) this.emit('notice', '配对超时：未检测到 CC 变化');
  };
  Engine.prototype.isLearning = function (controlId) {
    return this.learn && (controlId === undefined || this.learn.controlId === controlId);
  };

  Engine.prototype._onCC = function (e) {
    // 配对学习优先消费
    if (this.learn) {
      const L = this.learn;
      if (L.last !== null && (L.port !== e.portId || L.ch !== e.ch || L.cc !== e.cc)) {
        // 换了另一个控件，重置候选
        L.port = e.portId; L.ch = e.ch; L.cc = e.cc; L.lastRaw = e.value;
      } else if (L.last === null) {
        L.port = e.portId; L.ch = e.ch; L.cc = e.cc; L.lastRaw = e.value;
      } else {
        if (Math.abs(e.value - L.lastRaw) >= LEARN_DELTA) {
          const controlId = L.controlId;
          const conflict = this.store.findBindings(e.portId, e.ch, e.cc);
          this._pendingLearn = { controlId, event: e };
          if (conflict.length) {
            this.emit('binding-conflict', {
              existing: conflict,
              key: this.keyLabel(e.portId, e.ch, e.cc),
            });
            // 保持 learn 现场，等待 resolveConflict / cancelConflict
            return;
          }
          this._commitLearn(controlId, e);
          return;
        }
        L.lastRaw = e.value;
      }
      L.last = e.value;
      return;
    }
    this._route(e);
  };

  Engine.prototype.keyLabel = function (portId, ch, cc) {
    const p = this.hub.getPort(portId);
    return (p ? p.name : portId) + ' · CH' + (ch + 1) + ' · CC' + cc;
  };

  Engine.prototype._commitLearn = function (controlId, e, mode, existing) {
    const port = this.hub.getPort(e.portId) || this._portFromBinding(existing && existing[0]);
    const globalSmooth = this.store.state.settings.smooth;
    const base = {
      controlId,
      port: port ? { id: port.id, name: port.name, manufacturer: port.manufacturer, fp: port.fp }
        : { id: e.portId, name: e.portName, manufacturer: '', fp: '' },
      ch: e.ch, cc: e.cc,
      inMin: 0, inMax: 127, outMin: 0, outMax: 1,
      invert: false, curve: 'linear',
      smooth: globalSmooth, clip: this.store.state.settings.clipOOB,
      armed: false,
    };

    // 先处理与旧绑定的关系（先删旧，避免 removeBinding 的共享组清理误伤新绑定）
    if (mode === 'replace' && existing) {
      // 共享组其它成员保留，但要把被替换者从组里摘掉
      const removedIds = new Set(existing.filter(o => o.controlId !== controlId).map(o => o.id));
      removedIds.forEach(id => this.store.removeBinding(id));
      this.emit('notice', '已替换旧绑定 → ' + this._ctrlName(controlId));
    }

    // 同一软件控件原有的绑定：替换目标时先解除（共享组除外，由冲突流程决定）
    this.store.bindingForControl(controlId).forEach(b => {
      if (!(existing && existing.some(x => x.id === b.id))) this.store.removeBinding(b.id);
    });

    const binding = this.store.addBinding(base);
    if (mode === 'share' && existing) {
      // 共享：加入旧绑定的组；所有成员互相同步 group / sharedWith
      const surviving = existing.filter(o => this.store.state.bindings.some(x => x.id === o.id));
      const group = (surviving[0] ? surviving[0].group.slice() : existing[0].group.slice());
      if (group.indexOf(binding.id) < 0) group.push(binding.id);
      const ctlIds = {};
      group.forEach(id => {
        const b = this.store.state.bindings.find(x => x.id === id);
        if (b) ctlIds[b.controlId] = 1;
      });
      ctlIds[controlId] = 1;
      group.forEach(id => {
        const b = this.store.state.bindings.find(x => x.id === id);
        if (b) this.store.updateBinding(id, { group: group.slice(), sharedWith: Object.keys(ctlIds) });
      });
      this.emit('notice', '已共享：' + Object.keys(ctlIds).map(c => this._ctrlName(c)).join(' / '));
    }
    this.cancelLearn();
    this._pendingLearn = null;
    this.store.save();
    this.emit('bindings-changed');
    return binding;
  };

  Engine.prototype._portFromBinding = function (b) {
    return b ? b.port : null;
  };

  /** 冲突三选一 */
  Engine.prototype.resolveConflict = function (mode) {
    if (!this._pendingLearn) return;
    const { controlId, event } = this._pendingLearn;
    const existing = this.store.findBindings(event.portId, event.ch, event.cc);
    if (mode === 'cancel') { this._pendingLearn = null; this.cancelLearn(); this.emit('notice', '已放弃配对'); return; }
    this._commitLearn(controlId, event, mode, existing);
  };
  Engine.prototype.cancelConflict = function () { this.resolveConflict('cancel'); };

  Engine.prototype.removeBinding = function (id) {
    this.processors.delete(id);
    this.store.removeBinding(id);
    this.emit('bindings-changed');
  };
  Engine.prototype.updateBinding = function (id, patch) {
    this.store.updateBinding(id, patch);
    const p = this.processors.get(id);
    if (p && patch.smooth !== undefined) p.smoother.setAmount(patch.smooth);
    // 参数编辑只发轻量事件（输入框不重绘，避免连续微调失焦）；
    // 武装/增删等结构性变化由调用方发 bindings-changed。
    this.emit('binding-updated', id, patch);
  };

  Engine.prototype.setArmed = function (id, on) {
    this.store.updateBinding(id, { armed: !!on });
    this.emit('bindings-changed');
  };
  Engine.prototype.armAll = function (on) {
    this.store.state.bindings.forEach(b => this.store.updateBinding(b.id, { armed: !!on }));
    this.emit('bindings-changed');
  };

  Engine.prototype._ctrlName = function (id) {
    const c = this.store.state.controls.find(x => x.id === id);
    return c ? c.name : id;
  };

  // ---------------- 实时路由 ----------------
  Engine.prototype._route = function (e) {
    const bindings = this.store.findBindings(e.portId, e.ch, e.cc);
    bindings.forEach(b => this._pushBinding(b, e));
  };

  Engine.prototype._getProcessor = function (b) {
    let p = this.processors.get(b.id);
    if (!p) {
      p = { smoother: new Smoother(b.smooth), gestureTimer: 0, gestureActive: false, lastValue: null, raw: 0 };
      this.processors.set(b.id, p);
    }
    return p;
  };

  Engine.prototype._pushBinding = function (b, e) {
    const p = this._getProcessor(b);
    p.raw = e.value;
    const mapped = mapRaw(e.value, b);
    p.smoother.setAmount(b.smooth);
    const v = p.smoother.push(mapped.value);
    p.lastValue = v;
    p.clipped = mapped.clipped;

    // 手势状态（用于触碰模式与尾值收敛）
    p.gestureActive = true;
    clearTimeout(p.gestureTimer);
    p.gestureTimer = setTimeout(() => this._onGestureEnd(b.id), GESTURE_IDLE_MS);

    if (this.capture && this.capture.active && b.armed) {
      this._recordPoint(b, v, e.perfTime);
    }
    if (!this.clock.playing) {
      // 停止状态下：硬件直接改现场值
      this._applyValueToControl(b, v);
    }
    this.emit('binding-value', { bindingId: b.id, controlId: b.controlId, value: v, raw: e.value, clipped: mapped.clipped });
  };

  Engine.prototype._onGestureEnd = function (bindingId) {
    const b = this.store.state.bindings.find(x => x.id === bindingId);
    if (!b) return;
    const p = this.processors.get(bindingId);
    if (!p) return;
    const tail = p.smoother.flush(); // 尾值必达
    p.gestureActive = false;
    if (this.capture && this.capture.active && b.armed) {
      const slot = this.capture.points[b.controlId];
      if (slot) {
        this._recordPoint(b, tail, now());
        // 闭合本条手势区间（触碰模式用）
        if (slot.gestureStart !== null) {
          slot.gestureSpans.push([slot.gestureStart, slot.lastT]);
          slot.gestureStart = null;
          slot.gestureEndAt = slot.lastT;
        }
      }
    }
    this.emit('gesture-end', { bindingId, controlId: b.controlId });
  };

  Engine.prototype._applyValueToControl = function (b, v) {
    // 共享组同步
    const group = (b.group || [b.id]).map(id => this.store.state.bindings.find(x => x.id === id)).filter(Boolean);
    group.forEach(gb => {
      this.store.state.live[gb.controlId] = clamp(v, 0, 1);
    });
    this.emit('live-changed');
  };

  Engine.prototype._tickSmoothers = function () {
    if (this.capture && this.capture.active) return; // 采集时按事件驱动，避免补点污染
    this.processors.forEach((p, id) => {
      const b = this.store.state.bindings.find(x => x.id === id);
      if (!b || !p.gestureActive) return;
      const v = p.smoother.tick();
      if (!this.clock.playing) this._applyValueToControl(b, v);
      this.emit('binding-value', { bindingId: id, controlId: b.controlId, value: v, raw: p.raw, clipped: !!p.clipped, tick: true });
    });
  };

  // ---------------- 采集 ----------------
  Engine.prototype.armedBindings = function () {
    return this.store.state.bindings.filter(b => b.armed);
  };

  Engine.prototype.startCapture = function () {
    if (this.capture) return { ok: false, reason: '已有采集在进行' };
    const armed = this.armedBindings();
    if (!armed.length) return { ok: false, reason: '请先武装至少一条绑定（绑定行上的 R）' };
    const offline = armed.filter(b => !this.hub.isOnline(b.port.id));
    if (offline.length) return { ok: false, reason: '有武装绑定的端口离线：' + offline.map(b => this._ctrlName(b.controlId)).join('、') };
    if (!this.clock.playing) this.clock.play(0);

    const writeMode = this.store.state.settings.writeMode || 'overwrite';
    this.capture = {
      active: true, suspended: false,
      takeId: uid('t'),
      writeMode,
      start: this.clock.pos,
      stop: this.clock.pos,
      points: Object.create(null),
      disputes: [],
      gaps: [],
      perfBase: now(),
      lateDropped: 0,
      settleTimer: 0,
    };
    armed.forEach(b => {
      this.capture.points[b.controlId] = {
        bindingId: b.id,
        pts: [{ t: this.clock.pos, v: this.store.state.live[b.controlId] != null ? this.store.state.live[b.controlId] : 0.5 }],
        gestureSpans: [],
        disputes: [],
        gestureStart: null,
        lastT: this.clock.pos,
      };
    });
    this.emit('capture-started', this.capture);
    return { ok: true };
  };

  Engine.prototype._recordPoint = function (b, value, perfTime) {
    const cap = this.capture;
    if (!cap || !cap.active) return;
    const slot = cap.points[b.controlId];
    if (!slot) return;
    const t = this.clock.project(perfTime);

    // 手势区间（触碰模式写入范围）
    if (slot.gestureStart === null) slot.gestureStart = t;
    slot._lastGestureAt = t;
    const pts = slot.pts;
    // 晚到：时间戳早于已记录末点 → 丢弃，禁止回写新版本
    if (pts.length && t < pts[pts.length - 1].t - COALESCE_S) {
      cap.lateDropped++;
      this.emit('late-drop', { bindingId: b.id, t, dropped: cap.lateDropped });
      return;
    }
    // 新手势（上一段已被 _onGestureEnd 闭合）
    if (slot.gestureStart === null) slot.gestureStart = t;
    slot._lastGestureAt = t;
    this._appendPoint(slot, t, value);
    cap.stop = Math.max(cap.stop, t);
    this.emit('capture-point', { controlId: b.controlId, t, v: value });
    this._scheduleDraftPersist();
  };

  Engine.prototype._appendPoint = function (slot, t, v) {
    const pts = slot.pts;
    const last = pts[pts.length - 1];
    if (last && t - last.t < COALESCE_S) {
      // 亚毫秒/同戳密集事件：合并到末点，绝不叠在同一时刻
      last.v = v;
    } else {
      pts.push({ t, v });
    }
    slot.lastT = t;
  };

  Engine.prototype._closeGestures = function (atT) {
    const cap = this.capture;
    if (!cap) return;
    Object.keys(cap.points).forEach(cid => {
      const slot = cap.points[cid];
      if (slot.gestureStart !== null) {
        slot.gestureSpans.push([slot.gestureStart, Math.max(slot.gestureStart + COALESCE_S, atT || slot.lastT)]);
        slot.gestureStart = null;
      }
    });
  };

  /** 采集期间鼠标触碰同一软件控件 → 仅圈该控件的争议时段 */
  Engine.prototype.noteMouseTouch = function (controlId) {
    if (!this.capture || !this.capture.active) return;
    const slot = this.capture.points[controlId];
    if (!slot) return; // 碰的不是已武装控件：不产生争议
    const t = this.clock.pos;
    const r = [Math.max(0, t - DISPUTE_MOUSE_S), t + DISPUTE_MOUSE_S];
    slot.disputes = MConsole.util.mergeRanges((slot.disputes || []).concat([r]));
    this.emit('dispute', { controlId, range: r, reason: '鼠标触碰同一控件' });
  };

  /** 采集期间素材坐标变化（时间线拖动等）→ 圈相关控件的争议时段 */
  Engine.prototype.noteMaterialDrag = function (t0, t1, controlId) {
    if (!this.capture || !this.capture.active) return;
    const r = [Math.max(0, t0 - DISPUTE_DRAG_PAD), t1 + DISPUTE_DRAG_PAD];
    const targets = controlId ? [controlId] : Object.keys(this.capture.points);
    targets.forEach(cid => {
      const slot = this.capture.points[cid];
      if (!slot) return;
      slot.disputes = MConsole.util.mergeRanges((slot.disputes || []).concat([r]));
    });
    this.emit('dispute', { controlId: controlId || '*', range: r, reason: '素材坐标变化' });
  };

  // ---------------- 挂起 / 续接 ----------------
  Engine.prototype.suspendCapture = function (reason) {
    const cap = this.capture;
    if (!cap || cap.suspended || !cap.active) return;
    cap.active = false;
    cap.suspended = true;
    cap.suspendReason = reason;
    cap.suspendedAt = this.clock.pos;
    this._closeGestures(this.clock.pos);
    this.processors.forEach(p => clearTimeout(p.gestureTimer));
    this._persistDraftNow();
    this.emit('capture-suspended', { reason, at: this.clock.pos });
  };

  Engine.prototype._onPortLost = function (rec) {
    const cap = this.capture;
    if (cap && cap.active) {
      const used = Object.keys(cap.points).some(cid => {
        const b = this.store.state.bindings.find(x => x.controlId === cid);
        return b && b.port.id === rec.id;
      });
      if (used) this.suspendCapture('端口拔出：' + rec.name);
    }
  };

  Engine.prototype.canResume = function () {
    const cap = this.capture;
    if (!cap || !cap.suspended) return { ok: false };
    const offline = this.armedBindings().filter(b => !this.hub.isOnline(b.port.id));
    if (offline.length) return { ok: false, reason: '仍有武装端口离线：' + offline.map(b => this._ctrlName(b.controlId)).join('、') };
    return { ok: true };
  };

  /** 续接本 take：掉线时段记为 gap（只供查看，不参与采纳） */
  Engine.prototype.resumeCapture = function () {
    const cap = this.capture;
    if (!cap || !cap.suspended) return { ok: false, reason: '没有挂起的采集' };
    const check = this.canResume();
    if (!check.ok) return check;
    // 失焦/节流期间 rAF 冻结但墙钟在走：把真实流逝计入工程位置与缺口；
    // 拔线恢复（端口在线但时钟仍在跑）则按时钟位置差计缺口。
    const hiddenElapsed = (cap.suspendReason && /失焦|节流/.test(cap.suspendReason))
      ? this.clock.suspendedElapsed() : 0;
    let resumeAt = this.clock.playing ? this.clock.pos + hiddenElapsed : cap.suspendedAt + hiddenElapsed;
    if (hiddenElapsed > 0) this.clock.seek(resumeAt);
    if (resumeAt > cap.suspendedAt) {
      cap.gaps.push([cap.suspendedAt, resumeAt]);
    }
    this.clock.resume();
    cap.active = true;
    cap.suspended = false;
    cap.resumedAt = resumeAt;
    this.emit('capture-resumed', { gaps: cap.gaps.slice(), at: resumeAt });
    return { ok: true };
  };

  /** 另起一遍：旧 take 截断存为草稿 */
  Engine.prototype.restartCapture = function () {
    if (!this.capture) return;
    this._finalize(true);
    return this.startCapture();
  };

  Engine.prototype.stopCapture = function () {
    if (!this.capture) return { ok: false };
    const cap = this.capture;
    cap.active = false;
    return new Promise(resolve => {
      // 等平滑收敛，保证尾值守住在最终目标上
      cap.settleTimer = setTimeout(() => {
        this.processors.forEach((p, id) => {
          const b = this.store.state.bindings.find(x => x.id === id);
          if (b && b.armed && cap.points[b.controlId]) {
            const tail = p.smoother.flush();
            this._appendPoint(cap.points[b.controlId], this.clock.pos, tail);
          }
        });
        const take = this._finalize(false);
        resolve({ ok: true, take });
      }, SETTLE_MS);
    });
  };

  Engine.prototype._finalize = function (truncated) {
    const cap = this.capture;
    if (!cap) return null;
    this._closeGestures(this.clock.pos);
    this._persistDraftNow(); // 确保最新点都落盘
    let unionDisputes = [];
    const points = Object.keys(cap.points).map(cid => {
      const slot = cap.points[cid];
      unionDisputes = unionDisputes.concat(slot.disputes || []);
      return {
        controlId: cid,
        bindingId: slot.bindingId,
        pts: slot.pts.slice().sort((a, b) => a.t - b.t),
        gestureSpans: slot.gestureSpans || [],
        disputes: slot.disputes || [],
      };
    });
    const end = cap.stop > cap.start ? cap.stop : cap.start + 0.1;
    const take = {
      id: cap.takeId,
      fp: this.store.state.projectFp,
      state: 'draft',
      writeMode: cap.writeMode,
      start: cap.start,
      end,
      points,
      disputes: MConsole.util.mergeRanges(unionDisputes),
      gaps: cap.gaps.slice(),
      lateDropped: cap.lateDropped,
      truncated: !!truncated,
      createdAt: Date.now(),
    };
    // 替换（upsert）采集期间的实时草稿，而非再插入一份
    this.store.state.takes = [take].concat(this.store.state.takes.filter(t => t.id !== cap.takeId));
    this.store.save();
    this.capture = null;
    this.emit('capture-ended', take);
    return take;
  };

  // ---------------- 草稿持久化（重载后仍保有）----------------
  Engine.prototype._scheduleDraftPersist = function () {
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => this._persistDraftNow(), 300);
  };
  Engine.prototype._persistDraftNow = function () {
    const cap = this.capture;
    if (!cap) return;
    this._closeGestures(this.clock.pos);
    const others = this.store.state.takes.filter(t => t.id !== cap.takeId);
    let unionDisputes = [];
    const draft = {
      id: cap.takeId,
      fp: this.store.state.projectFp,
      state: cap.suspended ? 'partial' : 'capturing',
      writeMode: cap.writeMode,
      start: cap.start,
      end: Math.max(cap.stop, this.clock.pos),
      points: Object.keys(cap.points).map(cid => {
        const s = cap.points[cid];
        unionDisputes = unionDisputes.concat(s.disputes || []);
        return {
          controlId: cid, bindingId: s.bindingId,
          pts: s.pts.slice(), gestureSpans: s.gestureSpans.slice(),
          disputes: (s.disputes || []).slice(),
        };
      }),
      disputes: MConsole.util.mergeRanges(unionDisputes),
      gaps: cap.gaps.slice(),
      lateDropped: cap.lateDropped,
      truncated: cap.suspended,
      createdAt: Date.now(),
    };
    this.store.state.takes = [draft].concat(others);
    this.store.saveNow();
    this.emit('draft-saved', draft);
  };

  // ---------------- 监听 ----------------
  Engine.prototype.toggleMonitor = function (takeId, on) {
    if (on) this.monitorTakeIds.add(takeId); else this.monitorTakeIds.delete(takeId);
    this.emit('monitor-changed');
  };
  Engine.prototype.isMonitoring = function (takeId) { return this.monitorTakeIds.has(takeId); };

  Engine.prototype._monitorFrame = function (pos) {
    if (!this.clock.playing) return;
    this.monitorTakeIds.forEach(id => {
      const take = this.store.state.takes.find(t => t.id === id);
      if (!take || pos < take.start || pos > take.end) return;
      take.points.forEach(seg => {
        const v = MConsole.util.samplePoints(seg.pts, pos);
        if (v !== null) this.store.state.live[seg.controlId] = clamp(v, 0, 1);
      });
    });
    if (this.monitorTakeIds.size) this.emit('live-changed');
  };

  // ---------------- 拼选 / 采纳 ----------------
  Engine.prototype.addSelection = function (takeId, rangeIn, rangeOut) {
    const take = this.store.state.takes.find(t => t.id === takeId);
    if (!take) return { ok: false, reason: 'take 不存在' };
    if (take.fp !== this.store.state.projectFp) return { ok: false, reason: '工程指纹不符：该草稿只供监听，不可采纳' };
    let lo = Math.max(take.start, Math.min(rangeIn, rangeOut));
    let hi = Math.min(take.end, Math.max(rangeIn, rangeOut));
    if (hi - lo < 0.005) return { ok: false, reason: '范围太小' };
    // 同一 take 的已有选区：重叠则替换该 take 的选择（一个 take 一段）
    this.compSelection = this.compSelection.filter(s => s.takeId !== takeId);
    this.compSelection.push({ takeId, in: lo, out: hi });
    this.compSelection.sort((a, b) => a.in - b.in);
    this.emit('selection-changed');
    return { ok: true };
  };
  Engine.prototype.clearSelection = function () { this.compSelection = []; this.emit('selection-changed'); };
  Engine.prototype.removeSelection = function (takeId) {
    this.compSelection = this.compSelection.filter(s => s.takeId !== takeId);
    this.emit('selection-changed');
  };

  /** 依据争议策略计算某段选区实际可写入的范围（争议按控件分段，gap 全局） */
  Engine.prototype.effectiveRanges = function (sel, policy, seg) {
    const take = this.store.state.takes.find(t => t.id === sel.takeId);
    if (!take) return [];
    const disputes = seg ? (seg.disputes || []) : take.disputes;
    if (policy === 'take') {
      // 套入 take：争议也写入（gap 仍然不可写入）
      return MConsole.util.subtractRanges(sel.in, sel.out, take.gaps);
    }
    // live / clean：争议与 gap 都从写入范围扣除
    return MConsole.util.subtractRanges(sel.in, sel.out, disputes.concat(take.gaps));
  };

  /**
   * 采纳：把所有选段按策略并入已采纳 lanes，形成单个撤销单元。
   * 晚到计算保护：采纳开始先浅拷贝 take 引用快照；本函数结束前不读 capture 新点，
   * 采集若仍在进行，其后续写入属于新版本，不会回写本次结果。 */
  Engine.prototype.adopt = function (policy) {
    policy = policy || 'live';
    if (!this.compSelection.length) return { ok: false, reason: '没有拼选范围' };
    const snapshot = this.compSelection.map(sel => {
      const take = this.store.state.takes.find(t => t.id === sel.takeId);
      return { sel, take };
    });
    if (snapshot.some(x => !x.take)) return { ok: false, reason: '部分 take 已被删除' };
    if (snapshot.some(x => x.take.fp !== this.store.state.projectFp)) {
      return { ok: false, reason: '存在工程指纹不符的草稿，只供监听' };
    }

    // 一个撤销单元包含全部拼选段
    this.store.pushUndo();

    let adoptedLen = 0;
    snapshot.forEach(({ sel, take }) => {
      const gestureUnion = (function () {
        const all = [];
        take.points.forEach(seg => seg.gestureSpans.forEach(g => all.push(g)));
        return MConsole.util.mergeRanges(all);
      })();

      take.points.forEach(seg => {
        const writeRangesAll = this.effectiveRanges(sel, policy, seg);
        writeRangesAll.forEach(r => { adoptedLen += r[1] - r[0]; });
        const mode = docWriteMode(take);
        // 触碰模式：实际写入范围与该分段的手势区间求交
        let ranges = writeRangesAll;
        if (mode === 'touch') {
          ranges = MConsole.util.intersectRanges(
            sel.in, sel.out,
            ranges.flatMap(r => intersectAll(r[0], r[1], seg.gestureSpans))
          );
        }
        // 锁存：从首次手势起写入到每个范围末尾；手势之前不写
        if (mode === 'latch') {
          const first = (seg.gestureSpans || []).length ? seg.gestureSpans[0][0] : take.end;
          ranges = ranges.map(r => [Math.max(r[0], first), r[1]]).filter(r => r[1] - r[0] > 0.005);
        }
        if (!ranges.length) return;

        const ctrlId = seg.controlId;
        const lane = (this.store.state.lanes[ctrlId] || []).slice();
        // 手势前现场值：用 live；没有就用 take 起点值
        const preV = this.store.state.live[ctrlId] != null
          ? this.store.state.live[ctrlId]
          : MConsole.util.samplePoints(seg.pts, take.start);
        ranges.forEach(r => {
          let pts;
          if (mode === 'touch' || mode === 'latch') {
            // touch/latch：手离开后保持最后一个手势值到范围末；
            // 区别仅在范围——touch 只覆盖手势区间，latch 从首次手势一直到停止。
            // 保持值取最后一个手势区间结束处 take 的值（而非范围末，那里可能已回落）。
            const spans = seg.gestureSpans || [];
            const holdSrc = mode === 'latch'
              ? (spans.length ? Math.min(spans[spans.length - 1][1], r[1]) : r[1])
              : r[1];
            const vHold = MConsole.util.samplePoints(seg.pts, holdSrc);
            pts = resampleSegment(seg.pts, r[0], r[1], vHold);
            if (mode === 'latch') pts[0] = { t: r[0], v: MConsole.util.samplePoints(seg.pts, r[0]) };
          } else {
            pts = resampleSegment(seg.pts, r[0], r[1]);
          }
          punch(lane, r[0], r[1], pts);
        });
        // 触碰模式：选区起点到首个手势之间钉住手势前现场值（手势前不动现场）。
        // 终点停在手势起点前 STEP，把手势起点本身让给 touch 段（那里应已是手势值）。
        if (mode === 'touch' && (seg.gestureSpans || []).length) {
          const STEP = 0.002;
          const firstG = seg.gestureSpans[0][0];
          if (firstG > sel.in + 0.005) {
            punch(lane, sel.in, firstG - STEP, [
              { t: sel.in, v: preV }, { t: firstG - STEP, v: preV },
            ]);
          }
        }
        this.store.state.lanes[ctrlId] = dedupeLane(lane);
      });

      // 争议策略 = live：争议段全程保持现场值，争议后无缝回到 take
      if (policy === 'live') {
        take.points.forEach(seg => {
          const dispRanges = intersectAll(sel.in, sel.out, seg.disputes || []);
          if (!dispRanges.length) return;
          const lane = (this.store.state.lanes[seg.controlId] || []).slice();
          const liveV = this.store.state.live[seg.controlId] != null ? this.store.state.live[seg.controlId] : 0.5;
          const EPS = 0.002;
          dispRanges.forEach(r => {
            // 争议两端都钉现场值；末端稍后处插 take 值锚点，保证争议后恢复
            const resumeV = MConsole.util.samplePoints(seg.pts, Math.min(r[1] + EPS, sel.out));
            punch(lane, r[0], r[1], [
              { t: r[0], v: liveV },
              { t: r[1], v: liveV },
              { t: r[1] + EPS, v: resumeV == null ? liveV : resumeV },
            ]);
          });
          this.store.state.lanes[seg.controlId] = dedupeLane(lane);
        });
      }
    });

    this.store.save();
    this.emit('adopted', { length: adoptedLen, count: snapshot.length });
    this.clearSelection();
    return { ok: true, length: adoptedLen };
  };

  Engine.prototype.undo = function () {
    if (!this.store.undo()) return false;
    this.emit('undo-applied');
    return true;
  };

  // ---------------- 健康/状态视图 ----------------
  Engine.prototype.bindingHealth = function (b) {
    const p = this.hub.getPort(b.port.id);
    if (!p) return { state: 'offline', label: '缺席（保持离线）' };
    if (p.identityMismatch) return { state: 'mismatch', label: '身份不符，拒绝重认' };
    if (!p.online) return { state: 'offline', label: '离线' };
    return { state: 'online', label: '在线', lagMs: p.lastLagMs };
  };

  Engine.prototype.disputedBindings = function () {
    const cap = this.capture;
    if (!cap) return new Set();
    const out = new Set();
    Object.keys(cap.points).forEach(cid => {
      const slot = cap.points[cid];
      if ((slot.disputes || []).length) out.add(slot.bindingId);
    });
    return out;
  };

  // ---------------- 纯函数工具（导出便于测试）----------------
  Engine.fn = {
    effectiveRangesStatic: function (take, inS, outS, policy, seg) {
      const disputes = seg ? (seg.disputes || take.disputes) : take.disputes;
      if (policy === 'take') return MConsole.util.subtractRanges(inS, outS, take.gaps);
      return MConsole.util.subtractRanges(inS, outS, disputes.concat(take.gaps));
    },
    resampleSegment, punch, dedupeLane,
  };

  function intersectAll(start, end, ranges) {
    const out = [];
    MConsole.util.mergeRanges(ranges).forEach(r => {
      const a = Math.max(start, r[0]), b = Math.min(end, r[1]);
      if (b - a > 1e-6) out.push([a, b]);
    });
    return out;
  }

  /** 在 [s,e] 边界采样折线，输出可直接 punch 的点（包含两端锚点）。
   *  holdEnd 非 null 时（锁存）末点强制为该值，区间内保持。 */
  function resampleSegment(pts, s, e, holdEnd) {
    const out = [{ t: s, v: MConsole.util.samplePoints(pts, s) }];
    pts.forEach(p => { if (p.t > s + COALESCE_S && p.t < e - COALESCE_S) out.push({ t: p.t, v: p.v }); });
    out.push({ t: e, v: holdEnd != null ? holdEnd : MConsole.util.samplePoints(pts, e) });
    return out;
  }

  /** 非破坏 punch：清掉 lane 中落在 (s,e) 的点，插入新点，并保证边界连续 */
  function punch(lane, s, e, pts) {
    // 边界锚点：在 s/e 处按原 lane 取值，保证 punch 区间外波形不跳变。
    // 先放边界锚、再放调用方 pts：同时间戳时调用方显式给定的值优先。
    // 若调用方在 s 处的值与边界前旧值不同（拼选边界的阶跃），
    // 在 s-STEP 处钉住旧值，使新段不会把斜坡倒灌进前一段。
    const STEP = 0.002;
    const before = MConsole.util.samplePoints(lane, s);
    const after = MConsole.util.samplePoints(lane, e);
    for (let i = lane.length - 1; i >= 0; i--) {
      if (lane[i].t > s && lane[i].t < e) lane.splice(i, 1);
    }
    const byT = new Map();
    if (before !== null) byT.set(roundT(s), { t: s, v: before });
    if (after !== null) byT.set(roundT(e), { t: e, v: after });
    lane.forEach(p => byT.set(roundT(p.t), p));
    pts.forEach(p => {
      if (Math.abs(p.t - s) < 1e-9 && before !== null && Math.abs(p.v - before) > 1e-6 && s - STEP >= 0) {
        byT.set(roundT(s - STEP), { t: s - STEP, v: before });
      }
      byT.set(roundT(p.t), p); // 显式点覆盖边界锚
    });
    lane.length = 0;
    Array.from(byT.values()).sort((a, b) => a.t - b.t).forEach(p => lane.push(p));
  }
  function roundT(t) { return Math.round(t * 10000) / 10000; }

  function dedupeLane(lane) {
    // 1) 同时间戳已由 punch 处理；2) 移除相邻共线冗余点
    const comp = [];
    for (let i = 0; i < lane.length; i++) {
      const prev = comp[comp.length - 1];
      const next = lane[i + 1];
      const p = lane[i];
      if (prev && next && next.t > prev.t) {
        const k = (p.t - prev.t) / (next.t - prev.t);
        if (k > 0 && k < 1) {
          const expect = prev.v + (next.v - prev.v) * k;
          if (Math.abs(expect - p.v) < 0.0005) continue;
        }
      }
      comp.push(p);
    }
    return comp;
  }

  function docWriteMode(take) { return take.writeMode || 'overwrite'; }

  MConsole.Engine = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
