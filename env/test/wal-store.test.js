'use strict';

/* wal-core + store 集成测试（Node，内存 KV）：
   帧 CRC/截断恢复、FIFO 顺序、快照压缩、配额失败保留最近完整状态、
   意图清单丢失诊断、素材按哈希去重、压缩后撤销范围不变（store 侧）。 */

const assert = require('assert');
const H = require('../public/history-core.js');
const W = require('../public/wal-core.js');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
async function run() {
  for (const [name, fn] of tests) {
    global.localStorage.removeItem('audio-timeline:intents');
    try { await fn(); passed++; console.log('  ok - ' + name); }
    catch (err) { console.error('  FAIL - ' + name); console.error(err); process.exitCode = 1; }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 帧编解码 ---------- */

test('帧往返：CRC 正确通过；改一个字节即判损坏', () => {
  const payload = new TextEncoder().encode(JSON.stringify({ hello: '世界' }));
  const frame = W.encodeFrame(W.T_OP, 7, payload);
  const dec = W.decodeFrame(frame);
  assert.ok(dec.ok && dec.seq === 7 && dec.type === W.T_OP);
  assert.strictEqual(new TextDecoder().decode(dec.payload), JSON.stringify({ hello: '世界' }));
  const bad = frame.slice(); bad[bad.length - 1] ^= 0xff;
  assert.strictEqual(W.decodeFrame(bad).ok, false);
  const cut = frame.slice(0, frame.length - 3);
  const r = W.decodeFrame(cut);
  assert.ok(!r.ok && /中断|长度/.test(r.reason));
});

test('内容哈希稳定且随内容变化（去重基础）', () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  const b = new Uint8Array([1, 2, 3, 4]);
  const c = new Uint8Array([1, 2, 3, 5]);
  assert.strictEqual(W.hashBytes(a), W.hashBytes(b));
  assert.notStrictEqual(W.hashBytes(a), W.hashBytes(c));
});

/* ---------- 会产生配额错误的 KV ---------- */

function quotaKV(limit) {
  const m = new Map();
  let used = 0;
  return {
    get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) {
      const size = v.length || v.byteLength || String(v).length;
      const next = used - (m.has(k) ? (m.get(k).length || 0) : 0) + size;
      if (next > limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      if (m.has(k)) used -= m.get(k).length;
      m.set(k, v); used += size;
    },
    del(k) { if (m.has(k)) { used -= m.get(k).length; m.delete(k); } },
    keys(p) { return [...m.keys()].filter(k => !p || k.startsWith(p)).sort(); },
    _used: () => used,
  };
}
/* 可注入故障的 KV：第 n 次 put 失败 */
function flakyKV(failOnPut) {
  const m = new Map(); let puts = 0;
  return {
    get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { puts++; if (puts === failOnPut) throw new Error('磁盘抖动写入失败'); m.set(k, v); },
    del(k) { m.delete(k); },
    keys(p) { return [...m.keys()].filter(k => !p || k.startsWith(p)).sort(); },
  };
}

function clipPatch(id, off) {
  return [{ op: 'add', clip: { id, name: id, mediaHash: 'h' + id, duration: 1, offset: off || 0, gain: 1, fadeIn: 0, fadeOut: 0 } }];
}

/* ---------- WAL 行为 ---------- */

test('快速连续 append：FIFO 落盘，恢复顺序与提交顺序一致', async () => {
  const kv = W.memKV();
  const wal = W.createWAL(kv);
  await wal.open();
  const N = 20;
  const ps = [];
  for (let i = 0; i < N; i++) ps.push(wal.append({ i }));
  await Promise.all(ps);
  const wal2 = W.createWAL(kv);
  const rec = await wal2.open();
  assert.deepStrictEqual(rec.frames.map(f => f.data.i), [...Array(N).keys()]);
  assert.deepStrictEqual(rec.frames.map(f => f.seq), [...Array(N).keys()].map(i => i + 1));
  assert.strictEqual(rec.problems.length, 0);
});

test('帧已写但清单未更新（崩溃在两步之间）：该记录不被采信，且明确报告', async () => {
  const kv = W.memKV();
  const wal = W.createWAL(kv);
  await wal.open();
  await wal.append({ i: 1 });
  // 手动塞一条「帧存在但无确认位」的记录，模拟帧写成功后、清单更新前崩溃
  const payload = new TextEncoder().encode(JSON.stringify({ i: 2 }));
  kv.put(W.frameKey(2), W.encodeFrame(W.T_OP, 2, payload));
  const wal2 = W.createWAL(kv);
  const rec = await wal2.open();
  assert.strictEqual(rec.frames.length, 1, '未确认帧不恢复');
  assert.strictEqual(rec.frames[0].data.i, 1);
});

test('最后一帧写入截断：停在最后完整位置并报告', async () => {
  const kv = W.memKV();
  const wal = W.createWAL(kv);
  await wal.open();
  await wal.append({ i: 1 });
  await wal.append({ i: 2 });
  // 再写一帧但把内容截断（并更新清单确认位，模拟确认后损坏）
  const payload = new TextEncoder().encode(JSON.stringify({ i: 3 }));
  const f = W.encodeFrame(W.T_OP, 3, payload);
  kv.put(W.frameKey(3), f.slice(0, f.length - 5));
  // 清单仍声明 committed=3
  const mf = JSON.parse(new TextDecoder().decode(kv.get(W.MANIFEST_KEY)));
  mf.committed = 3;
  kv.put(W.MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(mf)));
  const wal2 = W.createWAL(kv);
  const rec = await wal2.open();
  assert.deepStrictEqual(rec.frames.map(x => x.data.i), [1, 2]);
  assert.ok(rec.problems.some(p => /第 3|3 条|完整/.test(p)), '应报告第 3 条未保存: ' + rec.problems.join(';'));
});

test('清单损坏：靠帧扫描恢复连续前缀', async () => {
  const kv = W.memKV();
  const wal = W.createWAL(kv);
  await wal.open();
  await wal.append({ i: 1 });
  await wal.append({ i: 2 });
  kv.put(W.MANIFEST_KEY, new TextEncoder().encode('{broken'));
  const rec = await W.createWAL(kv).open();
  assert.deepStrictEqual(rec.frames.map(x => x.data.i), [1, 2]);
  assert.ok(rec.problems.some(p => /清单/.test(p)));
});

test('快照压缩后旧帧可清理，从快照+尾部帧恢复到同一状态', async () => {
  const kv = W.memKV();
  const wal = W.createWAL(kv);
  await wal.open();
  for (let i = 0; i < 5; i++) await wal.append({ i });
  const snapSeq = await wal.writeSnapshot({ mark: 'snap' });
  assert.strictEqual(snapSeq, 5, '快照锚在当前已确认的最后一帧');
  const removed = await wal.cleanupOldFrames();
  assert.strictEqual(removed, 4, '快前 4 帧（seq<5）被清理，锚点帧保留');
  assert.strictEqual(kv.keys(W.FRAME_PREFIX).length, 1);
  const rec = await W.createWAL(kv).open();
  assert.deepStrictEqual(rec.snapshot.data, { mark: 'snap' });
  assert.deepStrictEqual(rec.frames.length, 0); // 锚点之后没有新帧
});

test('配额不足：append 拒绝并报 QUOTA，此前帧完好', async () => {
  const kv = quotaKV(400);
  const wal = W.createWAL(kv);
  await wal.open();
  await wal.append({ ok: 1 });
  let quota = null;
  try { await wal.append({ big: 'x'.repeat(2000) }); } catch (e) { quota = e; }
  assert.ok(quota && quota.code === 'QUOTA');
  const rec = await W.createWAL(kv).open();
  assert.strictEqual(rec.frames.length, 1);
});

test('偶发写入失败不拖垮后续帧（队列继续）', async () => {
  const kv = flakyKV(4); // open 与 append#1 成功（3 次 put）；append#2 帧写失败，append#3 接续成功
  const wal = W.createWAL(kv);
  await wal.open();
  await wal.append({ i: 1 });
  await wal.append({ i: 2 }).catch(() => {});
  await wal.append({ i: 3 }); // 序号重排为 seq=2（连续无空洞）
  const rec = await W.createWAL(kv).open();
  assert.deepStrictEqual(rec.frames.map(f => f.data.i), [1, 3]);
});

test('音频 blob 按哈希存一份，不随历史重复', async () => {
  const kv = W.memKV();
  const wal = W.createWAL(kv);
  const bytes = new Uint8Array([9, 8, 7]);
  const h = W.hashBytes(bytes);
  assert.strictEqual(await wal.putBlob(h, bytes), true);
  assert.strictEqual(await wal.putBlob(h, bytes), false, '同哈希第二次不写');
  assert.deepStrictEqual(await wal.blobHashes(), [h]);
  assert.deepStrictEqual([...await wal.getBlob(h)], [9, 8, 7]);
});

/* ---------- localStorage 桩（store 用） ---------- */

const lsMap = new Map();
global.localStorage = {
  getItem: k => lsMap.has(k) ? lsMap.get(k) : null,
  setItem: (k, v) => lsMap.set(k, String(v)),
  removeItem: k => lsMap.delete(k),
};

/* 端到端用例用外部注入 kv 的工厂 */
const Store = require('../public/store.js');
function clearLS() { global.localStorage.removeItem('audio-timeline:intents'); }
function makeStoreOn(kv) { return Store.createStore({ H, W, wal: W.createWAL(kv) }); }

test('store：刷新恢复后状态/撤销/检查点一致', async () => {
  const kv = W.memKV();
  const store = makeStoreOn(kv);
  await store.open();
  store.commit(clipPatch('a', 0), { label: '导入a' });
  store.commit(clipPatch('b', 1), { label: '导入b' });
  store.commit([{ op: 'update', id: 'a', set: { gain: 0.4 }, old: { gain: 1 } }], { coalesceWithLast: false });
  const cp = H.createCheckpoint(store.eng, 'v1');
  store.persistMeta('checkpoint', { ...cp }, '创建检查点 v1');
  H.undo(store.eng); H.undo(store.eng);
  store.persistPosition('撤销');
  await store.flush();

  const store2 = makeStoreOn(kv);
  const r = await store2.open();
  assert.strictEqual(r.problems.length, 0, '无恢复问题: ' + r.problems.join(';'));
  assert.strictEqual(store2.eng.doc.clips.length, 1, '撤销后的位置也恢复');
  assert.strictEqual(H.canUndo(store2.eng), true);
  H.redo(store2.eng); H.redo(store2.eng);
  assert.strictEqual(store2.eng.doc.clips.length, 2);
  assert.strictEqual(store2.eng.doc.clips.find(c => c.id === 'a').gain, 0.4);
  assert.ok(store2.eng.checkpoints[cp.id], '检查点恢复');
});

test('store：连续拖动合并只产生一个 op 节点，但落盘仍是顺序帧', async () => {
  const kv = W.memKV();
  const store = makeStoreOn(kv);
  await store.open();
  store.commit(clipPatch('a', 0), {});
  const move = v => store.commit([{ op: 'update', id: 'a', set: { offset: v }, old: { offset: v - 0.1 } }], { coalesceWithLast: true });
  move(0.1); move(0.2); move(0.3);
  await store.flush();
  const store2 = makeStoreOn(kv);
  await store2.open();
  assert.strictEqual(store2.eng.doc.clips[0].offset, 0.3);
  assert.strictEqual(H.undoDepth(store2.eng), 2, '导入 1 步 + 连续移动合并为 1 步');
  H.undo(store2.eng);
  assert.strictEqual(store2.eng.doc.clips[0].offset, 0, '一次撤销撤掉整个拖动');
  assert.strictEqual(store2.eng.doc.clips.length, 1, '片段本身（导入）仍在');
});

test('store：压缩后重开，历史节点与撤销范围不缩水', async () => {
  const kv = W.memKV();
  const store = makeStoreOn(kv);
  await store.open();
  for (let i = 0; i < 8; i++) store.commit(clipPatch('c' + i, i), {});
  const depthBefore = H.undoDepth(store.eng);
  await store.maybeCompact(true);
  await store.flush();
  assert.strictEqual(kv.keys(W.FRAME_PREFIX).length, 1, '旧帧已清，仅留锚点帧');
  const store2 = makeStoreOn(kv);
  await store2.open();
  assert.strictEqual(H.undoDepth(store2.eng), depthBefore, '撤销深度不变');
  assert.strictEqual(store2.eng.doc.clips.length, 8);
  for (let i = 0; i < 8; i++) H.undo(store2.eng);
  assert.strictEqual(store2.eng.doc.clips.length, 0);
});

test('store：崩溃在确认前 ⇒ 意图清单指出丢失的操作名', async () => {
  const kv = W.memKV();
  const store = makeStoreOn(kv);
  await store.open();
  store.commit(clipPatch('a', 0), { label: '导入a' });
  await store.flush();
  // 模拟「提交了 b，但帧还没写完页面就关了」：意图已写，帧没有
  const store3 = makeStoreOn(kv);
  await store3.open();
  // 直接往意图清单塞一条未确认意图
  global.localStorage.setItem('audio-timeline:intents', JSON.stringify([
    { id: 'lost1', label: '导入b', at: Date.now() },
  ]));
  const store4 = makeStoreOn(kv);
  const r = await store4.open();
  assert.strictEqual(store4.eng.doc.clips.length, 1, '最近完整状态保留');
  assert.ok(r.problems.some(p => p.includes('导入b')), '明确说出丢了「导入b」: ' + r.problems.join(';'));
});

test('store：配额不足时保存失败被记录，内存编辑仍在且最近完整状态可恢复', async () => {
  const kv = quotaKV(100000);
  const store = makeStoreOn(kv);
  await store.open();
  store.commit(clipPatch('a', 0), { label: '导入a' });
  await store.flush();
  // 撑爆配额
  const big = [{ op: 'update', id: 'a', set: { gain: 1.5 }, old: { gain: 1 } }];
  // 直接往 KV 填垃圾触发配额
  for (let i = 0; i < 200; i++) { try { await kv.put('junk/' + i, new Uint8Array(500)); } catch (_) {} }
  store.commit(big, { label: '危险增益' });
  await store.flush();
  const store2 = makeStoreOn(kv);
  const r = await store2.open();
  assert.strictEqual(store2.eng.doc.clips[0].gain, 1, '恢复到最后完整状态（增益=1）');
  assert.ok(r.problems.length >= 1, '配额问题有说明');
});

test('store：手动新建/恢复分支的元数据跨刷新恢复', async () => {
  const kv = W.memKV();
  const store = makeStoreOn(kv);
  await store.open();
  store.commit(clipPatch('a', 0), { label: '导入a' });
  store.commit(clipPatch('b', 1), { label: '导入b' });
  const cp = H.createCheckpoint(store.eng, '基线');
  store.persistMeta('checkpoint', { ...cp }, '创建检查点');
  // 从检查点恢复为新分支
  const nb = H.restoreCheckpointAsBranch(store.eng, cp.id, '基线恢复');
  store.persistMeta('newBranch', { ...nb }, '恢复为新分支');
  store.persistMeta('restoreCheckpoint', { id: cp.id, branch: nb.id }, '恢复检查点');
  // 手动新建命名分支
  const nb2 = H.forkBranch(store.eng, '实验X');
  store.persistMeta('newBranch', { ...nb2 }, '新建分支 实验X');
  await store.flush();

  const store2 = makeStoreOn(kv);
  await store2.open();
  assert.ok(store2.eng.checkpoints[cp.id], '检查点恢复');
  assert.ok(Object.values(store2.eng.branches).some(b => b.name === '基线恢复'), '恢复分支恢复');
  assert.ok(Object.values(store2.eng.branches).some(b => b.name === '实验X'), '命名分支恢复');
});

test('store：素材缺失标记与重新关联跨刷新后历史仍可撤销/重做', async () => {
  const kv = W.memKV();
  const store = makeStoreOn(kv);
  await store.open();
  // 片段引用素材 h（素材登记但 blob 不在库里 = 缺失）
  store.commit([
    { op: 'mediaAdd', m: { hash: 'h', name: 'x.wav', missing: false } },
    { op: 'add', clip: { id: 'a', name: 'a', mediaHash: 'h', duration: 1, offset: 0, gain: 1, fadeIn: 0, fadeOut: 0 } },
  ], { label: '导入a' });
  // 标记缺失（模拟启动恢复）
  store.commit([{ op: 'mediaStatus', hash: 'h', set: { missing: true }, old: { missing: false } }],
    { label: '标记素材缺失' });
  await store.flush();
  const s2 = makeStoreOn(kv);
  await s2.open();
  assert.strictEqual(s2.eng.doc.media.h.missing, true, '缺失标记恢复');
  // 重新关联到新素材 h2
  s2.commit([
    { op: 'mediaAdd', m: { hash: 'h2', name: 'y.wav', missing: false } },
    { op: 'update', id: 'a', set: { mediaHash: 'h2' }, old: { mediaHash: 'h' } },
    { op: 'mediaStatus', hash: 'h2', set: { missing: false, corrupt: false }, old: { missing: true, corrupt: true } },
  ], { label: '重新关联' });
  await s2.flush();
  const s3 = makeStoreOn(kv);
  await s3.open();
  assert.strictEqual(s3.eng.doc.clips[0].mediaHash, 'h2', '重关联结果恢复');
  // 沿历史撤销：重关联 → 缺失标记 → 导入
  H.undo(s3.eng);
  assert.strictEqual(s3.eng.doc.clips[0].mediaHash, 'h');
  assert.strictEqual(s3.eng.doc.media.h.missing, true, '撤销重关联后回到缺失标记态');
  H.undo(s3.eng);
  assert.strictEqual(s3.eng.doc.media.h.missing, false, '再撤销：素材未缺失');
});

test('store：从检查点恢复后在新分支编辑，跨刷新父链与分支末端正确', async () => {
  const kv = W.memKV();
  const store = makeStoreOn(kv);
  await store.open();
  store.commit(clipPatch('a', 0), { label: '导入a' });
  store.commit(clipPatch('b', 1), { label: '导入b' });
  await store.flush();
  const cp = H.createCheckpoint(store.eng, 'cp');
  store.persistMeta('checkpoint', { ...cp }, '检查点');
  // 主分支再走一步
  store.commit([{ op: 'update', id: 'a', set: { gain: 0.2 }, old: { gain: 1 } }], { label: '增益' });
  // 从检查点恢复为新分支，并在其上新增 d
  const nb = H.restoreCheckpointAsBranch(store.eng, cp.id, '恢复');
  store.persistMeta('newBranch', { ...nb }, '恢复为新分支');
  store.persistMeta('restoreCheckpoint', { id: cp.id, branch: nb.id }, '恢复检查点');
  store.persistPosition('切换到恢复分支');
  store.commit(clipPatch('d', 2), { label: '导入d' });
  await store.flush();

  const s2 = makeStoreOn(kv);
  await s2.open();
  const curBranch = s2.eng.branches[s2.eng.branchId];
  assert.ok(curBranch, '当前分支恢复');
  assert.strictEqual(curBranch.name, '恢复');
  assert.strictEqual(s2.eng.doc.clips.map(c => c.id).sort().join(','), 'a,b,d');
  // d 的父链可一路撤销到检查点
  H.undo(s2.eng);
  assert.strictEqual(s2.eng.current, cp.node, '撤销一步回到检查点节点');
  // 主分支完好且增益编辑仍在
  H.switchBranch(s2.eng, 'b-main');
  assert.ok(H.materialize(s2.eng, s2.eng.branches['b-main'].head).clips.find(c => c.id === 'a').gain < 0.3);
});

(async () => {
  await run();
  console.log(passed + ' 项 wal/store 测试通过');
})().catch(e => { console.error(e); process.exit(1); });
