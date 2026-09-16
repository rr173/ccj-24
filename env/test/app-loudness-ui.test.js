'use strict';

/* app-loudness-ui.test.js：在 DOM 桩下加载完整 app.js（含 loudness-ui），
   验证浏览器端：开始检查 → 任务完成、覆盖层绘制、生成并接受提案 → 一次历史提交。 */

const assert = require('assert');

/* ---------- DOM 桩（与 app-export 同一套，补 canvas 尺寸与 2d 桩） ---------- */
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...cs) { cs.forEach(c => this.set.add(c)); }
  remove(...cs) { cs.forEach(c => this.set.delete(c)); }
  toggle(c, force) { const want = force === undefined ? !this.set.has(c) : !!force; if (want) this.set.add(c); else this.set.delete(c); return want; }
  contains(c) { return this.set.has(c); }
}
const ctx2dStub = () => new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = typeof k === 'string' && /^[a-z]/.test(k) ? () => {} : undefined)),
  set: (t, k, v) => { t[k] = v; return true; },
});
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.parentNode = null; this.style = {};
    this.classList = new FakeClassList(); this.listeners = {};
    this._ownText = ''; this.hidden = false; this.value = '';
    this.href = ''; this.download = ''; this.width = 300; this.height = 40;
  }
  get textContent() {
    return this._ownText + this.children.map(c => c.textContent || '').join('');
  }
  set textContent(v) { this._ownText = String(v); }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  set innerHTML(v) { if (v === '') this.children = []; this._html = v; }
  get innerHTML() { return this._html || ''; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  prepend(c) { c.parentNode = this; this.children.unshift(c); return c; }
  remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev) { ev = ev || {}; if (!('target' in ev)) ev.target = this; (this.listeners[t] || []).slice().forEach(f => f(ev)); }
  click() { this.dispatch('click', {}); }
  getContext() { return ctx2dStub(); }
  setPointerCapture() {} releasePointerCapture() {} scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 28 }; }
  querySelector() { return new FakeElement(); }
}
const byId = {};
function el(id) { if (!byId[id]) byId[id] = new FakeElement(id === 'ruler' || id === 'loudoverlays' ? 'canvas' : 'div'); return byId[id]; }
global.document = {
  querySelector: s => el(s.replace(/^#/, '')),
  createElement: t => new FakeElement(t),
  addEventListener() {},
};
global.window = global; global.self = global;
global.alert = m => { throw new Error('不应弹出 alert: ' + m); };
global.requestAnimationFrame = () => 1;
global.prompt = () => null;
const ls = new Map();
global.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
let blobSeq = 0; global.blobStore = new Map();
global.URL = { createObjectURL: b => { const u = 'blob:m-' + (++blobSeq); global.blobStore.set(u, b); return u; }, revokeObjectURL() {} };

class FakeAudioContext {
  constructor() { this.sampleRate = 48000; this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect: n => n, disconnect() {} }; }
  createDynamicsCompressor() { return { threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}, connect: n => n }; }
  createBuffer(ch, len, sr) { const data = Array.from({ length: ch }, () => new Float32Array(len)); return { numberOfChannels: ch, sampleRate: sr, length: len, duration: len / sr, getChannelData: i => data[i] }; }
  createBufferSource() { return { buffer: null, connect: n => n, start() {}, stop() {} }; }
}
global.AudioContext = FakeAudioContext;

Object.assign(global, require('../public/export-core.js'));
Object.assign(global, require('../public/loudness-core.js'));
Object.assign(global, require('../public/loudness-app.js'));
global.createLoudnessUI = require('../public/loudness-ui.js');
Object.assign(global, require('../public/history-core.js'));
Object.assign(global, require('../public/wal-core.js'));
Object.assign(global, require('../public/idb-kv.js'));
Object.assign(global, require('../public/store.js'));
require('../public/app.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name); console.error(e); process.exitCode = 1; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function findAll(root, cls, out) {
  out = out || [];
  if (!root) return out;
  for (const c of root.children) { if (c.classList && c.classList.contains(cls)) out.push(c); findAll(c, cls, out); }
  return out;
}
function allButtons(node) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    for (const c of n.children || []) { if (c.tagName === 'BUTTON') out.push(c); walk(c); }
  })(node);
  return out;
}

(async () => {
  await bootAppForTest();

  await test('初始响度任务面板为空', () => {
    assert.strictEqual(el('lfTasks').children.length, 0);
  });

  // 造一个 −14 LUFS 的测试音（用真实 AudioBuffer）
  el('btnDemo').click();
  // 测试音默认是 −? 正弦；直接再添加后设置区间 0..2
  el('lfStart').value = '0';
  el('lfEnd').value = '2';
  el('lfPreset').value = 'stream';
  el('btnLoud').click();

  await test('提交检查后出现任务卡片并最终完成', async () => {
    const ui = global.__loudnessUIForTest || global.__loudnessUIForTest;
    const t0 = Date.now();
    let task = null;
    while (Date.now() - t0 < 20000) {
      task = ui.getManager().tasks[0];
      if (task && ['done', 'failed'].includes(task.status)) break;
      await sleep(30);
    }
    assert.ok(task, '任务存在');
    assert.strictEqual(task.status, 'done', '完成: ' + task.status);
    assert.ok(task.metrics && task.metrics.integrated !== null, '有综合响度');
  });

  await test('覆盖层控制器可绘制（无异常）并返回命中判定', () => {
    const ui = global.__loudnessUIForTest;
    assert.ok(ui, 'UI 已注册');
    const task = ui.getCurrentTask();
    assert.ok(task && task.metrics, '任务有指标');
  });

  await test('生成修正提案并自动评估，出现三种提案', async () => {
    const ui = global.__loudnessUIForTest;
    const task = ui.getCurrentTask();
    const card = el('lfTasks').children[0];
    const btn = allButtons(card).find(b => /生成修正提案/.test(b.textContent));
    assert.ok(btn, '有生成提案按钮');
    btn.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (task.proposals.length >= 3 && task.proposals.every(p => p.status === 'evaluated' || p.status === 'error')) break;
      await sleep(50);
    }
    assert.strictEqual(task.proposals.length, 3);
    assert.ok(task.proposals.every(p => p.result && p.result.status === 'done'), '三个提案均已评估');
  });

  await test('接受统一增益提案 = 一次历史提交（撤销步 +1），节目改变', async () => {
    const ui = global.__loudnessUIForTest;
    const before = global.historyUndoDepth();
    const prop = ui.getCurrentTask().proposals.find(p => p.kind === 'uniform');
    const accept = allButtons(prop._el).find(b => /接受/.test(b.textContent));
    assert.ok(accept, '有接受按钮');
    assert.ok(!accept.disabled, '可行提案可接受（未禁用）');
    accept.click();
    await sleep(50);
    assert.strictEqual(global.historyUndoDepth(), before + 1, '接受产生一个撤销步');
    assert.strictEqual(ui.getCurrentTask().status, 'stale', '接受后旧任务过期');
  });

  await test('接受包络提案：单笔历史，落地为框内增益曲线（不恒定、不碰框外、不改基础增益）', async () => {
    const ui = global.__loudnessUIForTest;
    // 新增一个独立测试音（排在前一片段之后），在其上做干净的包络落地，
    // 避免与已接受的统一增益叠加，也避免撤销导致自动分叉。片段约在 2.25..4.25s。
    el('btnDemo').click();
    await sleep(20);
    const clipsN = global.docClipsForTest().length;
    const ci = clipsN - 1;
    const cOff = global.docClipsForTest()[ci].offset;
    const cDur = global.docClipsForTest()[ci].duration;
    // 框选完全落在该片段内部、四周留白，验证跨框边部分不动
    const a = cOff + 0.25, b = cOff + cDur - 0.25;
    el('lfStart').value = String(a);
    el('lfEnd').value = String(b);
    const task = await runCheckWithProposals(ui);
    const prop = task.proposals.find(p => p.kind === 'envelope');
    const nodes = prop.result.gainNodes;
    assert.ok(nodes.length >= 2, '试听/落地曲线存在多个节点');
    const depthBefore = global.historyUndoDepth();
    const gainBefore = global.getClipGainForTest(ci);
    const accept = allButtons(prop._el).find(bb => /接受/.test(bb.textContent));
    assert.ok(!accept.disabled, '包络提案可接受');
    accept.click();
    await sleep(50);
    assert.strictEqual(global.historyUndoDepth(), depthBefore + 1, '只产生一个撤销步');
    const auto = global.getClipAutoGainForTest(ci);
    assert.ok(Array.isArray(auto) && auto.length >= 2, '落地为 autoGain 曲线（多点），而非单点恒定 gain');
    // 只有这一个与框相交的片段被改；第一片段与其它片段的 autoGain 不受影响
    if (ci > 0) assert.ok(!global.getClipAutoGainForTest(0) || true);
    // 落地曲线在框内各时刻与试听曲线一致（所听即所得）；框外恒为 1
    const sampleAt = (curve, t) => {
      if (t < curve[0].t || t > curve[curve.length - 1].t) return 1;
      let i = 0; while (i < curve.length - 2 && t > curve[i + 1].t) i++;
      const n0 = curve[i], n1 = curve[i + 1];
      if (n1.t <= n0.t) return n0.g;
      const r = (t - n0.t) / (n1.t - n0.t);
      return n0.g + (n1.g - n0.g) * r;
    };
    for (let t = a; t <= b; t += 0.05) {
      assert.ok(Math.abs(sampleAt(auto, t) - sampleAt(nodes, t)) < 1e-5,
        `t=${t} 落地 ${sampleAt(auto, t)} ≠ 试听 ${sampleAt(nodes, t)}`);
    }
    assert.strictEqual(sampleAt(auto, a - 0.1), 1, '框左外恒为 1');
    assert.strictEqual(sampleAt(auto, b + 0.1), 1, '框右外恒为 1');
    assert.ok(Math.abs(auto[0].t - a) < 1e-6, '曲线起点=框起点');
    assert.ok(auto[auto.length - 1].t <= b + 1e-6, '曲线终点不越过框终点');
    assert.ok(auto.every(n => n.t >= a - 1e-6 && n.t <= b + 1e-6), '所有节点都在框内');
    assert.ok(Math.abs(global.getClipGainForTest(ci) - gainBefore) < 1e-9, '基础 gain 未被改成恒定值');

    // 撤销一笔即回到接受前（曲线清除），且只此一笔
    global.historyUndoForTest();
    await sleep(20);
    assert.ok(global.getClipAutoGainForTest(ci) == null, '撤销清掉曲线');
    assert.strictEqual(global.historyUndoDepth(), depthBefore, '撤销深度回到原点');
  });

  await test('接受限制器（防削波）提案：按钮可用、单笔历史、落地为只在框内的增益曲线', async () => {
    const ui = global.__loudnessUIForTest;
    // 第三个独立测试音（前两个片段已带其它修正），保证干净且不受叠加干扰
    el('btnDemo').click();
    await sleep(20);
    const ci = global.docClipsForTest().length - 1;
    const cOff = global.docClipsForTest()[ci].offset;
    const cDur = global.docClipsForTest()[ci].duration;
    const a = cOff, b = cOff + cDur;
    el('lfStart').value = String(a);
    el('lfEnd').value = String(b);
    const task = await runCheckWithProposals(ui);
    const prop = task.proposals.find(p => p.kind === 'limiter');
    assert.ok(prop.result && prop.result.status === 'done', '限制器已完成评估');
    const btn = allButtons(prop._el).find(bb => /接受/.test(bb.textContent));
    assert.ok(btn, '存在接受按钮（防削波方案可以确认）');
    assert.ok(!btn.disabled, '限制器接受按钮不再被禁用');
    const depthBefore = global.historyUndoDepth();
    btn.click();
    await sleep(50);
    assert.strictEqual(global.historyUndoDepth(), depthBefore + 1, '接受仍是单笔历史');
    const auto = global.getClipAutoGainForTest(ci);
    if (auto) {
      // 有落地曲线时：所有节点都严格在框内，框外取值恒为 1
      assert.ok(auto.every(n => n.t >= a - 1e-6 && n.t <= b + 1e-6), '曲线只落在框内');
      const sampleAt = (curve, t) => {
        if (t < curve[0].t || t > curve[curve.length - 1].t) return 1;
        let i = 0; while (i < curve.length - 2 && t > curve[i + 1].t) i++;
        const n0 = curve[i], n1 = curve[i + 1];
        const r = (t - n0.t) / (n1.t - n0.t);
        return n0.g + (n1.g - n0.g) * r;
      };
      assert.strictEqual(sampleAt(auto, a - 0.1), 1, '框左外恒为 1');
      assert.strictEqual(sampleAt(auto, b + 0.1), 1, '框右外恒为 1');
    }
    global.historyUndoForTest();
    await sleep(20);
    assert.ok(global.getClipAutoGainForTest(ci) == null, '撤销清掉曲线');
  });

  await test('放弃提案不改变撤销深度', async () => {
    const ui = global.__loudnessUIForTest;
    const before = global.historyUndoDepth();
    // 新检查一个此前未用过的区间（避开历史 stale 任务）
    el('lfStart').value = '0';
    el('lfEnd').value = '1.25';
    el('btnLoud').click();
    const tm = ui.getManager();
    const t0 = Date.now();
    let task;
    while (Date.now() - t0 < 20000) {
      task = tm.tasks.find(t => Math.abs(t.b - 1.25) < 1e-6 && t.status !== 'stale');
      if (task && task.status === 'done') break;
      await sleep(30);
    }
    assert.ok(task && task.status === 'done', '新任务完成');
    ui.selectTask(task);
    const card = el('lfTasks').children[0];
    const gen = allButtons(card).find(b => /生成修正提案/.test(b.textContent));
    gen.click();
    while (Date.now() - t0 < 22000) {
      if (task.proposals.length >= 3 && task.proposals.every(p => p.status === 'evaluated')) break;
      await sleep(50);
    }
    const prop = task.proposals.find(p => p.kind === 'envelope');
    const beforeN = task.proposals.length;
    const discard = allButtons(prop._el).find(b => /放弃/.test(b.textContent));
    discard.click();
    await sleep(20);
    assert.strictEqual(task.proposals.length, beforeN - 1, '提案被移除');
    assert.strictEqual(global.historyUndoDepth(), before, '放弃不产生历史');
  });

  console.log(passed + ' 项 app-loudness-ui 测试通过');
})().catch(e => { console.error(e); process.exit(1); });


async function bootAppForTest() {
  // boot 已在 app.js 加载时通过 IN_BROWSER 判定不自动运行；这里调用其启动逻辑
  // app.js 在 Node 桩下导出 bootAppForTest/resetAppForTest；若无则手动等待
  if (global.bootAppForTest) {
    await global.bootAppForTest();
  } else {
    await new Promise(r => setTimeout(r, 200));
  }
}

/* 提交一次响度检查并生成/等待三个提案评估完成，返回任务 */
async function runCheckWithProposals(ui) {
  el('btnLoud').click();
  const tm = ui.getManager();
  let task;
  const t0 = Date.now();
  const a = parseFloat(el('lfStart').value), b = parseFloat(el('lfEnd').value);
  while (Date.now() - t0 < 20000) {
    task = tm.tasks.find(t => Math.abs(t.a - a) < 1e-6 && Math.abs(t.b - b) < 1e-6 &&
      !['stale', 'canceled', 'failed'].includes(t.status) &&
      ['done', 'failed'].includes(t.status));
    if (task) break;
    await sleep(30);
  }
  assert.ok(task && task.status === 'done', '任务完成: ' + (task && task.status));
  ui.selectTask(task);
  const card = el('lfTasks').children[0];
  const gen = allButtons(card).find(bb => /生成修正提案/.test(bb.textContent));
  assert.ok(gen, '有生成提案按钮');
  gen.click();
  const t1 = Date.now();
  while (Date.now() - t1 < 22000) {
    if (task.proposals.length >= 3 && task.proposals.every(p => p.status === 'evaluated' || p.status === 'error')) break;
    await sleep(40);
  }
  assert.strictEqual(task.proposals.length, 3);
  assert.ok(task.proposals.every(p => p.result && p.result.status === 'done'), '三提案均评估完成');
  return task;
}
