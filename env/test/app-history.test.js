'use strict';

/* app.js 历史/分支/检查点 UI 集成测试：用最小 DOM 桩驱动真实应用代码。
   状态通过真实 UI（按钮/事件）推进；每类操作独立构造前提。 */

const assert = require('assert');

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { cs.forEach(c => this.set.add(c)); }
  remove(...cs) { cs.forEach(c => this.set.delete(c)); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
  contains(c) { return this.set.has(c); }
}
const ctx2dStub = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = typeof k === 'string' && /^[a-z]/.test(k) ? () => {} : undefined)),
  set: (t, k, v) => { t[k] = v; return true; },
});
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.parentNode = null;
    this.style = {}; this.classList = new FakeClassList();
    this.listeners = {};
    this.textContent = ''; this.hidden = false;
    this.value = ''; this.href = ''; this.download = '';
    this.width = 0; this.height = 0; this.files = [];
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  set innerHTML(v) { if (v === '') this.children = []; }
  get innerHTML() { return ''; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const l = this.listeners[t];
    if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
  }
  dispatch(t, ev) {
    ev = ev || {}; if (!('target' in ev)) ev.target = this;
    (this.listeners[t] || []).slice().forEach(f => f(ev));
  }
  click() { this.dispatch('click', {}); }
  getContext() { return ctx2dStub(); }
  setPointerCapture() {} releasePointerCapture() {} scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 28 }; }
  querySelector(sel) { return new FakeElement(); }
}
const byId = {};
function el(id) {
  if (!byId[id]) byId[id] = new FakeElement(id === 'ruler' ? 'canvas' : (id === 'branchSel' ? 'select' : 'div'));
  return byId[id];
}
global.document = {
  querySelector: s => el(s.replace(/^#/, '')),
  createElement: t => new FakeElement(t),
  addEventListener() {},
};
global.window = global; global.self = global;
global.alert = m => { throw new Error('不应 alert: ' + m); };
const prompts = [];
global.prompt = () => (prompts.length ? prompts.shift() : null);
global.requestAnimationFrame = () => 1;
const ls = new Map();
global.localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
};
global.URL = { createObjectURL: () => 'blob:m' + Math.random(), revokeObjectURL() {} };
class FakeAudioContext {
  constructor() { this.sampleRate = 8000; this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: n => n }; }
  createDynamicsCompressor() { return { connect: n => n }; }
  createBuffer(ch, len, sr) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, sampleRate: sr, length: len, duration: len / sr, getChannelData: i => data[i] };
  }
  createBufferSource() { return { buffer: null, connect: n => n, start() {}, stop() {} }; }
  decodeAudioData(ab) {
    const dv = new DataView(ab);
    const sr = dv.getUint32(24, true), n = dv.getUint32(40, true) / 2;
    const ch0 = new Float32Array(n);
    for (let i = 0; i < n; i++) ch0[i] = dv.getInt16(44 + i * 2, true) / 32768;
    return Promise.resolve({ numberOfChannels: 1, sampleRate: sr, length: n, duration: n / sr, getChannelData: () => ch0 });
  }
}
global.AudioContext = FakeAudioContext;

Object.assign(global, require('../public/export-core.js'));
Object.assign(global, require('../public/history-core.js'));
Object.assign(global, require('../public/wal-core.js'));
Object.assign(global, require('../public/idb-kv.js'));
Object.assign(global, require('../public/store.js'));
require('../public/app.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
async function run() {
  for (const [name, fn] of tests) {
    store = await resetAppForTest(); // 每个用例独立的干净引擎 + 内存 KV
    try { await fn(); passed++; console.log('  ok - ' + name); }
    catch (e) { console.error('  FAIL - ' + name); console.error(e); process.exitCode = 1; }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let store;
const clips = () => store.eng.doc.clips;
const undoBtn = () => el('btnUndo');
const redoBtn = () => el('btnRedo');
function demoClick(n) { for (let i = 0; i < n; i++) el('btnDemo').click(); }
function clickClip(i, mod) {
  el('lanes').children[i].dispatch('pointerdown', Object.assign({ pointerId: 1, clientX: 0 }, mod || {}));
}
/* 回到主分支末端（干净前提） */
function gotoMainHead() {
  const mainOpt = [...el('branchSel').children].find(o => o.textContent.includes('主分支'));
  el('branchSel').value = mainOpt.value; el('branchSel').dispatch('change');
  while (redoBtn().disabled === false) redoBtn().click();
}

(async () => {
  store = await bootAppForTest();

  test('初始：撤销/重做按钮禁用', () => {
    assert.strictEqual(undoBtn().disabled, true);
    assert.strictEqual(redoBtn().disabled, true);
  });

  test('导入按真实顺序逐个撤销/重做，按钮门控正确', () => {
    demoClick(2);
    assert.strictEqual(clips().length, 2);
    assert.strictEqual(undoBtn().disabled, false);
    assert.strictEqual(redoBtn().disabled, true);
    undoBtn().click(); assert.strictEqual(clips().length, 1);
    undoBtn().click(); assert.strictEqual(clips().length, 0);
    assert.strictEqual(undoBtn().disabled, true);
    assert.strictEqual(redoBtn().disabled, false);
    redoBtn().click(); assert.strictEqual(clips().length, 1);
    redoBtn().click(); assert.strictEqual(clips().length, 2);
    assert.strictEqual(redoBtn().disabled, true);
  });

  test('连续调节增益（多个 input）合并为一个撤销步', () => {
    demoClick(1);
    const depth0 = undoDepth(store.eng);
    clickClip(0);
    el('pGain').dispatch('pointerdown');
    for (let i = 0; i < 5; i++) { el('pGain').value = String(0.3 + i * 0.1); el('pGain').dispatch('input'); }
    el('pGain').dispatch('pointerup');
    assert.strictEqual(undoDepth(store.eng), depth0 + 1, '5 次 input 只 +1 步');
    const before = clips()[0].gain;
    undoBtn().click();
    assert.strictEqual(clips()[0].gain, 1, '一次撤销回到手势前');
    assert.ok(Math.abs(before - 0.7) < 1e-9, '最终值是最后一次 input');
    redoBtn().click();
    assert.ok(Math.abs(clips()[0].gain - 0.7) < 1e-9);
  });

  test('两次独立的滑杆拖动产生两个撤销步（手势边界正确）', () => {
    demoClick(1);
    const d0 = undoDepth(store.eng);
    clickClip(0);
    el('pGain').dispatch('pointerdown');
    el('pGain').value = '0.3'; el('pGain').dispatch('input');
    el('pGain').dispatch('pointerup');
    el('pGain').dispatch('pointerdown');
    el('pGain').value = '0.8'; el('pGain').dispatch('input');
    el('pGain').dispatch('pointerup');
    assert.strictEqual(undoDepth(store.eng), d0 + 2, '两次拖动 = 两步');
    undoBtn().click();
    assert.ok(Math.abs(clips()[0].gain - 0.3) < 1e-9, '第一次撤销回到第一次拖动结束值');
    undoBtn().click();
    assert.strictEqual(clips()[0].gain, 1, '第二次撤销回到初始');
  });

  test('撤销后继续编辑自动分叉，原 redo 路径保留可切回', () => {
    demoClick(2);
    const before = el('branchSel').children.length;
    while (clips().length) undoBtn().click(); // 一路撤到底
    assert.strictEqual(clips().length, 0);
    demoClick(1); // 非末端编辑 ⇒ fork
    assert.strictEqual(el('branchSel').children.length, before + 1);
    assert.strictEqual(clips().length, 1);
    // 切回主分支，原来 2 个片段还在
    const mainOpt = [...el('branchSel').children].find(o => o.textContent.includes('主分支'));
    el('branchSel').value = mainOpt.value; el('branchSel').dispatch('change');
    assert.strictEqual(clips().length, 2);
    // 切回自动分叉
    const forkOpt = [...el('branchSel').children].find(o => o.textContent.includes('分叉'));
    assert.ok(forkOpt, '自动分叉有可识别名称');
    el('branchSel').value = forkOpt.value; el('branchSel').dispatch('change');
    assert.strictEqual(clips().length, 1);
  });

  test('显式新建命名分支', () => {
    prompts.push('实验A');
    el('btnNewBranch').click();
    assert.ok(branchesList(store.eng).some(b => b.name === '实验A' && b.current));
  });

  test('检查点：比较/预览不污染工作状态，恢复为新分支后可回原分支', () => {
    demoClick(2);
    assert.strictEqual(clips().length, 2);
    el('cpName').value = '基线'; el('btnCp').click();
    const cp = Object.values(store.eng.checkpoints).find(c => c.name === '基线');
    assert.ok(cp);
    // 修改第 0 个片段增益（保留它，稍后作为 changed 验证）；删除第 1 个；再新增 1 个
    clickClip(0);
    el('pGain').dispatch('pointerdown');
    el('pGain').value = '0.25'; el('pGain').dispatch('input'); el('pGain').dispatch('pointerup');
    clickClip(1);
    el('pDelete').click();
    demoClick(1);
    const diff = diffAgainstNode(store.eng, cp.node);
    assert.strictEqual(diff.removed.length, 1, '删除 1 个');
    assert.strictEqual(diff.added.length, 1, '新增 1 个');
    assert.ok(diff.changed.some(c => 'gain' in c.fields), '存活片段记录了增益变化');
    // 预览
    previewCheckpointByName('基线');
    assert.strictEqual(el('previewBar').hidden, false);
    assert.strictEqual(store.eng.doc.clips.length, 2, '工作文档未被污染');
    // 从预览恢复为新分支
    el('pvFork').click();
    assert.strictEqual(el('previewBar').hidden, true);
    assert.strictEqual(store.eng.branchId === 'b-main', false);
    assert.strictEqual(clips().length, 2, '恢复到检查点：2 个片段');
    assert.ok(clips().every(c => c.gain === 1), '检查点参数（增益归位）');
    // 回原分支，编辑都还在
    const backMain = [...el('branchSel').children].find(o => o.textContent.includes('主分支'));
    el('branchSel').value = backMain.value; el('branchSel').dispatch('change');
    assert.ok(clips().some(c => Math.abs(c.gain - 0.25) < 1e-9), '原分支增益编辑仍在');
  });

  test('批量删除 = 一次撤销', () => {
    demoClick(4);
    const n = clips().length;
    assert.strictEqual(n, 4);
    const lanes = el('lanes');
    // 先普通点选第 0 个（清掉任何残留多选），再 Ctrl 增选第 1 个
    lanes.children[0].dispatch('pointerdown', { pointerId: 1, clientX: 0 });
    lanes.children[1].dispatch('pointerdown', { pointerId: 1, clientX: 0, ctrlKey: true });
    assert.strictEqual(el('multiBox').hidden, false);
    const d0 = undoDepth(store.eng);
    el('mDelete').click();
    assert.strictEqual(clips().length, n - 2);
    assert.strictEqual(undoDepth(store.eng), d0 + 1, '批量删除一步');
    undoBtn().click();
    assert.strictEqual(clips().length, n, '一次撤销两个都回来');
  });

  test('素材缺失标记可撤销/重做（mediaStatus 走历史）', () => {
    demoClick(1);
    const hash = clips()[0].mediaHash;
    store.markMedia(hash, { missing: true }, '标记素材缺失');
    assert.strictEqual(store.eng.doc.media[hash].missing, true);
    undoBtn().click();
    assert.strictEqual(store.eng.doc.media[hash].missing, false);
    redoBtn().click();
    assert.strictEqual(store.eng.doc.media[hash].missing, true);
  });

  test('历史列表随当前位置更新，且当前节点高亮', () => {
    demoClick(2);
    const rows = el('historyList').children;
    assert.ok(rows.length >= 2);
    assert.ok(rows.some(r => r.classList.contains('current')));
  });

  await run();
  console.log(passed + ' 项 app 历史集成测试通过');

  /* 通过检查点行按钮触发预览（桩里按钮已挂事件） */
  function previewCheckpointByName(name) {
    const row = [...el('checkpoints').children].find(r => r.children[0].textContent.includes(name));
    [...row.children].find(b => b.textContent === '比较/预览').click();
  }
})().catch(e => { console.error(e); process.exit(1); });
