'use strict';

/* ================= 存储编排：历史引擎 + WAL + 素材库 + 崩溃恢复 =================
   记录类型（按真实操作顺序占 WAL seq）：
     op   一次真实编辑：节点信息 + 补丁 + 若 fork 则带新分支
     pos  撤销/重做/切换造成的「当前位置」移动（不含补丁，仅指针）
     meta 分支重命名 / 检查点增删改等元数据
   每 ~150 个操作帧写一次快照（压缩旧记录）：只动存储层，历史图节点一个不删，
   检查点、分支起点、当前可撤销范围因此完全不变。
   localStorage「意图清单」记录已提交未确认的操作：崩溃后与 WAL 确认位对账，
   明确告诉用户丢了哪些未保存操作。 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const SNAPSHOT_EVERY = 150;
  const INTENT_KEY = 'audio-timeline:intents';

  /* ---------- 意图清单（localStorage 尽力而为） ---------- */

  function intentLog() {
    try {
      const raw = localStorage.getItem(INTENT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }
  function intentSave(list) {
    try { localStorage.setItem(INTENT_KEY, JSON.stringify(list.slice(-300))); }
    catch (_) { /* 配额/隐私模式：只影响丢失诊断精度，不影响帧恢复 */ }
  }
  function intentAdd(rec) { const l = intentLog(); l.push(rec); intentSave(l); }
  function intentConfirm(id) { intentSave(intentLog().filter(r => r.id !== id)); }

  /* ---------- Store ---------- */

  function createStore(deps) {
    const H = deps.H;
    const W = deps.W;
    const wal = deps.wal;
    let eng = null;
    let seq = 0;
    let snapshotSeq = 0;
    let opsSinceSnapshot = 0;
    let saveFailures = [];
    const statusListeners = new Set();
    const state = {
      degraded: !!deps.degraded,
      degradeReason: deps.degradeReason || '',
      ready: false,
      problems: [],
      lostIntents: [],
      saving: false,
      pending: 0,
    };

    function emit() {
      state.saving = state.pending > 0;
      for (const fn of statusListeners) { try { fn(status()); } catch (_) {} }
    }
    function onStatus(fn) { statusListeners.add(fn); wal.on(() => emit()); return () => statusListeners.delete(fn); }
    function status() {
      return {
        saving: state.pending > 0, pending: state.pending,
        degraded: state.degraded, seq, snapshotSeq,
        failures: saveFailures.slice(-5),
      };
    }

    /* ---------- 打开 / 恢复 ---------- */

    async function open() {
      const rec = await wal.open();
      state.problems = rec.problems.slice();

      // 1) 有快照 ⇒ 从快照恢复引擎；快照损坏则退回「空引擎 + 全量日志」（若操作帧还在）
      let fromSnapshot = false;
      if (rec.snapshot) {
        try {
          eng = H.deserialize(JSON.stringify(rec.snapshot.data.eng));
          (eng._loadProblems || []).forEach(p => state.problems.push(p));
          fromSnapshot = true;
        } catch (e) {
          state.problems.push('压缩快照无法读取（' + e.message + '），改用操作日志重建');
          eng = H.createEngine();
        }
      } else {
        eng = H.createEngine();
      }

      // 2) 按 seq 顺序重放快照之后的记录（顺序与页面关闭前一致）
      let replayErrors = 0;
      for (const f of rec.frames) {
        const r = f.data;
        try {
          if (r.kind === 'op') replayOp(eng, r);
          else if (r.kind === 'amend') replayAmend(eng, r);
          else if (r.kind === 'pos') replayPos(eng, r);
          else if (r.kind === 'meta') replayMeta(eng, r);
        } catch (e) {
          replayErrors++;
          state.problems.push(`第 ${f.seq} 条记录（${r.label || r.kind}）重放失败已跳过：${e.message}`);
        }
      }
      if (replayErrors) state.problems.push(`共有 ${replayErrors} 条损坏记录被跳过，已保留此前最近完整状态`);

      // 3) seq 簿记
      snapshotSeq = rec.snapshot ? rec.snapshot.seq : 0;
      const maxOpSeq = rec.frames.reduce((m, f) => Math.max(m, f.seq), snapshotSeq);
      seq = rec.manifest ? Math.max(rec.manifest.committed || 0, maxOpSeq) : maxOpSeq;
      opsSinceSnapshot = rec.frames.filter(f => f.data.kind === 'op').length;

      // 3.5) 工作文档以最终 current 为准重放一次（amend 可能替换了早期补丁）
      if (eng.nodes[eng.current]) {
        eng.doc = H.materialize(eng, eng.current, undefined, undefined, (id, e) => {
          state.problems.push('历史节点 ' + id + ' 补丁损坏已跳过：' + e.message);
        });
      }

      // 4) 意图清单对账：未出现在已确认记录里的意图 = 丢失的未保存操作
      const confirmedIntentIds = new Set();
      for (const f of rec.frames) { if (f.data.intentId) confirmedIntentIds.add(f.data.intentId); }
      const lost = [];
      for (const i of intentLog()) {
        if (confirmedIntentIds.has(i.id)) continue;
        lost.push(i);
      }
      state.lostIntents = lost;
      if (lost.length) {
        const names = lost.map(i => '「' + i.label + '」').join('、');
        state.problems.push(
          `上次有 ${lost.length} 个操作在保存完成前页面关闭或写入失败，未能恢复：${names}。` +
          `已为你保留此前最近一次完整状态（截止第 ${seq} 条记录）。`);
      }
      intentSave([]);

      state.ready = true;
      emit();
      return { eng, problems: state.problems, lostIntents: lost };
    }

    function registerBranches(engine, r) {
      if (r.newBranches) for (const nb of r.newBranches) {
        if (!engine.branches[nb.id]) engine.branches[nb.id] = { ...nb };
      }
      if (r.branchId && engine.branches[r.branchId]) engine.branchId = r.branchId;
    }

    function applyBranchHead(engine, r) {
      if (r.branchId && engine.branches[r.branchId]) {
        engine.branchId = r.branchId;
        engine.branches[r.branchId].head = r.headId;
        engine.current = r.headId;
      }
    }

    function replayOp(engine, r) {
      registerBranches(engine, r);
      if (!engine.nodes[r.nodeId]) {
        engine.nodes[r.nodeId] = {
          id: r.nodeId, parent: r.parentId,
          fwd: r.patch, rev: H.invertPatch(r.patch),
          label: r.label, time: r.time, seq: r.nodeSeq || 1, compact: false,
        };
        (engine.children[r.parentId] = engine.children[r.parentId] || []).push(r.nodeId);
        engine.children[r.nodeId] = [];
      }
      H.applyPatch(engine.doc, r.patch);
      applyBranchHead(engine, r);
      if (r.movedCheckpoints) for (const [cid, nodeId] of Object.entries(r.movedCheckpoints)) {
        if (engine.checkpoints[cid]) engine.checkpoints[cid].node = nodeId;
      }
      const numeric = parseInt(String(r.nodeId).replace(/\D/g, ''), 10);
      if (Number.isFinite(numeric)) engine.seq = Math.max(engine.seq, numeric + 1);
    }

    /* 合并提交帧：节点必须已由其首帧（op）建立，只替换补丁与标签；
       若合并发生在自动分叉的第一次手势（op 帧先建节点、amend 帧才带分叉信息），
       在这里补建分支并把末端归属切过去。首帧丢失则跳过，保留此前完整状态。 */
    function replayAmend(engine, r) {
      registerBranches(engine, r);
      const n = engine.nodes[r.nodeId];
      if (!n) throw new Error('合并记录找不到基础节点 ' + r.nodeId);
      n.fwd = r.fwd; n.rev = r.rev;
      if (r.label) n.label = r.label;
      if (r.time) n.time = r.time;
      applyBranchHead(engine, r);
    }

    function replayPos(engine, r) {
      if (r.branchId && engine.branches[r.branchId]) {
        engine.branchId = r.branchId;
        if (engine.nodes[r.headId]) engine.current = r.headId;
      }
    }

    function replayMeta(engine, r) {
      const { meta, payload } = r;
      switch (meta) {
        case 'renameBranch':
          if (engine.branches[payload.id]) engine.branches[payload.id].name = payload.name;
          break;
        case 'newBranch':
          if (!engine.branches[payload.id]) engine.branches[payload.id] = { ...payload };
          break;
        case 'checkpoint':
          engine.checkpoints[payload.id] = { ...payload };
          break;
        case 'renameCheckpoint':
          if (engine.checkpoints[payload.id]) engine.checkpoints[payload.id].name = payload.name;
          break;
        case 'removeCheckpoint':
          delete engine.checkpoints[payload.id];
          break;
        case 'restoreCheckpoint': {
          // 恢复检查点时已把新分支写进当时的 newBranch meta（app 侧）；这里兜底定位分支
          const b = payload.branch && engine.branches[payload.branch];
          if (b) { engine.branchId = b.id; engine.current = b.head; }
          break;
        }
      }
    }

    /* ---------- 提交 ---------- */

    let intentCounter = 0;
    function nextIntent() {
      return { id: 'i' + Date.now().toString(36) + '-' + (++intentCounter), at: Date.now() };
    }

    /* 所有记录走同一个 FIFO 保存队列：帧的 seq 在真正入队时分配，
       因此快速连续操作与后台保存并发时，落盘顺序 == 提交顺序 == 恢复顺序。
       写失败只影响这一帧（WAL 确认位不前进），后续帧照常保存，最近完整状态得以保留。 */
    let chain = Promise.resolve();
    function enqueueRecord(rec, label, onOpCommitted) {
      const intent = rec.intentId;
      state.pending++; emit();
      intentAdd({ id: intent, label, at: Date.now() });
      const job = async () => {
        const assignedSeq = seq + 1;
        intentSave(intentLog().map(i => i.id === intent ? { ...i, seq: assignedSeq } : i));
        try {
          const realSeq = await wal.append(rec); // WAL 内部按 committed+1 编号
          seq = realSeq;
          intentConfirm(intent);
          if (onOpCommitted) onOpCommitted(realSeq);
        } catch (err) {
          const msg = err && err.code === 'QUOTA'
            ? `存储空间不足，「${label}」未能保存，刷新后将丢失该操作；此前的完整状态已保留`
            : `「${label}」日志写入中断（${err.message || err}），该操作可能丢失；最近完整状态已保留`;
          saveFailures.push(msg);
        } finally {
          state.pending--; emit();
        }
      };
      // 队列自身永不向下传拒绝（失败已记入 saveFailures），避免未处理拒绝中断后续保存
      const run = chain.then(job, job);
      chain = run.catch(() => {});
      return run;
    }

    function commit(patch, opts) {
      opts = opts || {};
      const result = H.commit(eng, patch, opts);
      const intent = nextIntent();
      let rec;
      if (result.merged) {
        // 连续手势（拖动/调节）合并：发 amend 帧替换末端节点补丁，不新增历史节点。
        // 若合并发生在撤销后（自动分叉），首帧之后的 amend 仍可能带着分叉信息（一般不会，
        // 但为稳健同样携带）。
        rec = {
          kind: 'amend', intentId: intent.id,
          nodeId: result.node.id,
          branchId: eng.branchId, headId: eng.current,
          fwd: result.node.fwd, rev: result.node.rev,
          label: result.node.label, time: result.node.time,
          newBranches: result.forked ? [{ ...eng.branches[eng.branchId] }] : undefined,
        };
      } else {
        rec = {
          kind: 'op', intentId: intent.id,
          nodeId: result.node.id, parentId: result.node.parent,
          branchId: eng.branchId, headId: result.node.id,
          time: result.node.time, label: result.node.label,
          nodeSeq: result.node.seq, patch: result.node.fwd,
          coalesced: false,
          newBranches: result.forked ? [{ ...eng.branches[eng.branchId] }] : undefined,
        };
        opsSinceSnapshot++;
      }
      enqueueRecord(rec, result.node.label, () => {
        if (!result.merged && opsSinceSnapshot >= SNAPSHOT_EVERY) { opsSinceSnapshot = 0; maybeCompact(); }
      });
      return result;
    }

    /* 撤销/重做/切换后落盘位置帧：刷新后回到关闭前看到的状态 */
    function persistPosition(label) {
      const intent = nextIntent();
      enqueueRecord({
        kind: 'pos', intentId: intent.id,
        branchId: eng.branchId, headId: eng.current,
        time: Date.now(), label: label || '切换历史位置',
      }, label || '切换历史位置');
    }

    function persistMeta(kind, payload, label) {
      const intent = nextIntent();
      enqueueRecord({
        kind: 'meta', intentId: intent.id, meta: kind, payload,
        branchId: eng.branchId, headId: eng.current, time: Date.now(), label,
      }, label || '元数据');
    }

    /* ---------- 压缩：引擎全量快照 + 清理旧操作帧（节点不删，撤销范围不变） ---------- */

    let compacting = false;
    function maybeCompact(force) {
      if (compacting) return Promise.resolve();
      if (!force && opsSinceSnapshot < SNAPSHOT_EVERY) return Promise.resolve();
      compacting = true;
      // 必须排在所有已提交保存之后：快照锚点取「执行时已确认的最后一帧」
      const run = chain.then(async () => {
        const data = { eng: JSON.parse(H.serialize(eng)), at: Date.now() };
        const anchorSeq = await wal.writeSnapshot(data);
        snapshotSeq = anchorSeq;
        opsSinceSnapshot = 0;
        await wal.cleanupOldFrames();
        return { anchorSeq };
      }).catch(e => {
        saveFailures.push('历史压缩失败（不影响当前编辑与已有历史）：' + (e.message || e));
        emit();
      }).then(r => { compacting = false; return r; });
      chain = run.catch(() => {});
      return run;
    }

    /* ---------- 素材库（按内容哈希去重，绝不随每个历史节点重复保存音频） ---------- */

    function putMedia(hash, bytes) { return wal.putBlob(hash, bytes); }
    function hasMedia(hash) { return wal.hasBlob(hash); }
    function getMedia(hash) { return wal.getMedia ? wal.getMedia(hash) : wal.getBlob(hash); }

    /* 响度分段缓存（CRC 帧直存 KV，不进 WAL 操作流；丢失只触发重算） */
    function putLoudSegment(fp, bytes) { return wal.putSegment(fp, bytes); }
    function getLoudSegment(fp) { return wal.getSegment(fp); }
    function hasLoudSegment(fp) { return wal.hasSegment(fp); }
    function clearLoudSegments() { return wal.clearSegments(); }
    function hashArrayBuffer(ab) { return W.hashBytes(new Uint8Array(ab)); }

    function markMedia(hash, set, label) {
      const m = eng.doc.media[hash];
      if (!m) return;
      const old = {};
      const normSet = {};
      for (const k of Object.keys(set)) {
        // missing/corrupt 规范化为布尔，old 也给确定值（undefined→false），
        // 保证撤销补丁能把标记明确重置回 false（不会因 JSON 丢 undefined 而失效）
        if (k === 'missing' || k === 'corrupt') {
          normSet[k] = !!set[k];
          old[k] = !!m[k];
        } else {
          normSet[k] = set[k];
          old[k] = m[k];
        }
      }
      commit([{ op: 'mediaStatus', hash, set: normSet, old }], { label: label || '素材状态变更' });
    }

    function flush() { return chain.then(() => wal.flush()); }
    function dirty() { return state.pending > 0; }
    function dismissFailure(i) { saveFailures.splice(i, 1); emit(); }

    return {
      open, commit, persistPosition, persistMeta,
      putMedia, hasMedia, getMedia, hashArrayBuffer, markMedia,
      putLoudSegment, getLoudSegment, hasLoudSegment, clearLoudSegments,
      maybeCompact, flush, dirty, onStatus, dismissFailure, status,
      get eng() { return eng; },
      get seq() { return seq; },
      get state() { return state; },
      _replay: { op: replayOp, pos: replayPos, meta: replayMeta },
    };
  }

  return { createStore, intentLog, intentSave, intentAdd, intentConfirm, SNAPSHOT_EVERY };
});
