'use strict';

/* ================= 可分支编辑历史核心（纯逻辑，无 DOM / 无存储） =================
   设计要点：
   - 历史是一棵 DAG（实际为树）：每个节点保存「正向补丁」fwd 与「逆向补丁」rev，
     父节点为 parent。撤销 = 沿 parent 应用 rev；重做 = 沿子节点应用 fwd。
   - 在非分支末端（撤销后、或切到别的分支后）继续编辑时，自动 fork 出一条新分支，
     原来的后续历史一个字节都不丢（不做静默截断）。
   - 检查点 = 给某个节点起的名字，可比较、预览（预览由 UI 层用 materialize 构建临时文档）、
     「恢复为新分支」（fork）或「回到原分支」（仅切换指针）。
   - 节点可被标记 compact（旧补丁折叠后的锚点），折叠绝不删除节点，因此检查点、
     分支起点、当前可撤销深度都不变。
   - 浏览器与 Node 同一份代码（UMD）。 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const SCHEMA_VERSION = 1;
  const COMPACT_MARKER = '__compact__';

  let nodeSeq = 1;
  let branchSeq = 1;
  let cpSeq = 1;

  /* ---------- 文档 ---------- */

  function emptyDoc() {
    return {
      clips: [],          // {id, name, mediaHash, duration, offset, gain, fadeIn, fadeOut, autoGain?}
      media: {},          // hash -> {hash, name, size, type, duration, channels, sampleRate, missing, corrupt, relinkedFrom}
      loop: null,         // {a, b}
      loopOn: true,
    };
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function genClipId() {
    return 'c' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- 补丁 ----------
     补丁 = 若干原子操作的数组（一次真实操作 = 一个补丁）：
       {op:'add', clip:{...}}
       {op:'remove', clip:{...快照}}
       {op:'update', id, set:{...新值}, old:{...旧值}}
       {op:'mediaAdd', m:{...}}
       {op:'mediaRemove', hash}
       {op:'mediaStatus', hash, set:{...}, old:{...}}
       {op:'loop', new:{a,b}|null, old:{a,b}|null}
       {op:'loopOn', new:bool, old:bool}                                          */

  function applyPatch(doc, patch) {
    for (const p of patch) {
      switch (p.op) {
        case 'add': {
          if (doc.clips.some(c => c.id === p.clip.id)) throw new Error('add: 片段 id 已存在 ' + p.clip.id);
          doc.clips.push(clone(p.clip));
          break;
        }
        case 'remove': {
          const i = doc.clips.findIndex(c => c.id === p.id);
          if (i < 0) throw new Error('remove: 片段不存在 ' + p.id);
          doc.clips.splice(i, 1);
          break;
        }
        case 'update': {
          const c = doc.clips.find(x => x.id === p.id);
          if (!c) throw new Error('update: 片段不存在 ' + p.id);
          Object.assign(c, clone(p.set));
          break;
        }
        case 'mediaAdd': {
          doc.media[p.m.hash] = clone(p.m);
          break;
        }
        case 'mediaRemove': {
          delete doc.media[p.hash];
          break;
        }
        case 'mediaStatus': {
          const m = doc.media[p.hash];
          if (m) Object.assign(m, clone(p.set));
          break;
        }
        case 'loop':
          doc.loop = p.new ? clone(p.new) : null;
          break;
        case 'loopOn':
          doc.loopOn = !!p.new;
          break;
        default:
          throw new Error('未知补丁操作: ' + p.op);
      }
    }
  }

  function invertPatch(patch) {
    const out = [];
    for (let i = patch.length - 1; i >= 0; i--) {
      const p = patch[i];
      switch (p.op) {
        case 'add': out.push({ op: 'remove', id: p.clip.id }); break;
        case 'remove': out.push({ op: 'add', clip: p.clip }); break;
        case 'update': out.push({ op: 'update', id: p.id, set: p.old, old: p.set }); break;
        case 'mediaAdd': out.push({ op: 'mediaRemove', hash: p.m.hash }); break;
        case 'mediaRemove': /* 逆向信息不足时忽略（mediaRemove 正常不产生） */ break;
        case 'mediaStatus': out.push({ op: 'mediaStatus', hash: p.hash, set: p.old, old: p.set }); break;
        case 'loop': out.push({ op: 'loop', new: p.old, old: p.new }); break;
        case 'loopOn': out.push({ op: 'loopOn', new: p.old, old: p.new }); break;
      }
    }
    return out;
  }

  /* 合并两个相邻的同类补丁（连续拖动 / 连续调节用）。
     合并不了返回 null —— 调用方保留两个独立节点。
     支持：①单原子 update/loop/loopOn；②多原子「同片段序列、同字段集合」的批量 update。 */
  function mergePatches(a, b) {
    if (a.length === 1 && b.length === 1) {
      const x = a[0], y = b[0];
      if (x.op !== y.op) return null;
      if (x.op === 'update') {
        if (x.id !== y.id) return null;
        const kx = Object.keys(x.set).sort().join(','), ky = Object.keys(y.set).sort().join(',');
        if (kx !== ky) return null;
        return [{ op: 'update', id: x.id, set: y.set, old: x.old }];
      }
      if (x.op === 'loop') return [{ op: 'loop', new: y.new, old: x.old }];
      if (x.op === 'loopOn') return [{ op: 'loopOn', new: y.new, old: x.old }];
      return null;
    }
    // 多原子批量 update：op 全是 update、id 顺序一致、每条字段集合一致
    if (a.length === b.length && a.length > 1 && a.every(p => p.op === 'update') && b.every(p => p.op === 'update')) {
      for (let i = 0; i < a.length; i++) {
        if (a[i].id !== b[i].id) return null;
        const kx = Object.keys(a[i].set).sort().join(',');
        const ky = Object.keys(b[i].set).sort().join(',');
        if (kx !== ky) return null;
      }
      return a.map((p, i) => ({ op: 'update', id: p.id, set: b[i].set, old: p.old }));
    }
    return null;
  }

  /* ---------- 引擎 ---------- */

  function createEngine(doc) {
    doc = doc || emptyDoc();
    const root = {
      id: 'n0', parent: null, fwd: [], rev: [],
      label: '初始状态', time: Date.now(), seq: 0, compact: false,
    };
    const main = 'b-main';
    return {
      v: SCHEMA_VERSION,
      seq: 1,
      nodes: { n0: root },
      children: { n0: [] },
      branches: { [main]: { id: main, name: '主分支', root: 'n0', head: 'n0', created: Date.now() } },
      current: 'n0',
      branchId: main,
      checkpoints: {},
      doc,
    };
  }

  function nodeAt(eng, id) {
    const n = eng.nodes[id];
    if (!n) throw new Error('历史节点不存在: ' + id);
    return n;
  }

  /* 从指定节点（默认根）物化出文档，用于预览/比较/切换。
     onProblem(id, err) 非空时，损坏补丁节点会被跳过并上报（恢复路径用）。 */
  function materialize(eng, targetId, fromId, fromDoc, onProblem) {
    const report = (id, e) => { if (onProblem) onProblem(id, e); else throw e; };
    targetId = targetId || eng.current;
    if (fromId === undefined || fromDoc === undefined) {
      // 完整重建：根 → target
      const chain = [];
      let n = nodeAt(eng, targetId);
      while (n) { chain.push(n); n = n.parent ? eng.nodes[n.parent] : null; }
      let doc = emptyDoc();
      for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i];
        try { applyPatch(doc, node.fwd || []); }
        catch (e) { report(node.id, e); }
      }
      return doc;
    }
    // 从已知文档（fromId 状态）走到 targetId（同根即可）：先回到共同祖先，再向前
    const anc = commonAncestor(eng, fromId, targetId);
    let doc = clone(fromDoc);
    const back = [];
    let cur = fromId;
    while (cur !== anc) { const n = nodeAt(eng, cur); back.push(n); cur = n.parent; }
    for (const n of back) {
      try { applyPatch(doc, n.rev || []); } catch (e) { report(n.id, e); }
    }
    const fwd = [];
    cur = targetId;
    while (cur !== anc) { const n = nodeAt(eng, cur); fwd.push(n); cur = n.parent; }
    for (let i = fwd.length - 1; i >= 0; i--) {
      const node = fwd[i];
      try { applyPatch(doc, node.fwd || []); } catch (e) { report(node.id, e); }
    }
    return doc;
  }

  function ancestors(eng, id) {
    const out = [];
    let cur = id;
    while (cur) { out.push(cur); const n = eng.nodes[cur]; cur = n && n.parent; }
    return out;
  }

  function commonAncestor(eng, a, b) {
    const sa = new Set(ancestors(eng, a));
    for (const id of ancestors(eng, b)) if (sa.has(id)) return id;
    return null;
  }

  function isAncestor(eng, maybeAncestor, id) {
    let cur = id;
    while (cur) { if (cur === maybeAncestor) return true; cur = nodeAt(eng, cur).parent; }
    return false;
  }

  /* 提交一个真实操作。返回 {node, forked}。
     opts: {label, time, coalesceWithLast}
     coalesceWithLast=true 时，若当前节点与新补丁是同类型连续操作，则并入当前末端节点。 */
  function commit(eng, patch, opts) {
    opts = opts || {};
    const br = eng.branches[eng.branchId];
    // 连续操作合并：仅当当前指针正好在本分支末端，且末端节点可合并
    if (opts.coalesceWithLast && br && eng.current === br.head) {
      const head = eng.nodes[br.head];
      if (head && head.parent !== null && !head.compact) {
        const merged = mergePatches(head.fwd, patch);
        if (merged) {
          head.fwd = merged;
          head.rev = invertPatch(merged);
          head.time = opts.time || head.time;
          if (opts.label) head.label = opts.label;
          applyPatch(eng.doc, patch); // 合并语义等价于再施加一次增量（b 的效果）
          return { node: head, forked: false, merged: true };
        }
      }
    }
    // 分叉判定：当前指针不是本分支末端 ⇒ 老的 redo 路径必须保留，开新分支
    let forked = false;
    if (!br || eng.current !== br.head) {
      const name = (br ? br.name : '分支') + ' · 分叉 ' + branchSeq;
      const nb = {
        id: 'b' + branchSeq++, name,
        root: eng.current, head: eng.current, created: opts.time || Date.now(),
      };
      eng.branches[nb.id] = nb;
      eng.branchId = nb.id;
      forked = true;
    }
    const id = 'n' + eng.seq++;
    const node = {
      id, parent: eng.current,
      fwd: clone(patch), rev: invertPatch(patch),
      label: opts.label || defaultLabel(patch),
      time: opts.time || Date.now(),
      seq: nodeSeq++, compact: false,
    };
    eng.nodes[id] = node;
    (eng.children[eng.current] = eng.children[eng.current] || []).push(id);
    eng.children[id] = [];
    applyPatch(eng.doc, patch);
    eng.current = id;
    eng.branches[eng.branchId].head = id;
    return { node, forked, merged: false };
  }

  function defaultLabel(patch) {
    for (const p of patch) {
      if (p.op === 'add') return '导入 ' + (p.clip.name || '片段');
      if (p.op === 'remove') return '删除片段';
      if (p.op === 'update') {
        const k = Object.keys(p.set)[0];
        return ({
          offset: '移动片段', gain: '调节增益', fadeIn: '调淡入', fadeOut: '调淡出',
          autoGain: '响度修正（增益曲线）',
        })[k] || '修改片段';
      }
      if (p.op === 'loop') return p.new ? '设置循环区间' : '清除循环区间';
      if (p.op === 'loopOn') return '循环开关';
      if (p.op === 'mediaStatus') return '素材状态变更';
    }
    return '编辑';
  }

  function canUndo(eng) {
    const n = eng.nodes[eng.current];
    if (!n || n.parent === null || eng.current === 'n0') return false;
    // 分叉分支（主分支之外的任何分支）撤到分叉点即到底；之前的历史属于原分支
    const br = eng.branches[eng.branchId];
    if (br && br.id !== 'b-main' && eng.current === br.root) return false;
    return true;
  }

  function undo(eng) {
    if (!canUndo(eng)) return null;
    const n = eng.nodes[eng.current];
    applyPatch(eng.doc, n.rev);
    eng.current = n.parent;
    return n;
  }

  /* 重做：沿当前分支 head 路径上的唯一后继；分叉处的其他子节点不属于本分支，不可静默重做到它们 */
  function redoTarget(eng) {
    const br = eng.branches[eng.branchId];
    if (!br || !isAncestor(eng, eng.current, br.head) || eng.current === br.head) return null;
    // head 的祖先链里，current 的直接后继
    const chain = ancestors(eng, br.head); // head -> ... -> root
    const idx = chain.indexOf(eng.current);
    return idx >= 0 ? chain[idx - 1] : null;
  }

  function canRedo(eng) { return !!redoTarget(eng); }

  function redo(eng) {
    const id = redoTarget(eng);
    if (!id) return null;
    const n = eng.nodes[id];
    applyPatch(eng.doc, n.fwd);
    eng.current = id;
    return n;
  }

  /* 从 current 到某分支 head 路径上的直接后继（沿路径 redo，不碰分叉侧枝） */
  function nextOnPath(eng, branchId) {
    const br = eng.branches[branchId];
    if (!br || !isAncestor(eng, eng.current, br.head)) return null;
    if (eng.current === br.head) return null;
    const chain = ancestors(eng, br.head);
    const idx = chain.indexOf(eng.current);
    return idx >= 0 ? chain[idx - 1] : null;
  }

  /* 撤销/重做深度（状态栏用）。主分支沿父链到根；任何分叉分支以分叉点（分支起点）为界，
     分叉点之前的历史属于原分支（切回原分支即可撤销/重做）。 */
  function undoDepth(eng) {
    const br = eng.branches[eng.branchId];
    const stop = br && br.id !== 'b-main' ? br.root : 'n0';
    let d = 0, cur = eng.current;
    while (cur && cur !== stop && cur !== 'n0') { d++; cur = nodeAt(eng, cur).parent; }
    return d;
  }
  function redoDepth(eng) {
    const br = eng.branches[eng.branchId];
    if (!br || !isAncestor(eng, eng.current, br.head)) return 0;
    let d = 0, cur = br.head;
    while (cur !== eng.current) { d++; cur = nodeAt(eng, cur).parent; }
    return d;
  }

  /* 切换分支：把工作文档移到目标分支末端（目标状态由补丁重放得到，不丢任何历史） */
  function switchBranch(eng, branchId) {
    const br = eng.branches[branchId];
    if (!br) return false;
    if (branchId === eng.branchId && eng.current === br.head) return true;
    eng.doc = materialize(eng, br.head);
    eng.branchId = branchId;
    eng.current = br.head;
    return true;
  }

  function renameBranch(eng, branchId, name) {
    const br = eng.branches[branchId];
    if (br && name) br.name = name;
  }

  function branchesList(eng) {
    return Object.values(eng.branches)
      .sort((a, b) => a.created - b.created)
      .map(b => ({ ...b, current: eng.branchId === b.id, atHead: eng.current === b.head }));
  }

  /* 从当前指针（或指定节点）fork 一条可命名的新分支。
     boundary=true 表示显式分支（从检查点恢复/用户新建）：撤销以起点为界；
     撤销后继续编辑的自动分叉不设 boundary，可沿父链连续撤销。 */
  function forkBranch(eng, name, fromNodeId, boundary) {
    const root = fromNodeId || eng.current;
    if (!eng.nodes[root]) return null;
    const nb = {
      id: 'b' + branchSeq++, name: name || ('分支 ' + branchSeq),
      root, head: root, created: Date.now(), boundary: !!boundary,
    };
    eng.branches[nb.id] = nb;
    return nb;
  }

  /* ---------- 检查点 ---------- */

  function createCheckpoint(eng, name, nodeId) {
    const at = nodeId || eng.current;
    if (!eng.nodes[at]) return null;
    const cp = { id: 'cp' + cpSeq++, name: name || ('检查点 ' + cpSeq), node: at, time: Date.now() };
    eng.checkpoints[cp.id] = cp;
    return cp;
  }

  function renameCheckpoint(eng, id, name) {
    if (eng.checkpoints[id] && name) eng.checkpoints[id].name = name;
  }

  function removeCheckpoint(eng, id) { delete eng.checkpoints[id]; }

  /* 恢复检查点为一条新分支（保留当前工作所在分支，随时可切回）。
     显式恢复 ⇒ boundary 分支，撤销停在检查点状态。 */
  function restoreCheckpointAsBranch(eng, cpId, name) {
    const cp = eng.checkpoints[cpId];
    if (!cp) return null;
    const nb = forkBranch(eng, name || (cp.name + ' 恢复'), cp.node, true);
    eng.branchId = nb.id;
    eng.current = nb.head;
    eng.doc = materialize(eng, nb.head);
    return nb;
  }

  /* 回到已有分支（= 只切指针；目标状态完整重放） */
  function goToBranch(eng, branchId) { return switchBranch(eng, branchId); }

  /* 跳到任意历史节点：在当前分支路径上即撤销/重方式移动；到侧枝节点则只是把工作文档
     物化到该处观察（分支归属不变，随后提交会自动 fork，绝不静默丢弃 redo 路径）。 */
  function goToNode(eng, nodeId) {
    if (!eng.nodes[nodeId]) return null;
    if (nodeId === eng.current) return { moved: true, mode: 'here' };
    const br = eng.branches[eng.branchId];
    const onBranchPath = br && isAncestor(eng, nodeId, br.head);
    eng.doc = materialize(eng, nodeId, eng.current, eng.doc);
    eng.current = nodeId;
    return { moved: true, mode: onBranchPath ? 'path' : 'detour' };
  }

  /* ---------- 文档比较（当前 vs 任一检查点/节点） ---------- */

  function diffDocs(baseDoc, curDoc) {
    const out = { added: [], removed: [], changed: [], media: [] };
    const baseById = new Map(baseDoc.clips.map(c => [c.id, c]));
    const curById = new Map(curDoc.clips.map(c => [c.id, c]));
    const PARAMS = ['offset', 'gain', 'fadeIn', 'fadeOut', 'duration', 'name', 'mediaHash', 'autoGain'];
    for (const c of curDoc.clips) {
      const b = baseById.get(c.id);
      if (!b) { out.added.push(clone(c)); continue; }
      const fields = {};
      for (const k of PARAMS) {
        if (JSON.stringify(b[k]) !== JSON.stringify(c[k])) fields[k] = { from: b[k], to: c[k] };
      }
      if (Object.keys(fields).length) out.changed.push({ id: c.id, name: c.name, fields });
    }
    for (const c of baseDoc.clips) if (!curById.has(c.id)) out.removed.push(clone(c));
    // 素材层差异（缺失 / 损坏 / 重新关联）
    const hashes = new Set([...Object.keys(baseDoc.media), ...Object.keys(curDoc.media)]);
    for (const h of hashes) {
      const a = baseDoc.media[h], b = curDoc.media[h];
      if (a && !b) out.media.push({ hash: h, name: a.name, kind: 'removed-meta' });
      else if (!a && b) out.media.push({ hash: h, name: b.name, kind: 'added-meta' });
      else if ((!!a.missing !== !!b.missing) || (!!a.corrupt !== !!b.corrupt) || a.relinkedFrom !== b.relinkedFrom) {
        out.media.push({
          hash: h, name: b.name, kind: 'status',
          from: { missing: !!a.missing, corrupt: !!a.corrupt, relinkedFrom: a.relinkedFrom || null },
          to: { missing: !!b.missing, corrupt: !!b.corrupt, relinkedFrom: b.relinkedFrom || null },
        });
      }
    }
    if (JSON.stringify(baseDoc.loop) !== JSON.stringify(curDoc.loop) ||
        JSON.stringify(baseDoc.loopOn) !== JSON.stringify(curDoc.loopOn)) {
      out.loop = { from: baseDoc.loop, to: curDoc.loop, fromOn: baseDoc.loopOn, toOn: curDoc.loopOn };
    }
    return out;
  }

  function diffAgainstNode(eng, nodeId) {
    const base = materialize(eng, nodeId);
    return diffDocs(base, eng.doc);
  }

  /* ---------- 压缩（折叠旧补丁，绝不删节点；检查点/分支起点/撤销深度不变） ---------- */

  /* 把某节点标记为压缩锚点：补丁替换为从 parent 状态直达该节点状态的原子快照补丁，
     需要 parent 已知状态。返回修改后的节点。撤销语义不变（rev 由快照差异重建）。 */
  function compactNode(eng, nodeId, stateAtNode, stateAtParent) {
    const n = nodeAt(eng, nodeId);
    if (nodeId === 'n0') return n;
    const fwd = snapshotDiffPatch(stateAtParent, stateAtNode);
    n.fwd = fwd;
    n.rev = invertPatch(fwd);
    n.compact = true;
    return n;
  }

  /* 两份文档之间的「快照型补丁」：media 整体对账 + clips 全量对账 */
  function snapshotDiffPatch(fromDoc, toDoc) {
    const patch = [];
    for (const h of Object.keys(toDoc.media)) {
      if (!fromDoc.media[h]) patch.push({ op: 'mediaAdd', m: toDoc.media[h] });
      else {
        const a = fromDoc.media[h], b = toDoc.media[h];
        const set = {};
        for (const k of ['missing', 'corrupt', 'relinkedFrom', 'name']) {
          if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) set[k] = b[k];
        }
        if (Object.keys(set).length) {
          const old = {};
          for (const k of Object.keys(set)) old[k] = a[k];
          patch.push({ op: 'mediaStatus', hash: h, set, old });
        }
      }
    }
    const fromById = new Map(fromDoc.clips.map(c => [c.id, c]));
    const toById = new Set(toDoc.clips.map(c => c.id));
    for (const c of toDoc.clips) {
      if (!fromById.has(c.id)) patch.push({ op: 'add', clip: c });
      else {
        const a = fromById.get(c.id), set = {};
        for (const k of ['name', 'mediaHash', 'duration', 'offset', 'gain', 'fadeIn', 'fadeOut', 'autoGain']) {
          if (JSON.stringify(a[k]) !== JSON.stringify(c[k])) set[k] = c[k];
        }
        if (Object.keys(set).length) {
          const old = {};
          for (const k of Object.keys(set)) old[k] = a[k];
          patch.push({ op: 'update', id: c.id, set, old });
        }
      }
    }
    for (const c of fromDoc.clips) if (!toById.has(c.id)) patch.push({ op: 'remove', clip: c });
    if (JSON.stringify(fromDoc.loop) !== JSON.stringify(toDoc.loop)) {
      patch.push({ op: 'loop', new: toDoc.loop, old: fromDoc.loop });
    }
    if (!!fromDoc.loopOn !== !!toDoc.loopOn) {
      patch.push({ op: 'loopOn', new: toDoc.loopOn, old: fromDoc.loopOn });
    }
    return patch;
  }

  /* 自动选择可压缩节点：
     保护集合（绝不压缩）= 根、所有检查点所在节点、所有分支起点/末端、当前指针。
     其余「在某分支主干深处、两侧都不是保护点」的旧节点可压。 */
  function compactableNodes(eng) {
    const protectedSet = new Set(['n0', eng.current]);
    for (const cp of Object.values(eng.checkpoints)) protectedSet.add(cp.node);
    for (const b of Object.values(eng.branches)) { protectedSet.add(b.root); protectedSet.add(b.head); }
    return Object.values(eng.nodes)
      .filter(n => !protectedSet.has(n.id) && !n.compact && n.parent !== null)
      .map(n => n.id);
  }

  /* ---------- 序列化（含加载期完整性校验） ---------- */

  function serialize(eng) {
    return JSON.stringify({
      v: SCHEMA_VERSION, seq: eng.seq, nodes: eng.nodes, children: eng.children,
      branches: eng.branches, current: eng.current, branchId: eng.branchId,
      checkpoints: eng.checkpoints, doc: eng.doc,
    });
  }

  function deserialize(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { const err = new Error('历史数据不是合法 JSON: ' + e.message); err.code = 'BAD_JSON'; throw err; }
    const problems = [];
    if (!data || typeof data !== 'object' || !data.nodes || !data.current) {
      const err = new Error('历史数据结构不完整'); err.code = 'BAD_SHAPE'; throw err;
    }
    // 父链校验：断链节点剔除并报告（沿父链找不到根的节点不可达）
    const good = {};
    const check = (id, stack) => {
      if (good[id]) return true;
      if (stack.has(id)) { problems.push('节点 ' + id + ' 存在父链环，已忽略'); return false; }
      const n = data.nodes[id];
      if (!n) { problems.push('节点 ' + id + ' 缺失，已忽略'); return false; }
      if (n.parent === null) { good[id] = true; return true; }
      stack.add(id);
      const ok = check(n.parent, stack);
      stack.delete(id);
      if (ok) good[id] = true;
      return ok;
    };
    for (const id of Object.keys(data.nodes)) check(id, new Set());

    const nodes = {}, children = {};
    for (const id of Object.keys(good)) {
      const n = data.nodes[id];
      nodes[id] = n;
      children[id] = (data.children[id] || []).filter(c => good[c]);
      if (!Array.isArray(n.fwd)) n.fwd = [];
      if (!Array.isArray(n.rev)) n.rev = invertPatch(n.fwd);
    }
    // 分支：起点不可达的分支剔除；末端不可达则回退到路径上最后一个可达节点
    const branches = {};
    for (const [bid, b] of Object.entries(data.branches || {})) {
      if (!good[b.root]) { problems.push('分支「' + b.name + '」起点丢失，已忽略'); continue; }
      let head = good[b.head] ? b.head : b.root;
      if (!good[head]) head = b.root;
      branches[bid] = { ...b, root: b.root, head };
    }
    if (!branches[data.branchId] || !good[data.current]) {
      // 选一个可达分支兜底
      const first = Object.values(branches)[0];
      if (first) { data.branchId = first.id; data.current = good[first.head] ? first.head : first.root; }
    }
    // 检查点所在节点丢失：保留记录但标记 dangling（UI 明确提示），不静默删除
    const checkpoints = {};
    for (const [cid, cp] of Object.entries(data.checkpoints || {})) {
      checkpoints[cid] = { ...cp, dangling: !good[cp.node] };
    }
    let current = good[data.current] ? data.current : 'n0';
    let branchId = branches[data.branchId] ? data.branchId : Object.keys(branches)[0];
    if (!nodes.n0) { const err = new Error('根节点丢失，历史不可恢复'); err.code = 'NO_ROOT'; throw err; }
    const eng = {
      v: SCHEMA_VERSION, seq: data.seq || (Math.max(...Object.keys(nodes).map(k => +k.slice(1) || 0)) + 1),
      nodes, children, branches, current, branchId, checkpoints,
      doc: data.doc && Array.isArray(data.doc.clips) ? data.doc : emptyDoc(),
    };
    // 工作文档与 current 不一致时（最后一条记录损坏的典型情形）以补丁重放为准重建
    const rebuilt = materialize(eng, current, undefined, undefined, (id, e) => {
      problems.push('节点 ' + id + '（' + (nodes[id].label || '编辑') + '）的补丁损坏，已跳过：' + e.message);
    });
    if (JSON.stringify(rebuilt) !== JSON.stringify(eng.doc)) {
      problems.push('工作状态与历史末端不一致，已按历史链重建（最后一次未完整保存的修改未纳入）');
      eng.doc = rebuilt;
    }
    eng._loadProblems = problems;
    return eng;
  }

  /* ---------- 事务辅助（一次连续手势 = 一次可撤销操作） ---------- */

  function transaction(eng, build, opts) {
    let patch = null;
    const api = {
      addClip(clip) { (patch = patch || []).push({ op: 'add', clip: clone(clip) }); },
      removeClip(clipSnapshot) { (patch = patch || []).push({ op: 'remove', id: clipSnapshot.id, clip: clone(clipSnapshot) }); },
      update(id, set, old) {
        const o = {};
        for (const k of Object.keys(set)) { if (old && k in old) o[k] = clone(old[k]); }
        (patch = patch || []).push({ op: 'update', id, set: clone(set), old: o });
      },
      addMedia(m) { (patch = patch || []).push({ op: 'mediaAdd', m: clone(m) }); },
      mediaStatus(hash, set, old) { (patch = patch || []).push({ op: 'mediaStatus', hash, set: clone(set), old: clone(old || {}) }); },
      setLoop(next, old) { (patch = patch || []).push({ op: 'loop', new: next || null, old: old || null }); },
      setLoopOn(next, old) { (patch = patch || []).push({ op: 'loopOn', new: !!next, old: !!old }); },
    };
    build(api);
    if (!patch) return null;
    return commit(eng, patch, opts);
  }

  return {
    SCHEMA_VERSION, COMPACT_MARKER,
    emptyDoc, clone, genClipId,
    applyPatch, invertPatch, mergePatches,
    createEngine, commit, undo, redo, canUndo, canRedo, redoTarget,
    nextOnPath, undoDepth, redoDepth, materialize, commonAncestor, isAncestor,
    switchBranch, renameBranch, branchesList, forkBranch,
    createCheckpoint, renameCheckpoint, removeCheckpoint,
    restoreCheckpointAsBranch, goToBranch, goToNode,
    diffDocs, diffAgainstNode,
    compactNode, compactableNodes, snapshotDiffPatch,
    serialize, deserialize, transaction, defaultLabel,
  };
});
