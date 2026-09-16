'use strict';
/* 纯逻辑测试：配对、稳定身份、时间戳投射、争议、挂起续接、采纳撤销、持久化 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ---- 浏览器桩 ----
const storage = {};
global.localStorage = {
  getItem: k => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: k => { delete storage[k]; },
};
let rafSeq = 0;
const rafCbs = [];
global.requestAnimationFrame = (fn) => { const id = ++rafSeq; rafCbs.push({ id, fn }); return id; };
global.cancelAnimationFrame = () => {};
global.devicePixelRatio = 1;
global.performance = { now: () => Date.now() };
let docHidden = false;
const docListeners = {};
global.document = {
  hidden: false,
  addEventListener: (ev, fn) => { (docListeners[ev] = docListeners[ev] || []).push(fn); },
  querySelector: () => null,
  querySelectorAll: () => [],
};
Object.defineProperty(global.document, 'hidden', {
  get() { return docHidden; },
  configurable: true,
});
function fireVis(hidden) {
  docHidden = hidden;
  (docListeners.visibilitychange || []).forEach(fn => fn());
}

const DIR = path.join(__dirname, '..', '..', 'public', 'midi');
['midi-util.js', 'midi-store.js', 'midi-mapping.js', 'midi-midi.js', 'midi-clock.js', 'midi-engine.js', 'midi-transport.js']
  .forEach(f => require(path.join(DIR, f)));

const M = global.MConsole;
const { mapRaw, Smoother, applyCurve } = M.mapping;

// 每个未显式指定 key 的 Store 用独立命名空间，避免用例间通过 localStorage 串状态
const _OrigStore = M.Store;
let _storeSeq = 0;
M.Store = function (opts) { return new _OrigStore(opts || { key: 'test.k' + (++_storeSeq) }); };
M.Store.prototype = _OrigStore.prototype;

let pass = 0;
const asyncResults = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      asyncResults.push(r.then(() => { console.log('  ✓ ' + name); pass++; })
        .catch(e => { console.error('  ✗ ' + name); console.error('    ' + (e && e.stack || e)); process.exitCode = 1; }));
    } else { console.log('  ✓ ' + name); pass++; }
  }
  catch (e) { console.error('  ✗ ' + name); console.error('    ' + (e && e.stack || e)); process.exitCode = 1; }
}
function group(name, fn) { console.log(name); fn(); }

// ---------------- 映射 / 曲线 / 平滑 ----------------
group('映射与曲线', () => {
  test('线性 0/127 → 0/1', () => {
    assert.strictEqual(mapRaw(0, { inMin: 0, inMax: 127, outMin: 0, outMax: 1, invert: false, curve: 'linear', clip: true }).value, 0);
    assert.strictEqual(mapRaw(127, { inMin: 0, inMax: 127, outMin: 0, outMax: 1, invert: false, curve: 'linear', clip: true }).value, 1);
    assert.ok(Math.abs(mapRaw(64, { inMin: 0, inMax: 127, outMin: 0, outMax: 1, invert: false, curve: 'linear', clip: true }).value - 64 / 127) < 1e-9);
  });
  test('反相：0→1，127→0', () => {
    const cfg = { inMin: 0, inMax: 127, outMin: 0, outMax: 1, invert: true, curve: 'linear', clip: true };
    assert.strictEqual(mapRaw(0, cfg).value, 1);
    assert.strictEqual(mapRaw(127, cfg).value, 0);
  });
  test('曲线端点守恒', () => {
    ['exp', 'log', 'scurve'].forEach(c => {
      assert.strictEqual(applyCurve(0, c), 0);
      assert.strictEqual(applyCurve(1, c), 1);
    });
    assert.ok(applyCurve(0.3, 'exp') < 0.3);
    assert.ok(applyCurve(0.3, 'log') > 0.3);
  });
  test('越界：裁切 vs 超调', () => {
    const clipped = mapRaw(140, { inMin: 10, inMax: 100, outMin: 0, outMax: 1, invert: false, curve: 'linear', clip: true });
    assert.strictEqual(clipped.value, 1);
    assert.strictEqual(clipped.clipped, true);
    const loose = mapRaw(140, { inMin: 10, inMax: 100, outMin: 0, outMax: 1, invert: false, curve: 'linear', clip: false });
    assert.ok(loose.value > 1, '未裁切应允许超调');
  });
  test('自定义值域 outMin/outMax（如 -1..1）', () => {
    const v = mapRaw(64, { inMin: 0, inMax: 127, outMin: -1, outMax: 1, invert: false, curve: 'linear', clip: true }).value;
    assert.ok(Math.abs(v - (64 / 127 * 2 - 1)) < 1e-9);
  });
  test('平滑：首值立即落位，flush 尾值必达', () => {
    const s = new Smoother(0.8);
    assert.strictEqual(s.push(1), 1);            // 首值不被平滑
    s.push(0);
    const mid = s.value();
    assert.ok(mid > 0 && mid < 1, '中间值被平滑: ' + mid);
    s.push(0); s.push(0);
    assert.strictEqual(s.flush(), 0);             // 尾值必达
  });
  test('平滑 amount=0 直通', () => {
    const s = new Smoother(0);
    s.push(0.3);
    assert.strictEqual(s.push(0.9), 0.9);
  });
});

// ---------------- 端口指纹与稳定身份 ----------------
group('端口身份（严禁串台）', () => {
  const hub = new M.MidiHub();
  const a = hub.addVirtual(0);
  const b = hub.addVirtual(1);
  test('同型号两台 id/fp 不同', () => {
    assert.notStrictEqual(a.id, b.id);
    assert.notStrictEqual(a.fp, b.fp);
    assert.strictEqual(a.name.replace(/ #2$/, ''), b.name.replace(/ #2$/, ''));
  });
  test('拔出保留记录为离线，插回同 id 才上线', () => {
    hub.removeVirtual(a.id);
    assert.strictEqual(hub.isOnline(a.id), false);
    assert.ok(hub.getPort(a.id), '记录仍在');
    hub.replugVirtual(a.id);
    assert.strictEqual(hub.isOnline(a.id), true);
  });
  test('b 的消息不会被 a 的绑定接收', () => {
    const store = new M.Store();
    const clock = new M.Clock();
    const engine = new M.Engine(store, hub, clock);
    hub.replugVirtual(b.id);
    // 模拟绑定到 a
    const binding = store.addBinding({
      controlId: 'f0', port: { id: a.id, name: a.name, manufacturer: a.manufacturer, fp: a.fp },
      ch: 0, cc: 16, inMin: 0, inMax: 127, outMin: 0, outMax: 1,
      invert: false, curve: 'linear', smooth: 0, clip: true, armed: false,
    });
    let got = 0;
    engine.on('binding-value', () => got++);
    hub.sendVirtualCC(b.id, 0, 16, 100); // 同型号另一台
    assert.strictEqual(got, 0, '同型号不同 id 不得串台');
    hub.sendVirtualCC(a.id, 0, 16, 100);
    assert.strictEqual(got, 1, '本机消息正常接收');
    void binding;
  });
});

// ---------------- 配对流程与冲突 ----------------
group('配对学习 / 冲突', () => {
  const hub = new M.MidiHub();
  const store = new M.Store();
  const clock = new M.Clock();
  const engine = new M.Engine(store, hub, clock);
  const dev = hub.addVirtual(0);

  test('单条消息不确认，值变化后建立绑定', () => {
    engine.startLearn('f0');
    hub.sendVirtualCC(dev.id, 0, 20, 10);
    assert.strictEqual(store.state.bindings.length, 0);
    hub.sendVirtualCC(dev.id, 0, 20, 40); // 变化 ≥4
    assert.strictEqual(store.state.bindings.length, 1);
    assert.strictEqual(store.state.bindings[0].controlId, 'f0');
    assert.strictEqual(engine.learn, null);
  });

  test('同消息再配对 → 询问；三种处置', () => {
    // 再给另一个控件配同一条消息
    engine.startLearn('f1');
    let asked = null;
    engine.on('binding-conflict', c => { asked = c; });
    hub.sendVirtualCC(dev.id, 0, 20, 40);
    hub.sendVirtualCC(dev.id, 0, 20, 70);
    assert.ok(asked, '应触发冲突询问');
    // 共享
    engine.resolveConflict('share');
    const bs = store.findBindings(dev.id, 0, 20);
    assert.strictEqual(bs.length, 2, '共享后有两条绑定');
    assert.ok(bs[0].group.length === 2 && bs[1].group.length === 2, '共享组互指');
    assert.ok(bs[0].sharedWith.includes('f1') && bs[1].sharedWith.includes('f0'));

    // 第三控件 → 替换
    engine.startLearn('f2');
    hub.sendVirtualCC(dev.id, 0, 20, 10);
    hub.sendVirtualCC(dev.id, 0, 20, 50);
    engine.resolveConflict('replace');
    const after = store.findBindings(dev.id, 0, 20);
    assert.strictEqual(after.length, 1, '替换后只剩一条');
    assert.strictEqual(after[0].controlId, 'f2');

    // 放弃
    engine.startLearn('f3');
    hub.sendVirtualCC(dev.id, 0, 20, 50);
    hub.sendVirtualCC(dev.id, 0, 20, 55);
    engine.resolveConflict('cancel');
    assert.strictEqual(store.findBindings(dev.id, 0, 20).length, 1);
    assert.strictEqual(engine.learn, null);
  });

  test('不同 CC 互不干扰', () => {
    engine.startLearn('k0');
    hub.sendVirtualCC(dev.id, 0, 30, 5);
    hub.sendVirtualCC(dev.id, 0, 30, 90);
    assert.strictEqual(store.state.bindings.some(b => b.cc === 30 && b.controlId === 'k0'), true);
  });
});

// ---------------- 采集：时间戳投射 / 晚到 / 争议 / 挂起 ----------------
group('采集走带', () => {
  const hub = new M.MidiHub();
  const store = new M.Store();
  const clock = new M.Clock();
  const engine = new M.Engine(store, hub, clock);
  const dev = hub.addVirtual(0);
  // 绑定 f0 CC16
  const b = store.addBinding({
    controlId: 'f0', port: { id: dev.id, name: dev.name, manufacturer: dev.manufacturer, fp: dev.fp },
    ch: 0, cc: 16, inMin: 0, inMax: 127, outMin: 0, outMax: 1,
    invert: false, curve: 'linear', smooth: 0, clip: true, armed: true,
  });

  test('未武装不可采集', () => {
    const hub2 = new M.MidiHub(); const store2 = new M.Store(); const clock2 = new M.Clock();
    const e2 = new M.Engine(store2, hub2, clock2);
    const r = e2.startCapture();
    assert.strictEqual(r.ok, false);
  });
  test('离线武装不可采集', () => {
    hub.removeVirtual(dev.id);
    const r = engine.startCapture();
    assert.strictEqual(r.ok, false);
    hub.replugVirtual(dev.id);
  });

  test('硬件时间戳投射：成簇消息不堆单点', () => {
    store.state.settings.writeMode = 'overwrite';
    const r = engine.startCapture();
    assert.ok(r.ok);
    const startPerf = clock._perfAnchor;
    const t0 = clock.project(startPerf);
    // 模拟卡顿后成簇到达：四条消息的 receivedTime 各自不同，但当前 perf 已远超
    const p = hub.getPort(dev.id);
    hub._dispatch(p, 0, 16, 10, startPerf + 200);
    hub._dispatch(p, 0, 16, 40, startPerf + 400);
    hub._dispatch(p, 0, 16, 80, startPerf + 600);
    hub._dispatch(p, 0, 16, 120, startPerf + 800);
    const slot = engine.capture.points.f0;
    const ts = slot.pts.map(pt => pt.t).sort((a, b) => a - b);
    assert.ok(ts.some(t => t > t0 + 0.1), '时间戳投射到工程时钟');
    for (let i = 2; i < ts.length; i++) {
      assert.ok(ts[i] - ts[i - 1] > 0.05, '成簇事件保持硬件时间戳间隔，不堆单点');
    }
  });

  test('晚到事件丢弃且不回写', () => {
    const before = engine.capture.points.f0.pts.length;
    const dropped0 = engine.capture.lateDropped;
    const p = hub.getPort(dev.id);
    hub._dispatch(p, 0, 16, 127, clock._perfAnchor + 50); // 远早于最后点
    assert.strictEqual(engine.capture.points.f0.pts.length, before, '点数不增加');
    assert.ok(engine.capture.lateDropped > dropped0);
  });

  test('采集期鼠标碰同一控件 → 争议段', () => {
    engine.noteMouseTouch('f0');
    const slot = engine.capture.points.f0;
    assert.ok(slot.disputes.length >= 1);
  });
  test('碰未武装控件不产生争议', () => {
    engine.noteMouseTouch('k5');
    assert.strictEqual(engine.capture.points.k5, undefined);
  });

  test('素材坐标变化 → 争议带前后扩展', () => {
    const n0 = engine.capture.points.f0.disputes.length;
    engine.noteMaterialDrag(1.0, 1.2, 'f0');
    assert.ok(engine.capture.points.f0.disputes.length >= n0);
  });

  test('拔线立即挂起；重连后续接，缺口入 gap', () => {
    hub.removeVirtual(dev.id);
    assert.ok(engine.capture.suspended, '拔线即挂起');
    assert.ok(!engine.capture.active);
    // 未重连不能续
    const blocked = engine.canResume();
    assert.strictEqual(blocked.ok, false);
    // 时间推进 0.5s
    const suspendedAt = engine.capture.suspendedAt;
    clock.pos = suspendedAt + 0.5;
    hub.replugVirtual(dev.id);
    const rr = engine.resumeCapture();
    assert.ok(rr.ok);
    assert.ok(engine.capture.active);
    assert.ok(engine.capture.gaps.some(g => Math.abs((g[1] - g[0]) - 0.5) < 0.01), '缺口≈0.5s');
  });

  test('失焦立即挂起', () => {
    fireVis(true);
    assert.ok(engine.capture.suspended);
    fireVis(false);
    // 不自动恢复
    assert.ok(engine.capture.suspended);
    engine.resumeCapture();
  });

  test('停止生成 draft take（含争议/缺口/晚到统计）', async () => {
    const n = store.state.takes.length;
    const r = await engine.stopCapture();
    assert.ok(r.ok);
    const take = r.take;
    assert.strictEqual(take.state, 'draft');
    assert.ok(store.state.takes.some(t => t.id === take.id), 'take 在列表中');
    assert.strictEqual(store.state.takes.length, n, '实时 upsert，收尾不产生重复条目');
    assert.ok(take.disputes.length >= 1, '保留争议');
    assert.ok(take.gaps.length >= 1, '保留缺口');
    assert.ok(take.lateDropped >= 1, '晚到计数');
    assert.ok(take.points[0].pts.length >= 4, '首尾与中间点都在');
  });

  test('另起一遍：旧 take 截断保存', async () => {
    await new Promise(res => setTimeout(res, 400)); // 等上一条停止的 settle 落定
    const r0 = engine.startCapture();
    assert.ok(r0.ok, '应能开始新一遍: ' + (r0.reason || ''));
    hub.sendVirtualCC(dev.id, 0, 16, 60);
    const n = store.state.takes.length;
    const oldId = engine.capture.takeId;
    engine.restartCapture();
    assert.ok(engine.capture, '已开始新一遍采集');
    assert.notStrictEqual(engine.capture.takeId, oldId, '新 take 有新 id');
    const oldTake = store.state.takes.find(t => t.id === oldId);
    assert.ok(oldTake, '旧 take 已落盘');
    assert.strictEqual(oldTake.truncated, true, '旧 take 标记为被打断');
    assert.strictEqual(store.state.takes.length, n + 1, '旧 take 落盘计数');
    assert.strictEqual(engine.capture.suspended, false, '新一遍不处于挂起');
    const r2 = await engine.stopCapture();
    assert.ok(r2.ok);
    assert.strictEqual(r2.take.truncated, false, '正常停止的新 take 不截断');
  });
  void b;
});

// ---------------- 写入方式与采纳 / 争议策略 / 单撤销 ----------------
group('写入方式、拼选、采纳、撤销', () => {
  const hub = new M.MidiHub();
  const store = new M.Store();
  const clock = new M.Clock();
  const engine = new M.Engine(store, hub, clock);

  function makeTake(opts) {
    const disputes = opts.disputes || [];
    const take = {
      id: M.util.uid('t'), fp: store.state.projectFp, state: 'draft',
      writeMode: opts.writeMode || 'overwrite',
      start: 0, end: 4,
      points: [{
        controlId: 'f0', bindingId: 'bx',
        pts: [
          { t: 0, v: 0.2 }, { t: 1, v: 0.2 }, { t: 1.2, v: 0.9 }, { t: 3, v: 0.9 }, { t: 4, v: 0.4 },
        ],
        gestureSpans: opts.gestureSpans || [[1.2, 3.0]],
        disputes: disputes.slice(),
      }],
      disputes: disputes.slice(), gaps: opts.gaps || [], lateDropped: 0, createdAt: Date.now(),
    };
    store.addTake(take);
    return take;
  }

  test('异工程指纹：可监听不可采纳', () => {
    const t = makeTake({});
    const realFp = store.state.projectFp;
    t.fp = 'PRJ-OTHER';
    const r = engine.addSelection(t.id, 0, 4);
    assert.strictEqual(r.ok, false, '加选区即拒绝');
    t.fp = realFp;
  });

  test('覆盖模式整段写入', () => {
    const t = makeTake({ writeMode: 'overwrite' });
    engine.addSelection(t.id, 0.5, 3.5);
    const r = engine.adopt('clean');
    assert.ok(r.ok);
    const lane = store.state.lanes.f0;
    assert.ok(lane.length >= 4);
    // 区间起点锚点保持旧值 0（无 lane 时 null → 不插前锚），区间内为 take 值
    const vMid = M.util.samplePoints(lane, 2.0);
    assert.ok(Math.abs(vMid - 0.9) < 1e-9, '中间为 take 值 0.9: ' + vMid);
  });

  test('一次采纳 = 一个撤销单元', () => {
    assert.ok(engine.undo());
    assert.ok(!store.state.lanes.f0 || store.state.lanes.f0.length === 0, '撤销后回到采纳前');
  });

  test('争议策略：live 保留现场值 / take 套入 / clean 仅无争议', () => {
    const t = makeTake({ writeMode: 'overwrite', disputes: [[2.0, 2.5]] });
    store.state.live.f0 = 0.3;
    engine.addSelection(t.id, 0, 4);

    engine.adopt('take');
    let vInDispute = M.util.samplePoints(store.state.lanes.f0, 2.2);
    assert.ok(Math.abs(vInDispute - 0.9) < 1e-6, 'take 策略争议段也是 take 值: ' + vInDispute);
    engine.undo();

    engine.compSelection = [];
    engine.addSelection(t.id, 0, 4);
    engine.adopt('live');
    vInDispute = M.util.samplePoints(store.state.lanes.f0, 2.2);
    assert.ok(Math.abs(vInDispute - 0.3) < 1e-6, 'live 策略争议段保留现场值 0.3: ' + vInDispute);
    // 非争议部分仍为 take
    assert.ok(Math.abs(M.util.samplePoints(store.state.lanes.f0, 1.5) - 0.9) < 1e-6);
    engine.undo();

    engine.compSelection = [];
    engine.addSelection(t.id, 0, 4);
    engine.adopt('clean');
    // 争议段没有 take 点；该段保持空（采纳前 lane 为空 → 采样 null/0）
    const hasPtsInDispute = store.state.lanes.f0.some(p => p.t > 2.0 && p.t < 2.5 && Math.abs(p.v - 0.9) < 0.01);
    assert.ok(!hasPtsInDispute, 'clean 策略争议段不写入 take 值');
    // 争议外有点
    assert.ok(store.state.lanes.f0.some(p => p.t <= 2.0));
  });

  test('触碰模式只写手势区间', () => {
    engine.undo();
    store.state.lanes = {};
    store.state.live.f0 = 0.2;
    const t = makeTake({ writeMode: 'touch', gestureSpans: [[1.2, 3.0]] });
    engine.addSelection(t.id, 0, 4);
    engine.adopt('clean');
    const lane = store.state.lanes.f0;
    // 0..1.2 的点只能是现场值 0.2（前导锚点），绝不能是手势后的 0.9
    lane.filter(pt => pt.t < 1.2 - 1e-6).forEach(pt => {
      assert.ok(Math.abs(pt.v - 0.2) < 1e-6, '手势前只允许现场值 0.2，实际 ' + pt.v);
    });
    assert.ok(Math.abs(M.util.samplePoints(lane, 0.5) - 0.2) < 1e-6, '手势前保持现场值');
    // 手势中 0.9，手离开后保持 0.9 到范围末
    assert.ok(Math.abs(M.util.samplePoints(lane, 2.0) - 0.9) < 1e-6, '手势中写入');
    assert.ok(Math.abs(M.util.samplePoints(lane, 3.5) - 0.9) < 1e-6, '手离开后保持末值');
  });

  test('锁存模式：手势前不写，手势后保持', () => {
    engine.undo();
    store.state.lanes = {};
    const t = makeTake({ writeMode: 'latch', gestureSpans: [[1.2, 1.8]] });
    engine.addSelection(t.id, 0, 4);
    engine.adopt('clean');
    const lane = store.state.lanes.f0;
    // 手势前（lane 中首个点 >= 手势起点）不写
    assert.ok(!lane.some(pt => pt.t < 1.2 - 1e-6), '手势前无写入点');
    // 手势起点之后一路保持到选区末
    assert.ok(Math.abs(M.util.samplePoints(lane, 3.5) - 0.9) < 1e-6, '锁存保持');
    assert.ok(Math.abs(M.util.samplePoints(lane, 2.0) - 0.9) < 1e-6);
  });

  test('多 take 拼选跨段，一次采纳一个撤销', () => {
    store.state.lanes = {};
    const t1 = makeTake({ writeMode: 'overwrite' });
    const t2 = makeTake({ writeMode: 'overwrite' });
    // 把 t2 改成不同值
    t2.points[0].pts.forEach(p => { p.v = p.v < 0.5 ? 0.1 : 0.5; });
    engine.clearSelection();
    engine.addSelection(t1.id, 0.0, 2.0);
    engine.addSelection(t2.id, 2.0, 4.0);
    const undoDepth = store.state.undoStack.length;
    assert.ok(engine.adopt('clean').ok);
    assert.strictEqual(store.state.undoStack.length, undoDepth + 1, '多个 take 拼选只产生一个撤销单元');
    assert.ok(Math.abs(M.util.samplePoints(store.state.lanes.f0, 1.5) - 0.9) < 1e-6);
    assert.ok(Math.abs(M.util.samplePoints(store.state.lanes.f0, 3.0) - 0.5) < 1e-6);
    engine.undo();
    assert.ok(!store.state.lanes.f0 || store.state.lanes.f0.length === 0);
  });

  test('gap（掉线缺口）任何策略都不采纳', () => {
    store.state.lanes = {};
    const t = makeTake({ writeMode: 'overwrite', gaps: [[1.5, 2.5]] });
    engine.clearSelection();
    engine.addSelection(t.id, 0, 4);
    engine.adopt('take'); // 即使套入 take，gap 也扣除
    const inGap = store.state.lanes.f0.filter(p => p.t > 1.5 && p.t < 2.5);
    // gap 内只允许边界锚点（无旧 lane 时为空）
    assert.ok(inGap.length === 0, 'gap 内无写入点');
  });

  test('晚到计算不回写新版本：采纳后补点不影响结果', async () => {
    store.state.lanes = {};
    const hub2 = new M.MidiHub(); const store2 = new M.Store(); const clock2 = new M.Clock();
    const e2 = new M.Engine(store2, hub2, clock2);
    const dev2 = hub2.addVirtual(0);
    store2.addBinding({
      controlId: 'f0', port: { id: dev2.id, name: dev2.name, manufacturer: dev2.manufacturer, fp: dev2.fp },
      ch: 0, cc: 16, inMin: 0, inMax: 127, outMin: 0, outMax: 1,
      invert: false, curve: 'linear', smooth: 0, clip: true, armed: true,
    });
    e2.startCapture();
    const p = hub2.getPort(dev2.id);
    hub2._dispatch(p, 0, 16, 20, clock2._perfAnchor + 200);
    const res = await e2.stopCapture();
    const take = res.take;
    e2.addSelection(take.id, take.start, take.end);
    const snapshotPts = take.points[0].pts.length;
    // 采纳后外部再追加点（模拟晚到计算），lane 不变
    e2.adopt('clean');
    const laneAfter = JSON.stringify(store2.state.lanes.f0);
    take.points[0].pts.push({ t: 0.3, v: 1.0 }); // 晚到修改 take 对象
    assert.strictEqual(JSON.stringify(store2.state.lanes.f0), laneAfter, '晚到修改不回写已采纳状态');
    assert.ok(snapshotPts >= 2);
  });
});

// ---------------- 持久化 ----------------
group('持久化 / 重载', () => {
  test('配对表、武装、take 都落 localStorage，重载后恢复', () => {
    const hub = new M.MidiHub(); const store = new M.Store({ key: 'test.persist1' }); const clock = new M.Clock();
    const engine = new M.Engine(store, hub, clock);
    const dev = hub.addVirtual(0);
    engine._commitLearn('f1', { portId: dev.id, ch: 2, cc: 40, value: 10, portName: dev.name, fp: dev.fp });
    const b = store.state.bindings[0];
    engine.setArmed(b.id, true);
    store.addTake({
      id: 't_persist', fp: store.state.projectFp, state: 'draft', writeMode: 'touch',
      start: 0, end: 1, points: [{ controlId: 'f1', pts: [{ t: 0, v: 0.5 }], gestureSpans: [], disputes: [] }],
      disputes: [], gaps: [], lateDropped: 0, createdAt: Date.now(),
    });
    store.saveNow();

    const reloaded = new M.Store({ key: 'test.persist1' });
    assert.strictEqual(reloaded.state.bindings.length, 1);
    assert.strictEqual(reloaded.state.bindings[0].ch, 2);
    assert.strictEqual(reloaded.state.bindings[0].cc, 40);
    assert.strictEqual(reloaded.state.bindings[0].armed, true, '武装保留');
    assert.ok(reloaded.state.takes.some(t => t.id === 't_persist'), '草稿 take 保留');
  });

  test('采集中刷新：partial 恢复为截断草稿，可继续监听', () => {
    const store = new M.Store({ key: 'test.persist2' });
    store.addTake({
      id: 't_partial', fp: store.state.projectFp, state: 'partial', writeMode: 'overwrite',
      start: 0, end: 2, points: [], disputes: [], gaps: [], lateDropped: 0, createdAt: Date.now(),
    });
    store.saveNow();
    const reloaded = new M.Store({ key: 'test.persist2' });
    const t = reloaded.state.takes.find(x => x.id === 't_partial');
    assert.strictEqual(t.state, 'draft');
    assert.strictEqual(t.truncated, true);
  });

  test('工程指纹不符的 take 仍在列表（只供监听）', () => {
    const store = new M.Store({ key: 'test.persist3' });
    store.addTake({
      id: 't_old', fp: 'PRJ-OLDONE', state: 'draft', writeMode: 'overwrite',
      start: 0, end: 1, points: [], disputes: [], gaps: [], lateDropped: 0, createdAt: 1,
    });
    store.saveNow();
    const reloaded = new M.Store({ key: 'test.persist3' });
    const t = reloaded.state.takes.find(x => x.id === 't_old');
    assert.ok(t);
    assert.notStrictEqual(t.fp, reloaded.state.projectFp);
  });
});

// ---------------- 区间工具 ----------------
group('区间运算', () => {
  test('相减：中间挖洞', () => {
    const r = M.util.subtractRanges(0, 10, [[3, 5]]);
    assert.deepStrictEqual(r, [[0, 3], [5, 10]]);
  });
  test('合并相邻/重叠', () => {
    assert.deepStrictEqual(M.util.mergeRanges([[0, 2], [2, 4], [5, 6]]), [[0, 4], [5, 6]]);
  });
  test('折线首尾保持', () => {
    const pts = [{ t: 1, v: 0.2 }, { t: 2, v: 0.8 }];
    assert.strictEqual(M.util.samplePoints(pts, 0), 0.2);
    assert.strictEqual(M.util.samplePoints(pts, 9), 0.8);
    assert.ok(Math.abs(M.util.samplePoints(pts, 1.5) - 0.5) < 1e-9);
  });
});

Promise.all(asyncResults).then(() => {
  console.log('\n通过 ' + pass + ' 项' + (process.exitCode ? '，存在失败' : '，全部通过'));
  process.exit(process.exitCode || 0);
});
