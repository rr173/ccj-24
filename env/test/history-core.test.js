'use strict';

/* history-core 单元测试：撤销/重做、连续操作合并、分支不丢历史、
   检查点恢复与比较、压缩不改变撤销范围、序列化损坏恢复。 */

const assert = require('assert');
const H = require('../public/history-core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (err) { console.error('  FAIL - ' + name); console.error(err); process.exitCode = 1; }
}

function clip(id, off) {
  return { id, name: id, mediaHash: 'h' + id, duration: 1, offset: off || 0, gain: 1, fadeIn: 0, fadeOut: 0 };
}
const addPatch = c => [{ op: 'add', clip: c }];
const updPatch = (id, set, old) => [{ op: 'update', id, set, old }];
const find = (eng, id) => eng.doc.clips.find(c => c.id === id);

/* ---------- 基础：补丁 / 撤销 / 重做 ---------- */

test('提交、撤销按逆序、重做按顺序', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), { label: '导入a' });
  H.commit(eng, addPatch(clip('b', 1)), { label: '导入b' });
  H.commit(eng, updPatch('a', { offset: 5 }, { offset: 0 }), { label: '移动a' });
  assert.strictEqual(eng.doc.clips.length, 2);
  assert.strictEqual(find(eng, 'a').offset, 5);
  assert.ok(H.canUndo(eng)); assert.ok(H.canRedo(eng) === false);
  H.undo(eng);
  assert.strictEqual(find(eng, 'a').offset, 0);
  assert.ok(H.canRedo(eng));
  H.undo(eng);
  assert.strictEqual(eng.doc.clips.length, 1);
  H.redo(eng);
  assert.strictEqual(eng.doc.clips.length, 2);
  assert.strictEqual(find(eng, 'a').offset, 0);
});

test('删除与新增互逆，撤销删除后片段参数完整回来', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 2)), {});
  const snap = JSON.parse(JSON.stringify(find(eng, 'a')));
  H.commit(eng, [{ op: 'remove', id: 'a', clip: snap }], {});
  assert.strictEqual(eng.doc.clips.length, 0);
  H.undo(eng);
  assert.deepStrictEqual(find(eng, 'a'), snap);
});

/* ---------- 连续操作合并 ---------- */

test('连续拖动合并为一个可撤销操作', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  const depth0 = H.undoDepth(eng);
  H.commit(eng, updPatch('a', { offset: 0.1 }, { offset: 0 }), { coalesceWithLast: true, label: '移动片段' });
  H.commit(eng, updPatch('a', { offset: 0.2 }, { offset: 0.1 }), { coalesceWithLast: true });
  H.commit(eng, updPatch('a', { offset: 0.9 }, { offset: 0.2 }), { coalesceWithLast: true });
  assert.strictEqual(H.undoDepth(eng), depth0 + 1, '三次移动只产生一个撤销步');
  assert.strictEqual(find(eng, 'a').offset, 0.9);
  H.undo(eng);
  assert.strictEqual(find(eng, 'a').offset, 0, '一次撤销回到拖动开始前');
});

test('移动中改了字段集合（offset→gain）不合并', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  const d = H.undoDepth(eng);
  H.commit(eng, updPatch('a', { offset: 1 }, { offset: 0 }), { coalesceWithLast: true });
  H.commit(eng, updPatch('a', { gain: 0.5 }, { gain: 1 }), { coalesceWithLast: true });
  assert.strictEqual(H.undoDepth(eng), d + 2);
});

test('导入后立刻拖动不跨操作类型合并', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  const r = H.commit(eng, updPatch('a', { offset: 3 }, { offset: 0 }), { coalesceWithLast: true });
  assert.strictEqual(r.merged, false);
  assert.strictEqual(H.undoDepth(eng), 2);
});

test('循环区间连续拖框以最终值合并；开关与设置不合并', () => {
  const eng = H.createEngine();
  H.commit(eng, [{ op: 'loop', new: { a: 0, b: 1 }, old: null }], { coalesceWithLast: true });
  H.commit(eng, [{ op: 'loop', new: { a: 0, b: 2 }, old: { a: 0, b: 1 } }], { coalesceWithLast: true });
  assert.strictEqual(H.undoDepth(eng), 1);
  H.undo(eng);
  assert.strictEqual(eng.doc.loop, null);
});

/* ---------- 分叉不丢历史 ---------- */

test('撤销后继续编辑自动 fork，原 redo 路径保留', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), { label: '导入a' });
  H.commit(eng, addPatch(clip('b', 1)), { label: '导入b' });
  H.commit(eng, addPatch(clip('c', 2)), { label: '导入c' });
  const mainId = eng.branchId;
  H.undo(eng); H.undo(eng); // 回到只有 a
  assert.ok(H.canRedo(eng), 'undo 后仍可沿原分支 redo');
  const beforeBranches = Object.keys(eng.branches).length;
  const r = H.commit(eng, addPatch(clip('d', 3)), { label: '导入d' });
  assert.strictEqual(r.forked, true, '非末端编辑产生分叉');
  assert.strictEqual(Object.keys(eng.branches).length, beforeBranches + 1);
  assert.strictEqual(eng.doc.clips.map(c => c.id).sort().join(','), 'a,d');
  // 主分支上 b、c 一个没丢
  H.switchBranch(eng, mainId);
  assert.strictEqual(eng.doc.clips.map(c => c.id).sort().join(','), 'a,b,c');
  H.switchBranch(eng, Object.keys(eng.branches).find(id => id !== mainId));
  assert.strictEqual(eng.doc.clips.map(c => c.id).sort().join(','), 'a,d');
});

test('redo 只沿当前分支路径，分叉侧枝不被静默重做', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, addPatch(clip('b', 1)), {});
  H.undo(eng);
  H.commit(eng, addPatch(clip('d', 2)), {}); // fork 出新分支（含 d）
  // 新分支 head == current，无 redo
  assert.strictEqual(H.canRedo(eng), false);
  // 切回主分支：可 redo 到 b
  const main = Object.values(eng.branches).find(b => b.id === 'b-main');
  H.switchBranch(eng, main.id);
  // switchBranch 落在 head（b 已在），先 undo 再 redo 验证路径
  H.undo(eng);
  assert.ok(H.canRedo(eng));
  H.redo(eng);
  assert.strictEqual(find(eng, 'b').id, 'b');
});

test('分支可重命名/列表，当前分支标记正确', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.undo(eng);
  H.commit(eng, addPatch(clip('b', 0)), {});
  H.renameBranch(eng, eng.branchId, '我的实验线');
  const list = H.branchesList(eng);
  assert.ok(list.some(b => b.name === '我的实验线' && b.current));
  assert.ok(list.some(b => b.id === 'b-main'));
});

/* ---------- 检查点：比较 / 预览 / 恢复为新分支 / 回原分支 ---------- */

test('检查点比较：新增/删除/参数变化分类正确', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, addPatch(clip('b', 1)), {});
  const cp = H.createCheckpoint(eng, '初版');
  // 在检查点之后：改 a、删 b、加 d
  H.commit(eng, updPatch('a', { gain: 0.3, offset: 9 }, { gain: 1, offset: 0 }), {});
  H.commit(eng, [{ op: 'remove', id: 'b', clip: clip('b', 1) }], {});
  H.commit(eng, addPatch(clip('d', 4)), {});
  const diff = H.diffAgainstNode(eng, cp.node);
  assert.deepStrictEqual(diff.added.map(c => c.id), ['d']);
  assert.deepStrictEqual(diff.removed.map(c => c.id), ['b']);
  assert.strictEqual(diff.changed.length, 1);
  assert.deepStrictEqual(Object.keys(diff.changed[0].fields).sort(), ['gain', 'offset']);
  assert.strictEqual(diff.changed[0].fields.gain.from, 1);
  assert.strictEqual(diff.changed[0].fields.gain.to, 0.3);
});

test('检查点预览不污染工作文档；恢复为新分支后可回到原分支', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, updPatch('a', { gain: 0.2 }, { gain: 1 }), {});
  const cp = H.createCheckpoint(eng, '安静版');
  H.commit(eng, updPatch('a', { gain: 1.8 }, { gain: 0.2 }), {});
  const workId = eng.branchId;

  // 预览 = 物化到临时文档，eng.doc 不变
  const preview = H.materialize(eng, cp.node);
  assert.strictEqual(preview.clips[0].gain, 0.2);
  assert.strictEqual(eng.doc.clips[0].gain, 1.8, '工作状态未被预览污染');

  // 恢复为新分支
  const nb = H.restoreCheckpointAsBranch(eng, cp.id, '恢复-安静版');
  assert.notStrictEqual(nb.id, workId);
  assert.strictEqual(eng.doc.clips[0].gain, 0.2);
  assert.strictEqual(eng.branchId, nb.id);

  // 回到原分支，后续编辑都还在
  H.goToBranch(eng, workId);
  assert.strictEqual(eng.doc.clips[0].gain, 1.8);
});

test('在检查点所在节点恢复不产生重复分支', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  const cp = H.createCheckpoint(eng, 'cp');
  const before = Object.keys(eng.branches).length;
  H.restoreCheckpointAsBranch(eng, cp.id, 'x');
  // forkBranch 总是新建（从该节点出发的命名分支），但当前如果已在该节点且就是主分支，
  // 仍应得到一条以该节点为起点的新分支（用户显式要求）
  assert.strictEqual(Object.keys(eng.branches).length, before + 1);
});

/* ---------- 撤销深度 / redo 深度 ---------- */

test('撤销深度以分支起点为界，redo 深度随 undo 增减', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, addPatch(clip('b', 0)), {});
  assert.strictEqual(H.undoDepth(eng), 2);
  H.undo(eng);
  assert.strictEqual(H.undoDepth(eng), 1);
  assert.strictEqual(H.redoDepth(eng), 1);
});

/* ---------- 压缩不改变语义 ---------- */

test('压缩锚点节点后撤销/重做结果一致且撤销深度不变', () => {
  const eng = H.createEngine();
  const patches = [
    addPatch(clip('a', 0)),
    addPatch(clip('b', 1)),
    updPatch('a', { gain: 0.5 }, { gain: 1 }),
  ];
  for (const p of patches) H.commit(eng, p, {});
  // 选中间节点压缩（真实使用里不会压检查点/分支点；这里只验证补丁替换的正确性）
  const targetId = eng.nodes[eng.current].parent; // 第 2 个节点
  const stateAtParent = H.materialize(eng, eng.nodes[targetId].parent);
  const stateAtNode = H.materialize(eng, targetId);
  const depthBefore = H.undoDepth(eng);
  H.compactNode(eng, targetId, stateAtNode, stateAtParent);
  assert.strictEqual(H.undoDepth(eng), depthBefore, '压缩不改变撤销深度');
  // 撤销穿过压缩节点
  H.undo(eng); H.undo(eng); H.undo(eng);
  assert.strictEqual(eng.doc.clips.length, 0);
  H.redo(eng); H.redo(eng); H.redo(eng);
  assert.strictEqual(eng.doc.clips.length, 2);
  assert.strictEqual(find(eng, 'a').gain, 0.5);
});

test('compactableNodes 保护检查点、分支起点/末端、当前节点', () => {
  const eng = H.createEngine();
  for (let i = 0; i < 5; i++) H.commit(eng, addPatch(clip('x' + i, i)), {});
  H.createCheckpoint(eng, 'cp', eng.current);
  H.undo(eng); H.undo(eng);
  H.commit(eng, addPatch(clip('fork', 9)), {}); // 产生新分支起点
  const ok = new Set(H.compactableNodes(eng));
  for (const cp of Object.values(eng.checkpoints)) assert.ok(!ok.has(cp.node));
  for (const b of Object.values(eng.branches)) { assert.ok(!ok.has(b.root)); assert.ok(!ok.has(b.head)); }
  assert.ok(!ok.has(eng.current));
  assert.ok(!ok.has('n0'));
});

/* ---------- 序列化与损坏恢复 ---------- */

test('序列化往返保持完整历史图与检查点', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, addPatch(clip('b', 1)), {});
  const cp = H.createCheckpoint(eng, 'cp1');
  H.undo(eng);
  H.commit(eng, addPatch(clip('d', 2)), {});
  const eng2 = H.deserialize(H.serialize(eng));
  assert.strictEqual(eng2.doc.clips.map(c => c.id).sort().join(','), 'a,d');
  assert.ok(eng2.checkpoints[cp.id]);
  const main = eng2.branches['b-main'];
  H.switchBranch(eng2, main.id);
  assert.strictEqual(eng2.doc.clips.map(c => c.id).sort().join(','), 'a,b');
});

test('损坏补丁节点：重放时跳过并报告，最近完整状态保留', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  const bad = H.commit(eng, addPatch(clip('b', 1)), {});
  H.commit(eng, addPatch(clip('d', 2)), {});
  bad.node.fwd = [{ op: 'update', id: 'ghost', set: {}, old: {} }]; // 指向不存在片段
  bad.node.rev = [];
  const problems = [];
  const doc = H.materialize(eng, eng.current, undefined, undefined, (id, e) => problems.push(id));
  // d 仍可重放（它依赖 add a；坏的是 add b）
  assert.strictEqual(doc.clips.map(c => c.id).sort().join(','), 'a,d');
  assert.ok(problems.includes(bad.node.id));
});

test('断链节点与悬空检查点在反序列化时被标出', () => {
  const eng = H.createEngine();
  const n1 = H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, addPatch(clip('b', 1)), {});
  H.createCheckpoint(eng, 'cp', n1.node.id);
  const data = JSON.parse(H.serialize(eng));
  delete data.nodes[n1.node.id]; // 制造断链
  const eng2 = H.deserialize(JSON.stringify(data));
  const cp = Object.values(eng2.checkpoints)[0];
  assert.ok(cp.dangling, '检查点标记为悬空');
  assert.ok((eng2._loadProblems || []).some(p => /丢失|环|忽略/.test(p)));
});

/* ---------- 事务 ---------- */

test('批量修改是单个补丁 = 单个撤销操作', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, addPatch(clip('b', 0)), {});
  const d = H.undoDepth(eng);
  H.transaction(eng, t => {
    t.update('a', { gain: 0.5 }, { gain: 1 });
    t.update('b', { gain: 0.5 }, { gain: 1 });
    t.setLoop({ a: 0, b: 1 }, null);
  }, { label: '批量：增益+循环' });
  assert.strictEqual(H.undoDepth(eng), d + 1);
  H.undo(eng);
  assert.strictEqual(find(eng, 'a').gain, 1);
  assert.strictEqual(eng.doc.loop, null);
});

test('恢复检查点为新分支：撤销以检查点（分支起点）为界，原分支不受影响', () => {
  const eng = H.createEngine();
  H.commit(eng, addPatch(clip('a', 0)), {});
  H.commit(eng, addPatch(clip('b', 1)), {});
  const cp = H.createCheckpoint(eng, 'cp');
  // 主分支继续
  H.commit(eng, updPatch('a', { gain: 0.2 }, { gain: 1 }), {});
  // 从检查点恢复为新分支
  const nb = H.restoreCheckpointAsBranch(eng, cp.id, '恢复');
  assert.strictEqual(nb.root, cp.node);
  assert.strictEqual(eng.current, cp.node, '恢复后指针在检查点节点');
  assert.strictEqual(H.canUndo(eng), false, '恢复分支以起点为撤销底界');
  // 在恢复分支上加一个操作，可撤一次回到检查点
  H.commit(eng, addPatch(clip('d', 2)), {});
  assert.strictEqual(H.canUndo(eng), true);
  H.undo(eng);
  assert.strictEqual(eng.current, cp.node);
  assert.strictEqual(H.canUndo(eng), false, '再撤不越过分支起点');
  // 主分支的后续历史完好
  const main = eng.branches['b-main'];
  H.switchBranch(eng, main.id);
  assert.strictEqual(find(eng, 'a').gain, 0.2);
});

console.log(passed + ' 项 history-core 测试通过');
