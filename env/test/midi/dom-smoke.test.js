'use strict';
/* DOM 桩冒烟：加载 UI/main，确保引导与各渲染路径不抛引用错误。
 * 不验证视觉，只抓接线/拼写/空引用问题。 */
const path = require('path');
const fs = require('fs');

function makeEl(tag) {
  const el = {
    tagName: tag || 'div',
    style: {},
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    title: '',
    clientWidth: 300,
    clientHeight: 100,
    width: 0, height: 0,
    _children: [],
    _attrs: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] != null ? this._attrs[k] : null; },
    appendChild(c) { this._children.push(c); return c; },
    remove() {},
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 26, right: 300, bottom: 26 }; },
    getContext() {
      return new Proxy({}, { get: (t, p) => {
        if (p === 'canvas') return el;
        if (p === 'measureText') return () => ({ width: 10 });
        if (p === 'getLineDash') return () => [];
        return typeof t[p] !== 'undefined' ? t[p] : (() => {});
      }, set: () => true });
    },
    querySelector() { return makeEl('q'); },
    querySelectorAll() { return []; },
    focus() {}, click() {},
  };
  return el;
}

const byId = new Map();
global.window = global;
global.devicePixelRatio = 1;
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => 1; // 不自旋
global.cancelAnimationFrame = () => {};
global.localStorage = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.navigator = {}; // 无 requestMIDIAccess → 走虚拟设备路径
const docListeners = {};
global.document = {
  hidden: false,
  getElementById(id) {
    if (!byId.has(id)) byId.set(id, makeEl('div'));
    return byId.get(id);
  },
  createElement(t) { return makeEl(t); },
  addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
  querySelector() { return null; },
  querySelectorAll(sel) {
    if (sel === 'input[name="writemode"]' || sel === 'input[name="dispute"]') {
      // 给单选组一个被勾选项
      const a = makeEl('input'); a.value = 'overwrite'; a.checked = true;
      const b = makeEl('input'); b.value = 'live'; b.checked = true;
      return sel.includes('writemode') ? [a] : [b];
    }
    return [];
  },
};

const DIR = path.join(__dirname, '..', '..', 'public', 'midi');
const order = ['midi-util.js', 'midi-store.js', 'midi-mapping.js', 'midi-midi.js', 'midi-clock.js',
  'midi-engine.js', 'midi-transport.js', 'midi-timeline.js', 'midi-ui.js', 'midi-main.js'];
let failures = 0;
const pending = [];
function check(name, fn) {
  let ret;
  try { ret = fn(); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); failures++; return; }
  if (ret && typeof ret.then === 'function') {
    pending.push(ret.then(() => console.log('  ✓ ' + name))
      .catch(e => { console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); failures++; }));
  } else {
    console.log('  ✓ ' + name);
  }
}

// 顺序加载（含 main 引导）
check('脚本全部加载（含 midi-main 引导）', () => {
  order.forEach(f => { require(path.join(DIR, f)); });
  if (!global.__mconsole) throw new Error('main 未初始化 __mconsole');
});

const { engine, hub, store, ui, clock } = global.__mconsole || {};

check('初始渲染不抛错', () => {
  ui.renderPorts(); ui.renderBindings(); ui.renderRack(); ui.renderTakes();
  ui.renderCompStatus(); ui.drawTakeStrips();
});

check('添加/拔出/插回虚拟设备渲染', () => {
  const dev = hub.addVirtual(0);
  ui.renderPorts(); ui.renderVirtualPanels();
  hub.removeVirtual(dev.id); ui.renderPorts();
  hub.replugVirtual(dev.id); ui.renderPorts();
});

check('配对学习 → CC 建立绑定并渲染', () => {
  const dev = hub.listPorts().find(p => p.virtual);
  engine.startLearn('f0');
  ui.setPairing(true, 'f0');
  hub.sendVirtualCC(dev.id, 0, 16, 10);
  hub.sendVirtualCC(dev.id, 0, 16, 80);
  if (!store.state.bindings.length) throw new Error('未建立绑定');
  ui.renderBindings(); ui.renderRack();
});

check('冲突条三选一渲染', () => {
  const dev = hub.listPorts().find(p => p.virtual);
  engine.startLearn('f1');
  hub.sendVirtualCC(dev.id, 0, 16, 10);
  hub.sendVirtualCC(dev.id, 0, 16, 80);
  ui.showConflict('dev CH1 CC16');
  engine.resolveConflict('share');
  ui.hideConflict();
  ui.renderBindings();
});

// 顺序链：依赖采集状态的检查必须排队执行
let chain = Promise.resolve();
function checkSeq(name, fn) {
  chain = chain.then(() => new Promise(resolve => {
    Promise.resolve()
      .then(fn)
      .then(() => { console.log('  ✓ ' + name); resolve(); })
      .catch(e => { console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); failures++; resolve(); });
  }));
  pending.push(chain);
}

checkSeq('武装 → 采集 → 注入点 → 挂起/续接/另起 → 停止 → take 渲染', async () => {
  const b = store.state.bindings[0];
  engine.setArmed(b.id, true);
  let r = engine.startCapture();
  if (!r.ok) throw new Error('采集启动失败: ' + r.reason);
  const dev = hub.listPorts().find(p => p.virtual);
  // 用明确的历史时间戳注入，形成 0.2s 跨度的 take（验证时间戳投射路径）
  const base = clock._perfAnchor;
  for (let i = 1; i <= 5; i++) hub._dispatch(dev, 0, 16, i * 24, base + i * 50);
  engine.noteMouseTouch('f0');
  ui.setCaptureState('采集中', true);

  // 挂起 / 横幅 / 续接
  engine.suspendCapture('测试挂起');
  ui.showSuspend('测试挂起');
  const resume = engine.resumeCapture();
  if (!resume.ok) throw new Error('续接失败: ' + resume.reason);
  ui.hideSuspend();

  // 另起一遍，并向新 take 注入带时间跨度的点
  engine.restartCapture();
  if (!engine.capture) throw new Error('另起后应在采集');
  const base2 = clock._perfAnchor;
  for (let i = 1; i <= 5; i++) hub._dispatch(dev, 0, 16, i * 20, base2 + i * 60);

  const stop = await engine.stopCapture();
  if (!stop.ok) throw new Error('停止失败');
  ui.setCaptureState('', false);
  ui.renderTakes(); ui.drawTakeStrips();
  global.__mconsole.timeline.render();
});

checkSeq('拖选拼选 + 三策略采纳/撤销不抛错', () => {
  const t = store.state.takes[0];
  ['live', 'take', 'clean'].forEach(policy => {
    engine.clearSelection();
    const r = engine.addSelection(t.id, t.start + 0.05, t.end - 0.05);
    if (!r.ok) throw new Error('加选区失败: ' + r.reason);
    ui.renderCompStatus(); ui.drawTakeStrips();
    const a = engine.adopt(policy);
    if (!a.ok) throw new Error(policy + ' 采纳失败: ' + a.reason);
    engine.undo();
  });
});

check('工程轮换后异工程 take 只供监听', () => {
  store.addTake({
    id: 'foreignT', fp: 'PRJ-X', state: 'draft', writeMode: 'overwrite',
    start: 0, end: 1, points: [{ controlId: 'f0', pts: [{ t: 0, v: 0.5 }], gestureSpans: [], disputes: [] }],
    disputes: [], gaps: [], lateDropped: 0, createdAt: 1,
  });
  ui.renderTakes();
  const r = engine.addSelection('foreignT', 0, 1);
  if (r.ok) throw new Error('异工程 take 不应允许拼选');
});

Promise.all(pending).then(() => {
  if (failures) { console.error('\nDOM 冒烟失败 ' + failures + ' 项'); process.exit(1); }
  console.log('\nDOM 冒烟全部通过');
  process.exit(0);
});
