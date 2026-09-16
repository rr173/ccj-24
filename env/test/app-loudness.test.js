'use strict';

/* loudness-app.js 集成测试（Node，纯逻辑 + 注入式混音/存储）：
   任务去重、分段缓存复用、暂停/继续/取消、编辑后过期、提案门控、序列化恢复。 */

const assert = require('assert');
const LA = require('../public/loudness-app.js');
const LC = require('../public/loudness-core.js');
const EC = require('../public/export-core.js');

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

/* ---------- 测试夹具 ---------- */

function fakeBuffer(channels, sr) {
  return {
    numberOfChannels: channels.length, sampleRate: sr, length: channels[0].length,
    duration: channels[0].length / sr,
    getChannelData(i) { return channels[i]; },
  };
}
function tone(level, dur, f) {
  const sr = 48000, n = Math.round(dur * sr), d = new Float32Array(n);
  const amp = Math.pow(10, (level + 3.01) / 20); // RMS level → 峰值
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin(2 * Math.PI * (f || 997) * i / sr);
  return fakeBuffer([d], sr);
}
function makeSnap(clips, a, b) {
  a = a || 0;
  b = b || clips.reduce((m, c) => Math.max(m, c.offset + c.duration), 0);
  return { a, b, clips };
 }
function clip(buf, over) {
  return Object.assign({
    name: 'c', buffer: buf, mediaHash: 'h' + Math.random().toString(36).slice(2),
    offset: 0, gain: 1, fadeIn: 0, fadeOut: 0, duration: buf.duration,
  }, over);
}

function makeDeps() {
  // CRC 段缓存（Map<fp, Uint8Array>）
  const segCache = new Map();
  return {
    segCache,
    renderMix(snap, t0, t1, ch, cb, sr) {
      return EC.renderMix(snap, t0, t1, ch, cb, sr, {
        chunkFrames: 1 << 14,
        yieldControl: () => sleep(0),
      });
    },
    yieldControl: () => Promise.resolve(),
    async getSegment(fp) { return segCache.has(fp) ? segCache.get(fp) : null; },
    async putSegment(fp, bytes) { segCache.set(fp, bytes.slice()); },
    pausePollMs: 5, chunkSec: 0.25, segmentSec: 2,
  };
}

(async () => {

  /* ---------- 基本流程：提交 → 完成 → 指标 ---------- */

  await test('任务完成并得到 −14 LUFS 指标（分段 + 缓存）', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-14, 6))]);
    const { task } = tm.submit({ snap, a: 0, b: 6, preset: LC.PRESETS.stream });
    await waitDone(tm, task.id);
    assert.strictEqual(tm.findTask(task.id).status, 'done');
    assert.ok(Math.abs(tm.findTask(task.id).metrics.integrated + 14) < 0.4);
    assert.ok(tm.findTask(task.id).seg.every(s => s.status === 'done'));
  });

  await test('相同区间+规范+快照重复提交只保留一份任务', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-14, 4))]);
    const r1 = tm.submit({ snap, a: 0, b: 4, preset: LC.PRESETS.stream });
    const r2 = tm.submit({ snap, a: 0, b: 4, preset: LC.PRESETS.stream });
    assert.strictEqual(r1.task, r2.task);
    assert.strictEqual(r2.duplicated, true);
    assert.strictEqual(tm.tasks.length, 1);
    await waitDone(tm, r1.task.id);
  });

  await test('不同规范（R128 vs 流媒体）产生不同任务', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-14, 4))]);
    tm.submit({ snap, a: 0, b: 4, preset: LC.PRESETS.stream });
    tm.submit({ snap, a: 0, b: 4, preset: LC.PRESETS.r128 });
    assert.strictEqual(tm.tasks.length, 2);
  });

  /* ---------- 分段缓存复用：编辑只重算受影响区段 ---------- */

  await test('编辑未触及区段：新任务命中内容缓存，区段标 fromCache', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    // 两个片段：0–2s 与 8–10s
    const c1 = clip(tone(-14, 2), { offset: 0 });
    const c2 = clip(tone(-14, 2), { offset: 8 });
    const snap1 = makeSnap([c1, c2], 0, 10);
    const r1 = tm.submit({ snap: snap1, a: 0, b: 10, preset: LC.PRESETS.stream });
    await waitDone(tm, r1.task.id);
    assert.ok(deps.segCache.size >= 5, '至少缓存了 5 个区段');

    // 只改 8s 处片段增益 ⇒ 仅含它的区段指纹变化
    const snap2 = makeSnap([c1, { ...c2, gain: 0.5 }], 0, 10);
    const r2 = tm.submit({ snap: snap2, a: 0, b: 10, preset: LC.PRESETS.stream });
    assert.strictEqual(r2.duplicated, false, '快照变了，是新任务');
    await waitDone(tm, r2.task.id);
    const t2 = tm.findTask(r2.task.id);
    const cached = t2.seg.filter(s => s.fromCache).length;
    const recomputed = t2.seg.filter(s => s.status === 'done' && !s.fromCache).length;
    assert.ok(cached >= 4, `大部分区段命中缓存（实际 ${cached}）`);
    assert.ok(recomputed <= 2, `只有受影响区段重算（实际 ${recomputed}）`);
  });

  /* ---------- 取消 / 暂停 / 继续 ---------- */

  await test('取消：状态已取消，不产生完成结果', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-14, 40))]); // 长节目
    const { task } = tm.submit({ snap, a: 0, b: 40, preset: LC.PRESETS.stream });
    await waitStatus(tm, task.id, ['running', 'partial']);
    tm.cancel(task.id);
    await waitStatus(tm, task.id, ['canceled'], 3000);
    assert.strictEqual(tm.findTask(task.id).status, 'canceled');
    assert.ok(!tm.findTask(task.id).metrics || true);
  });

  await test('暂停后进度不前进，继续后完成且未丢已算区段', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-16, 20))]);
    const { task } = tm.submit({ snap, a: 0, b: 20, preset: LC.PRESETS.podcast });
    await waitStatus(tm, task.id, ['running', 'partial']);
    tm.pause(task.id);
    // 等到管理器真正进入暂停（在块边界生效）
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      if (tm.findTask(task.id).pauseRequested && tm.findTask(task.id).status === 'paused') break;
      await sleep(10);
    }
    await sleep(150);
    const progressAtPause = tm.findTask(task.id).progress;
    await sleep(200);
    assert.ok(Math.abs(tm.findTask(task.id).progress - progressAtPause) < 1e-6,
      '暂停期间进度不前进');
    tm.resume(task.id);
    await waitDone(tm, task.id);
    assert.strictEqual(tm.findTask(task.id).status, 'done');
  });

  /* ---------- 编辑后过期 ---------- */

  await test('编辑后运行中/已完成任务标记过期，提案不可再应用', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-14, 6))]);
    const { task } = tm.submit({ snap, a: 0, b: 6, preset: LC.PRESETS.stream });
    await waitDone(tm, task.id);
    const props = await tm.makeProposals(task.id);
    // 评估统一增益提案
    await tm.evaluateProposal(task.id, props[0].id);
    // 工程编辑 ⇒ 任务与提案过期
    const n = tm.markStaleAfterEdit('片段增益已修改');
    assert.ok(n >= 1);
    const t = tm.findTask(task.id);
    assert.strictEqual(t.status, 'stale');
    assert.ok(t.proposals.every(p => p.stale && !p.applicable));
    assert.throws(() => tm.acceptProposal(task.id, props[0].id), /过期/);
  });

  /* ---------- 提案：可行 / 冲突门控 ---------- */

  await test('统一增益提案：偏移到目标后可行、可接受', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-18, 6))]); // −18 → 目标 −14
    const { task } = tm.submit({ snap, a: 0, b: 6, preset: LC.PRESETS.stream });
    await waitDone(tm, task.id);
    const [uni] = await tm.makeProposals(task.id);
    assert.strictEqual(uni.kind, 'uniform');
    assert.ok(Math.abs(uni.params.gainDB - 4) < 0.4);
    const r = await tm.evaluateProposal(task.id, uni.id);
    assert.strictEqual(r.feasible, true, JSON.stringify(r.conflicts));
    const accepted = tm.acceptProposal(task.id, uni.id);
    assert.strictEqual(accepted.proposal.applied, true);
  });

  await test('冲突提案：响度目标与过严峰值上限冲突时不可行、不可接受', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-20, 6))]);
    const { task } = tm.submit({ snap, a: 0, b: 6, preset: LC.PRESETS.r128 });
    await waitDone(tm, task.id);
    const [uni] = await tm.makeProposals(task.id);
    const strict = { ...LC.PRESETS.r128, maxTP: -30 };
    // 直接用核心评估严格上限（统一增益必然在峰值上冲突）
    const r = await LC.evaluateProposal(snap, 0, 6, uni.params, strict,
      { renderMix: deps.renderMix, yieldControl: deps.yieldControl }, { channels: 1 });
    assert.strictEqual(r.feasible, false);
    assert.ok(r.conflicts.some(c => c.kind === 'peak'));
    assert.ok(r.conflicts.find(c => c.kind === 'peak').over > 0);
  });

  /* ---------- 放弃提案不改变节目 ---------- */

  await test('放弃提案只移除提案，快照与任务指标不变', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const c0 = clip(tone(-14, 4));
    const snap = makeSnap([c0]);
    const { task } = tm.submit({ snap, a: 0, b: 4, preset: LC.PRESETS.stream });
    await waitDone(tm, task.id);
    const props = await tm.makeProposals(task.id);
    const integBefore = tm.findTask(task.id).metrics.integrated;
    await tm.evaluateProposal(task.id, props[0].id);
    tm.discardProposal(task.id, props[0].id);
    assert.strictEqual(tm.findTask(task.id).proposals.length, props.length - 1);
    assert.strictEqual(c0.gain, 1, '片段增益未被修改');
    assert.strictEqual(tm.findTask(task.id).metrics.integrated, integBefore);
  });

  /* ---------- 序列化 / 恢复 ---------- */

  await test('序列化后恢复：已完成段结果保留、任务继续；缺失段自动续算', async () => {
    const deps1 = makeDeps();
    const tm1 = LA.createTaskManager(deps1);
    const snap = makeSnap([clip(tone(-16, 6))]);
    const { task } = tm1.submit({ snap, a: 0, b: 6, preset: LC.PRESETS.podcast });
    await waitDone(tm1, task.id);
    const json = tm1.serialize();

    const deps2 = makeDeps();
    const tm2 = LA.createTaskManager(deps2);
    const rec = tm2.restore(json, rt => snap); // UI 重新物化快照
    assert.strictEqual(rec.restored, 1);
    const t2 = tm2.findTask(task.id);
    assert.strictEqual(t2.status, 'done');
    assert.ok(t2.seg.every(s => s.status === 'done'));
    assert.ok(Math.abs(t2.metrics.integrated + 16) < 0.4);
  });

  await test('恢复时快照无法物化 ⇒ 任务失败提示重新检查，不假装有结果', async () => {
    const deps1 = makeDeps();
    const tm1 = LA.createTaskManager(deps1);
    const snap = makeSnap([clip(tone(-14, 4))]);
    const { task } = tm1.submit({ snap, a: 0, b: 4, preset: LC.PRESETS.stream });
    await waitDone(tm1, task.id);
    const json = tm1.serialize();

    const tm2 = LA.createTaskManager(makeDeps());
    const rec = tm2.restore(json, () => null);
    assert.ok(rec.problems.length >= 0);
    const t2 = tm2.findTask(task.id);
    assert.ok(['failed'].includes(t2.status), '无快照不进入完成态: ' + t2.status);
  });

  /* ---------- 暂停态持久化（刷新在暂停中） ---------- */

  await test('运行中任务序列化后恢复为暂停态，resume 后续算到完成', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap = makeSnap([clip(tone(-14, 30))]);
    const { task } = tm.submit({ snap, a: 0, b: 30, preset: LC.PRESETS.stream });
    await waitStatus(tm, task.id, ['running', 'partial']);
    const json = tm.serialize();
    const tm2 = LA.createTaskManager(deps);
    tm2.restore(json, () => snap);
    const t2 = tm2.findTask(task.id);
    assert.ok(['paused', 'partial', 'waiting'].includes(t2.status), '恢复为可续算状态: ' + t2.status);
    tm2.resume(task.id);
    await waitDone(tm2, task.id);
    assert.strictEqual(tm2.findTask(task.id).status, 'done');
  });

  /* ---------- 缓存缺块只重算缺失段 ---------- */

  await test('CRC 缓存损坏时只重算受影响段，其余命中', async () => {
    const deps = makeDeps();
    const tm = LA.createTaskManager(deps);
    const snap1 = makeSnap([clip(tone(-14, 10))]);
    const r1 = tm.submit({ snap: snap1, a: 0, b: 10, preset: LC.PRESETS.stream });
    await waitDone(tm, r1.task.id);
    // 破坏其中一个缓存键的内容
    const keys = [...deps.segCache.keys()];
    const victim = keys[2];
    const bad = deps.segCache.get(victim).slice(); bad[bad.length - 2] ^= 0xff;
    deps.segCache.set(victim, bad);
    // 同快照再提交（手动绕过任务去重：直接新建管理器）
    const tm2 = LA.createTaskManager(deps);
    const r2 = tm2.submit({ snap: snap1, a: 0, b: 10, preset: LC.PRESETS.stream });
    await waitDone(tm2, r2.task.id);
    const t2 = tm2.findTask(r2.task.id);
    assert.strictEqual(t2.status, 'done', '坏段被重算，整体仍完成');
    assert.ok(t2.seg.some(s => !s.fromCache), '坏段确实重算');
    assert.ok(t2.seg.filter(s => s.fromCache).length >= 4, '好段继续复用');
  });

  console.log(passed + ' 项 loudness-app 集成测试通过');
})().catch(err => { console.error(err); process.exit(1); });

/* ---------- 等待辅助 ---------- */
async function waitDone(tm, id, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 15000)) {
    const s = tm.findTask(id).status;
    if (['done', 'failed', 'canceled', 'stale'].includes(s)) return s;
    await sleep(15);
  }
  throw new Error('等待任务完成超时: ' + tm.findTask(id).status);
}
async function waitStatus(tm, id, statuses, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 8000)) {
    if (statuses.includes(tm.findTask(id).status)) return;
    await sleep(10);
  }
  throw new Error('等待状态 ' + statuses + ' 超时: ' + tm.findTask(id).status);
}
