'use strict';
/* midi-store.js — 状态模型 + localStorage 持久化
 *
 * 持久化内容：工程指纹、配对表(bindings)、武装项、已存/草稿 takes、
 * 每个控件已采纳自动化 lanes、撤销栈。换工程（指纹不符）的 take 只供监听。 */
(function (global) {
  const MConsole = global.MConsole;
  const { uid, shortHash, Emitter } = MConsole.util;

  const KEY = 'mconsole.v1';
  const MAX_UNDO = 50;

  // 软件控件定义：8 推子 + 6 旋钮
  const CONTROL_DEFS = (function () {
    const defs = [];
    const names = ['主唱', '和声', '吉他', '贝斯', '键盘', '鼓组', '弦乐', '效果返回'];
    for (let i = 0; i < 8; i++) defs.push({ id: 'f' + i, kind: 'fader', name: names[i] });
    for (let i = 0; i < 6; i++) defs.push({ id: 'k' + i, kind: 'knob', name: '声相 ' + (i + 1) });
    return defs;
  })();

  function defaultLive() {
    const live = {};
    CONTROL_DEFS.forEach(d => { live[d.id] = d.kind === 'knob' ? 0.5 : 0.72; });
    return live;
  }

  function freshProjectFp() {
    return 'PRJ-' + shortHash('project' + Date.now() + Math.random().toString(36), 6);
  }

  function createState() {
    return {
      version: 1,
      projectFp: freshProjectFp(),
      controls: CONTROL_DEFS.map(d => ({ ...d })),
      live: defaultLive(),              // 软件控件现场值 0..1
      lanes: {},                        // controlId -> [{t,v}] 已采纳自动化
      bindings: [],                     // 见 Binding 结构
      takes: [],                        // 已结束/草稿 take
      undoStack: [],                    // 采纳快照（lanes 深拷贝）
      settings: { smooth: 0.55, clipOOB: true, writeMode: 'overwrite' },
    };
  }

  /*
   * Binding:
   *  { id, controlId, group:[bindingIds共享同一条消息],
   *    port:{ id, name, manufacturer, fp }, ch(0..15), cc,
   *    inMin,inMax (MIDI 原始范围), outMin,outMax (0..1 值域),
   *    invert, curve ('linear'|'exp'|'log'|'scurve'),
   *    smooth (0..1), clip (越界裁切), armed,
   *    sharedWith:[controlIds...] }
   *
   * Take:
   *  { id, fp, state:'draft'|'partial'(挂起中) , writeMode,
   *    start, end, points:[{controlId, pts:[{t,v}]}],
   *    disputes:[[s,e]...], gaps:[[s,e]...],
   *    createdAt, truncated }
   */

  function Store(opts) {
    Emitter.call(this);
    this._key = (opts && opts.key) || KEY;
    this.state = null;
    this._saveTimer = null;
    this.load();
  }
  Store.prototype = Object.create(Emitter.prototype);

  Store.prototype.load = function () {
    let s = null;
    try {
      const raw = global.localStorage && localStorage.getItem(this._key);
      if (raw) {
        s = JSON.parse(raw);
        if (!s || s.version !== 1 || !Array.isArray(s.bindings)) throw new Error('bad');
        // 控件表始终以当前定义为准（软件侧升级不影响配对）
        const live = defaultLive();
        Object.assign(live, s.live || {});
        s.live = live;
        s.controls = CONTROL_DEFS.map(d => ({ ...d }));
        s.lanes = s.lanes || {};
        s.takes = s.takes || [];
        s.undoStack = s.undoStack || [];
        s.settings = Object.assign({ smooth: 0.55, clipOOB: true, writeMode: 'overwrite' }, s.settings || {});
        // 重载后：partial 一律视为被打断的草稿
        s.takes.forEach(t => { if (t.state === 'partial' || t.state === 'capturing') { t.state = 'draft'; t.truncated = true; } });
      }
    } catch (e) {
      console.warn('MConsole: 持久化读取失败，使用空状态', e);
      s = null;
    }
    this.state = s || createState();
  };

  Store.prototype.save = function () {
    if (!global.localStorage) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(this._key, JSON.stringify(this.state));
        this.emit('saved');
      } catch (e) {
        console.warn('MConsole: 持久化写入失败', e);
        this.emit('save-error', e);
      }
    }, 150);
  };

  Store.prototype.saveNow = function () {
    if (!global.localStorage) return;
    clearTimeout(this._saveTimer);
    try { localStorage.setItem(this._key, JSON.stringify(this.state)); } catch (e) {}
  };

  Store.prototype.rotateProject = function () {
    this.state.projectFp = freshProjectFp();
    // 武装解除（换工程后需重新确认）
    this.state.bindings.forEach(b => { b.armed = false; });
    this.save();
    this.emit('project-rotated', this.state.projectFp);
  };

  // ---- bindings ----
  Store.prototype.findBindings = function (portId, ch, cc) {
    return this.state.bindings.filter(b => b.port.id === portId && b.ch === ch && b.cc === cc);
  };
  Store.prototype.bindingForControl = function (controlId) {
    return this.state.bindings.filter(b => b.controlId === controlId);
  };
  Store.prototype.addBinding = function (b) {
    b.id = b.id || uid('b');
    b.group = b.group || [b.id];
    b.sharedWith = b.sharedWith || [];
    this.state.bindings.push(b);
    this.save();
    return b;
  };
  Store.prototype.removeBinding = function (id) {
    const b = this.state.bindings.find(x => x.id === id);
    if (!b) return;
    const removedControl = b.controlId;
    // 共享组其它成员摘掉该绑定 id 与该控件名
    this.state.bindings.forEach(x => {
      if (x.id === id) return;
      x.group = (x.group || []).filter(g => g !== id);
      x.sharedWith = (x.sharedWith || []).filter(c => c !== removedControl);
    });
    this.state.bindings = this.state.bindings.filter(x => x.id !== id);
    this.save();
  };
  Store.prototype.updateBinding = function (id, patch) {
    const b = this.state.bindings.find(x => x.id === id);
    if (!b) return;
    Object.assign(b, patch);
    this.save();
  };

  // ---- takes ----
  Store.prototype.addTake = function (t) {
    t.id = t.id || uid('t');
    this.state.takes.unshift(t);
    this.save();
    return t;
  };
  Store.prototype.updateTake = function (id, patch) {
    const t = this.state.takes.find(x => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    this.save();
  };
  Store.prototype.removeTake = function (id) {
    this.state.takes = this.state.takes.filter(t => t.id !== id);
    this.save();
  };

  // ---- undo（只针对 lanes，采纳为一个单元）----
  Store.prototype.pushUndo = function () {
    this.state.undoStack.push(JSON.stringify({ lanes: this.state.lanes, live: this.state.live }));
    if (this.state.undoStack.length > MAX_UNDO) this.state.undoStack.shift();
    this.save();
  };
  Store.prototype.canUndo = function () { return this.state.undoStack.length > 0; };
  Store.prototype.undo = function () {
    const snap = this.state.undoStack.pop();
    if (!snap) return false;
    const data = JSON.parse(snap);
    this.state.lanes = data.lanes;
    this.state.live = data.live;
    this.save();
    return true;
  };

  MConsole.Store = Store;
  MConsole.CONTROL_DEFS = CONTROL_DEFS;
})(typeof window !== 'undefined' ? window : globalThis);
