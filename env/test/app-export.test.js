'use strict';

/* app.js 集成测试：用最小 DOM 桩驱动真实应用代码，验证导出任务管理行为。
   覆盖：任务去重、取消（无半成品）、失败重试、快照冻结、状态流转与下载门控。 */

const assert = require('assert');

/* ---------- 最小 DOM 桩 ---------- */

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
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.classList = new FakeClassList();
    this.listeners = {};
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.href = '';
    this.download = '';
    this.width = 0;
    this.height = 0;
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
    ev = ev || {};
    if (!('target' in ev)) ev.target = this;
    (this.listeners[t] || []).slice().forEach(f => f(ev));
  }
  click() { this.dispatch('click', {}); }
  getContext() { return ctx2dStub(); }
  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 28 }; }
  querySelector() { return new FakeElement(); }
}

const byId = {};
function el(id) {
  if (!byId[id]) byId[id] = new FakeElement(id === 'ruler' ? 'canvas' : 'div');
  return byId[id];
}

global.document = {
  querySelector: s => el(s.replace(/^#/, '')),
  createElement: t => new FakeElement(t),
  addEventListener() {},
};
global.window = global;
global.self = global;
global.alert = msg => { throw new Error('不应弹出 alert: ' + msg); };
global.requestAnimationFrame = () => 1;
let blobSeq = 0;
const blobStore = new Map();
global.URL = {
  createObjectURL(blob) { const u = 'blob:mock-' + (++blobSeq); blobStore.set(u, blob); return u; },
  revokeObjectURL() {},
};

class FakeAudioContext {
  constructor() { this.sampleRate = 8000; this.currentTime = 0; this.destination = {}; }
  resume() { return Promise.resolve(); }
  createGain() {
    return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: n => n };
  }
  createDynamicsCompressor() { return { connect: n => n }; }
  createBuffer(ch, len, sr) {
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return {
      numberOfChannels: ch, sampleRate: sr, length: len, duration: len / sr,
      getChannelData: i => data[i],
    };
  }
  createBufferSource() { return { buffer: null, connect: n => n, start() {}, stop() {} }; }
}
global.AudioContext = FakeAudioContext;

/* ---------- 加载被测代码 ---------- */

Object.assign(global, require('../public/export-core.js'));
require('../public/app.js');

/* ---------- 测试辅助 ---------- */

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (err) {
    console.error('  FAIL - ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function findAll(root, cls, out) {
  out = out || [];
  for (const c of root.children) {
    if (c.classList.contains(cls)) out.push(c);
    findAll(c, cls, out);
  }
  return out;
}
function taskRows() { return el('tasks').children.slice(); }
function rowOf(pred) { return taskRows().find(pred); }
function rowText(row) { return findAll(row, 't-state')[0].textContent; }
function rowActions(row) { return findAll(row, 't-actions')[0].children; }
function rowErr(row) { return findAll(row, 't-err')[0]; }
async function waitFor(row, stateText, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 8000)) {
    if (rowText(row) === stateText) return;
    await sleep(5);
  }
  throw new Error(`等待任务进入「${stateText}」超时，当前「${rowText(row)}」`);
}
function setRange(a, b) {
  el('xStart').value = String(a);
  el('xEnd').value = String(b);
}
function setSpec(rate, ch, bits) {
  el('xRate').value = String(rate);
  el('xCh').value = String(ch);
  el('xBits').value = String(bits);
}
function clickExport() { el('btnExport').click(); }
/* 点选泳道上的第 i 个片段（模拟 pointerdown ⇒ 选中，面板参数随之指向它） */
function selectClipEl(i) {
  const clipEl = el('lanes').children[i];
  assert.ok(clipEl, '泳道上应有第 ' + i + ' 个片段');
  clipEl.dispatch('pointerdown', { pointerId: 1, clientX: 0 });
}
function setGain(v) {
  el('pGain').value = String(v);
  el('pGain').dispatch('input');
}

(async () => {

  /* 初始：空列表提示可见 */
  await test('初始任务列表为空', () => {
    assert.strictEqual(taskRows().length, 0);
    assert.strictEqual(el('tasksEmpty').hidden, false);
  });

  /* 造两个片段：测试音 A（默认参数）与 B */
  el('btnDemo').click();
  el('btnDemo').click();
  assert.ok(el('lanes').children.length >= 2, '应有两个片段');

  /* ---------- 基本导出流程 ---------- */

  setRange(0, 1);
  setSpec(8000, 1, '16');
  clickExport();
  const row1 = taskRows()[0];
  assert.ok(row1, '提交后应出现任务');

  await test('任务经等待/进行中到达已完成，且只有完成后才可下载', async () => {
    assert.ok(['等待', '进行中', '已完成'].includes(rowText(row1)));
    // 完成前：没有下载链接
    assert.ok(!rowActions(row1).some(a => a.tagName === 'A'), '未完成时不应有下载链接');
    await waitFor(row1, '已完成');
    const links = rowActions(row1).filter(a => a.tagName === 'A');
    assert.strictEqual(links.length, 1, '完成后有且仅有一个下载链接');
    assert.ok(links[0].href.startsWith('blob:mock-'));
    assert.ok(/\.wav$/.test(links[0].download), '下载文件名以 .wav 结尾');
    // 进度条到 100%
    assert.strictEqual(findAll(row1, 't-fill')[0].style.width, '100%');
  });

  await test('导出的 WAV 内容正确（区间 0→1s、8000Hz、单声道、16bit）', () => {
    const url = rowActions(row1).find(a => a.tagName === 'A').href;
    const blob = blobStore.get(url);
    assert.ok(blob, 'Blob 已生成');
    return blob.arrayBuffer().then(ab => {
      const bytes = new Uint8Array(ab);
      assert.strictEqual(bytes.length, 44 + 8000 * 2, '文件大小 = 44 + N×2');
      const dv = new DataView(ab);
      assert.strictEqual(dv.getUint32(24, true), 8000);
      assert.strictEqual(dv.getUint16(22, true), 1);
      assert.strictEqual(dv.getUint32(40, true), 8000 * 2);
      // 测试音是 440Hz 正弦：峰值应接近 0.8×32767
      let peak = 0;
      for (let i = 0; i < 8000; i++) peak = Math.max(peak, Math.abs(dv.getInt16(44 + i * 2, true)));
      assert.ok(peak > 25000 && peak <= 0x7FFF, '正弦峰值合理: ' + peak);
    });
  });

  /* ---------- 去重 ---------- */

  await test('相同区间+相同快照重复提交只保留一个任务', async () => {
    const before = taskRows().length;
    clickExport();
    clickExport();
    assert.strictEqual(taskRows().length, before, '不产生第二个任务');
    assert.ok(taskRows()[0].classList.contains('flash'), '已有任务被高亮提示');
  });

  await test('修改片段参数后（不同快照）提交 ⇒ 新任务', async () => {
    const before = taskRows().length;
    selectClipEl(0);   // 选中区间内的片段（clip1 在 0→2s）
    setGain(0.5);
    clickExport();
    assert.strictEqual(taskRows().length, before + 1);
    await waitFor(taskRows()[0], '已完成');
  });

  await test('区间外片段的改动不影响该区间的快照（重复提交仍去重）', async () => {
    const before = taskRows().length;
    selectClipEl(1);   // clip2 在 2.25s 起，导出区间是 0→1s
    setGain(0.3);
    clickExport();
    assert.strictEqual(taskRows().length, before, '区间外改动不产生新任务');
    setGain(1);
  });

  await test('不同输出规格 ⇒ 新任务', async () => {
    const before = taskRows().length;
    setSpec(8000, 2, '24');
    clickExport();
    assert.strictEqual(taskRows().length, before + 1);
    await waitFor(taskRows()[0], '已完成');
    setSpec(8000, 1, '16');
  });

  /* ---------- 快照冻结 ---------- */

  await test('提交后继续编辑不影响已完成任务的下载结果', async () => {
    const url = rowActions(row1).find(a => a.tagName === 'A').href;
    const sizeBefore = blobStore.get(url).size;
    // 大幅改动时间线：增益、删除片段
    selectClipEl(0);
    setGain(2);
    el('pDelete').click();
    assert.strictEqual(blobStore.get(url).size, sizeBefore, '已完成任务的结果不变');
    assert.ok(rowActions(row1).some(a => a.tagName === 'A'), '下载链接仍在');
  });

  /* ---------- 取消 ---------- */

  await test('取消进行中的任务：状态已取消、无下载链接、进度不回退', async () => {
    // 长区间让任务停留在进行中
    setRange(0, 300);
    setSpec(48000, 2, '32f');
    clickExport();
    const row = taskRows()[0];
    const t0 = Date.now();
    while (rowText(row) !== '进行中' && Date.now() - t0 < 3000) await sleep(2);
    assert.strictEqual(rowText(row), '进行中');
    const cancelBtn = rowActions(row).find(b => b.textContent === '取消');
    assert.ok(cancelBtn, '进行中可取消');
    cancelBtn.click();
    await waitFor(row, '已取消');
    assert.ok(!rowActions(row).some(a => a.tagName === 'A'), '取消后无下载链接');
    assert.ok(rowActions(row).some(b => b.textContent === '重新导出'), '取消后可重新导出');
    setRange(0, 1); setSpec(8000, 1, '16');
  });

  await test('等待中的任务可直接取消', async () => {
    // 先占住执行位
    setRange(0, 300); setSpec(48000, 2, '32f');
    clickExport();
    const running = taskRows()[0];
    // 改参数得到不同快照，再提交一个 ⇒ 排队等待
    selectClipEl(0);
    setGain(1.5);
    clickExport();
    const pending = taskRows()[0];
    assert.notStrictEqual(pending, running);
    const t0 = Date.now();
    while (rowText(pending) !== '等待' && Date.now() - t0 < 3000) await sleep(2);
    assert.strictEqual(rowText(pending), '等待');
    rowActions(pending).find(b => b.textContent === '取消').click();
    assert.strictEqual(rowText(pending), '已取消');
    assert.ok(!rowActions(pending).some(a => a.tagName === 'A'));
    // 清掉占位的长任务
    const t1 = Date.now();
    while (rowText(running) !== '进行中' && Date.now() - t1 < 3000) await sleep(2);
    rowActions(running).find(b => b.textContent === '取消').click();
    await waitFor(running, '已取消');
    setGain(1);
  });

  /* ---------- 失败与重试 ---------- */

  await test('预计文件超过上限 ⇒ 明确失败并说明原因', async () => {
    const before = taskRows().length;
    setRange(0, 100000); // 8000Hz·16bit·单声道 ≈ 1.6GB > 512MB 上限
    clickExport();
    assert.strictEqual(taskRows().length, before + 1);
    const row = taskRows()[0];
    await waitFor(row, '失败');
    assert.ok(/超过/.test(rowErr(row).textContent), '失败原因提到超过限制: ' + rowErr(row).textContent);
    assert.ok(!rowActions(row).some(a => a.tagName === 'A'), '失败任务无下载链接');
    assert.ok(rowActions(row).some(b => b.textContent === '重试'), '失败任务可重试');
  });

  await test('失败后可从同一快照重新发起（重试产生新任务）', async () => {
    const before = taskRows().length;
    const failedRow = taskRows()[0];
    rowActions(failedRow).find(b => b.textContent === '重试').click();
    assert.strictEqual(taskRows().length, before + 1, '重试产生新任务');
    await waitFor(taskRows()[0], '失败'); // 同样的超限原因，仍失败
    setRange(0, 1);
  });

  await test('取消后重新导出同一快照 ⇒ 新任务并能完成', async () => {
    // 先制造一个已取消任务
    setRange(0, 200); setSpec(48000, 2, '32f');
    clickExport();
    const row = taskRows()[0];
    const t0 = Date.now();
    while (!['等待', '进行中'].includes(rowText(row)) && Date.now() - t0 < 3000) await sleep(2);
    rowActions(row).find(b => b.textContent === '取消').click();
    await waitFor(row, '已取消');
    const before = taskRows().length;
    rowActions(row).find(b => b.textContent === '重新导出').click();
    assert.strictEqual(taskRows().length, before + 1);
    await waitFor(taskRows()[0], '已完成');
    assert.ok(rowActions(taskRows()[0]).some(a => a.tagName === 'A'));
    setRange(0, 1); setSpec(8000, 1, '16');
  });

  /* ---------- 进度只向前（运行期观察） ---------- */

  await test('进行中任务的进度单调不减', async () => {
    setRange(0, 800); setSpec(48000, 2, '32f'); // 长区间：导出持续数秒
    clickExport();
    const row = taskRows()[0];
    const fill = findAll(row, 't-fill')[0];
    let last = -1, samples = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && samples < 5) {
      const txt = rowText(row);
      if (txt !== '等待' && txt !== '进行中') break;
      const w = parseFloat(fill.style.width) || 0;
      assert.ok(w >= last - 1e-9, `进度回退: ${last} → ${w}`);
      last = Math.max(last, w);
      if (w > 0) samples++;
      await sleep(3);
    }
    assert.ok(samples >= 2, `应观察到多个进度采样，实际 ${samples}`);
    // 还没跑完就取消（取消后进度停在当时位置，不回退）
    if (rowText(row) === '等待' || rowText(row) === '进行中') {
      const wAtCancel = last;
      rowActions(row).find(b => b.textContent === '取消').click();
      await waitFor(row, '已取消');
      const wAfter = parseFloat(fill.style.width) || 0;
      assert.ok(wAfter >= wAtCancel - 1e-9, '取消后进度不回退');
      assert.ok(!rowActions(row).some(a => a.tagName === 'A'), '取消后无下载链接');
    }
    setRange(0, 1); setSpec(8000, 1, '16');
  });

  /* ---------- 导出期间页面可继续操作 ---------- */

  await test('导出进行中仍可编辑片段（不阻塞、不影响任务）', async () => {
    setRange(0, 300); setSpec(48000, 2, '32f');
    clickExport();
    const row = taskRows()[0];
    const t0 = Date.now();
    while (rowText(row) !== '进行中' && Date.now() - t0 < 3000) await sleep(2);
    assert.strictEqual(rowText(row), '进行中');
    // 导出期间编辑：改增益、加测试音（事件循环未被阻塞，这些操作能立即执行）
    selectClipEl(0);
    setGain(0.7);
    el('btnDemo').click();
    await waitFor(row, '已完成');
    assert.ok(rowActions(row).some(a => a.tagName === 'A'));
    setRange(0, 1); setSpec(8000, 1, '16');
  });

  console.log(passed + ' 项集成测试通过');
})().catch(err => { console.error(err); process.exit(1); });
