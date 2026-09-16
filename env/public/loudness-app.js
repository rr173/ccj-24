'use strict';

/* ================= 响度检查任务 / 缓存 / 提案（应用层，无强 DOM 依赖） =================
   职责：
   - 从快照（与导出同源、冻结）按分段跑 loudness-core 分析，逐段缓存（CRC 帧存 KV）；
     编辑后只有内容指纹变化的区段失效，其它区段结果复用。
   - 任务去重（同区间+同规范+同快照只一份）、暂停/继续/取消、后台分段、刷新恢复。
   - 提案：统一增益 / 分段包络 / 真峰值限制；原声↔修正声即时预览；接受=一次批量编辑，
     放弃不改动节目；目标与峰值冲突时如实报告。
   - 旧结果/旧提案在编辑后标记 stale（过期），过期提案不能再应用。
   纯逻辑部分可在 Node 桩下测试（deps 注入渲染、存储、快照）。 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const LC = typeof require !== 'undefined' ? require('./loudness-core.js') : globalThis;

  const TASK_STATUS = ['waiting', 'running', 'paused', 'partial', 'failed', 'canceled', 'done', 'stale'];
  const STATUS_TEXT = {
    waiting: '等待中', running: '正在计算', paused: '已暂停', partial: '部分可用',
    failed: '失败', canceled: '已取消', done: '已完成', stale: '已过期',
  };

  function uid(prefix) {
    return (prefix || 't') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------- 快照指纹（任务去重 + 编辑后失效判定） ---------- */

  function snapshotKey(snap, a, b, presetId) {
    // 区间内全部片段的参数指纹（与分段指纹同源，但覆盖整区间）
    const parts = snap.clips
      .filter(c => c.offset < b && c.offset + c.duration > a)
      .map(c => LC.clipFingerprint(c)).sort().join(';');
    return [presetId, (+a).toFixed(6), (+b).toFixed(6), parts].join('#');
  }

  /* ---------- 任务管理器 ----------
     deps:
       renderMix(snap,t0,t1,ch,onChunk,sr)  与导出/播放一致的离线混音
       getSegment(fp)/putSegment(fp,bytes)  CRC 缓存读写（可空：纯内存）
       yieldControl()
       onUpdate(task)                        状态变化回调（UI 刷新）
       segmentSec                            分段长度（默认 5s） */
  function createTaskManager(deps) {
    deps = deps || {};
    const tasks = [];
    let running = null;
    const listeners = new Set();

    function emit(task) {
      for (const fn of listeners) { try { fn(task); } catch (_) {} }
      if (deps.onUpdate) { try { deps.onUpdate(task); } catch (_) {} }
    }
    function onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); }

    function persist() { if (deps.persist) deps.persist(); }

    /* 提交（去重）：同 key 且处于活动/完成状态的任务只保留一份；
       stale（已过期/已被撤销）任务不参与去重——撤销修正后重新检查同一内容应重新运行。 */
    function submit(req) {
      const key = snapshotKey(req.snap, req.a, req.b, req.preset.id) + '|' + (req.segmentSec || 5);
      const dup = tasks.find(t => t.key === key &&
        ['waiting', 'running', 'paused', 'partial', 'done'].includes(t.status));
      if (dup) return { task: dup, duplicated: true };

      const plan = LC.planSegments(req.a, req.b, { segmentSec: req.segmentSec || deps.segmentSec || 5 });
      const task = {
        id: uid('lt'), key,
        snap: req.snap, a: req.a, b: req.b, preset: req.preset,
        rangeLabel: req.rangeLabel || '',
        plan,
        status: 'waiting',
        channels: req.snap.channels || undefined,
        seg: plan.map(seg => ({ seg, status: 'waiting', result: null, error: null })),
        progress: 0,
        error: '',
        createdAt: Date.now(),
        finishedAt: 0,
        cancelRequested: false,
        pauseRequested: false,
        evaluation: null,
        metrics: null,
        proposals: [],
        activeProposalId: null,
      };
      tasks.unshift(task);
      persist();
      emit(task);
      pump();
      return { task, duplicated: false };
    }

    function findTask(id) { return tasks.find(t => t.id === id); }

    /* 失效判定：给定新快照与区间，哪些段需要重算 */
    function staleSegments(task, newSnap) {
      const stale = [];
      task.seg.forEach((s, i) => {
        const fp = LC.segmentFingerprint(newSnap, s.seg);
        if (fp !== s.fingerprint) stale.push(i);
      });
      return stale;
    }

    /* 编辑后：把引用旧快照的任务/提案整体标记过期（提案基于旧混音，不可再应用）。
       保留已完成段缓存（缓存按内容指纹，新任务会自然复用未变段）。 */
    function markStaleAfterEdit(reason) {
      let n = 0;
      for (const t of tasks) {
        if (['done', 'partial', 'running', 'paused', 'waiting'].includes(t.status)) {
          if (t.status === 'running' || t.status === 'paused' || t.status === 'waiting') t.cancelRequested = true;
          t.status = 'stale';
          t.staleReason = reason || '工程已编辑';
          for (const p of t.proposals) { p.stale = true; p.applicable = false; }
          t.activeProposalId = null;
          n++;
          emit(t);
        }
      }
      if (n) persist();
      return n;
    }

    /* 切换分支/撤销到另一历史位置后，按分支作用域使任务过期（由 UI 调用并传入判定） */
    function markStale(predicate, reason) {
      let n = 0;
      for (const t of tasks) {
        if (predicate && predicate(t)) {
          t.cancelRequested = true;
          t.status = 'stale';
          t.staleReason = reason || '上下文已变化';
          for (const p of t.proposals) { p.stale = true; p.applicable = false; }
          n++; emit(t);
        }
      }
      if (n) persist();
      return n;
    }

    function removeTask(id) {
      const i = tasks.findIndex(t => t.id === id);
      if (i >= 0) { const [t] = tasks.splice(i, 1); if (running === t) running = null; persist(); return true; }
      return false;
    }

    function pause(id) {
      const t = findTask(id);
      if (t && ['running', 'waiting', 'partial'].includes(t.status)) {
        t.pauseRequested = true;
        emit(t); persist();
      }
    }
    function resume(id) {
      const t = findTask(id);
      if (t && (t.status === 'paused' || t.status === 'partial' ||
                (t.status === 'running' && t.pauseRequested) ||
                (t.status === 'waiting' && t.pauseRequested))) {
        t.pauseRequested = false; t.cancelRequested = false;
        if (t.status === 'paused' || t.status === 'partial') {
          // 执行循环可能在 analyzeSegment 内部挂起（仍持槽），标志清除后自续；
          // 若未被 worker 接管则排队（partial 中可能有失败/未完成段需要补算）。
          if (t !== running) {
            const hasPending = t.seg.some(s => s.status !== 'done');
            t.status = hasPending ? 'waiting' : 'done';
            if (hasPending) pump();
          }
        }
        emit(t); persist();
      }
    }
    function cancel(id) {
      const t = findTask(id);
      if (t && ['waiting', 'running', 'paused', 'partial'].includes(t.status)) {
        t.cancelRequested = true; t.pauseRequested = false;
        emit(t);
      }
    }

    /* ---------- 执行循环（后台分段，单任务串行） ---------- */

    function pump() {
      if (running) return;
      const next = tasks.find(t => t.status === 'waiting');
      if (!next) return;
      running = next;
      runTask(next).then(() => { running = null; pump(); },
        () => { running = null; pump(); });
    }

    function isPaused(t) { return t.pauseRequested; }
    function isCanceled(t) { return t.cancelRequested; }

    async function runTask(task) {
      if (task.status === 'stale' || task.cancelRequested) return;
      task.status = 'running';
      task.startedAt = Date.now();
      emit(task);

      const channels = LC_chan(task.snap);
      task.channels = channels;
      const totalSeg = task.seg.length;
      let hadFailure = false;

      for (let i = 0; i < totalSeg; i++) {
        const slot = task.seg[i];
        if (task.cancelRequested) { task.status = 'canceled'; task.finishedAt = Date.now(); emit(task); persist(); return; }
        if (slot.status === 'done') continue; // 继续任务：已完成段不重算

        const fp = LC.segmentFingerprint(task.snap, slot.seg);
        slot.fingerprint = fp;

        // 1) 先查内容缓存（CRC 帧）：缺块/校验失败只重算这一段
        let cached = null;
        try {
          if (deps.getSegment) {
            const bytes = await deps.getSegment(fp);
            if (bytes) {
              const dec = LC.decodeSegmentRecord(bytes);
              if (dec.ok) cached = dec.rec;
              else slot.cacheError = dec.reason;
            }
          }
        } catch (e) { slot.cacheError = String(e && e.message || e); }

        try {
          if (cached) {
            slot.status = 'done';
            slot.result = LC.hydrateSegment(cached);
            slot.fromCache = true;
          } else {
            // 暂停点在段边界（暂停时不杀当前渲染，渲染本身按块让出）
            while (task.pauseRequested && !task.cancelRequested) {
              task.status = 'paused'; emit(task); persist();
              await wait(deps.pausePollMs || 80);
            }
            if (task.cancelRequested) { task.status = 'canceled'; task.finishedAt = Date.now(); emit(task); persist(); return; }
            task.status = runningStatus(task);

            const r = await LC.analyzeSegment(task.snap, slot.seg, depsDeps(deps, task), {
              channels,
              chunkSec: deps.chunkSec || 0.5,
              shouldCancel: () => task.cancelRequested,
              isPaused: () => task.pauseRequested,
              pausePollMs: deps.pausePollMs || 80,
              onProgress: p => {
                slot.progress = p;
                updateProgress(task);
                emit(task);
              },
              onStatus: st => {
                if (st === 'paused' && !task.cancelRequested) { task.status = 'paused'; emit(task); }
                else if (st === 'running' && task.status === 'paused') {
                  task.status = runningStatus(task); emit(task);
                }
              },
            });
            if (r.status === 'canceled') { task.status = 'canceled'; task.finishedAt = Date.now(); emit(task); persist(); return; }
            const stash = LC.stashSegment(r);
            slot.status = 'done';
            slot.result = LC.hydrateSegment(stash);
            slot.progress = 1;
            // 写缓存（失败不影响结果：下次重算）
            if (deps.putSegment) {
              try { await deps.putSegment(fp, LC.encodeSegmentRecord(stash)); }
              catch (e) { slot.cacheError = String(e && e.message || e); }
            }
          }
        } catch (err) {
          hadFailure = true;
          slot.status = 'failed';
          slot.error = friendlyError(err);
          slot.result = null;
          emit(task);
        }
        updateProgress(task);
        assemble(task);
        emit(task); persist();
      }

      const failedN = task.seg.filter(s => s.status === 'failed').length;
      task.finishedAt = Date.now();
      if (failedN === totalSeg) { task.status = 'failed'; task.error = '所有区段计算失败'; }
      else if (failedN > 0) { task.status = 'partial'; task.statusNote = `${failedN} 个区段失败，其余可用`; }
      else { task.status = 'done'; }
      assemble(task);
      emit(task); persist();
    }

    function runningStatus(task) {
      return task.seg.some(s => s.status === 'done') ? 'partial' : 'running';
    }
    function updateProgress(task) {
      let done = 0, work = 0;
      for (const s of task.seg) {
        done += s.status === 'done' ? 1 : (s.progress || 0);
        work += 1;
      }
      task.progress = work ? done / work : 0;
    }
    function assemble(task) {
      const ready = task.seg.filter(s => s.status === 'done' && s.result);
      if (!ready.length) { task.metrics = null; task.evaluation = null; return; }
      const segs = ready.map(s => s.result);
      const { metrics, evaluation } = LC.metricsFromSegments(segs, task.preset, task.channels);
      task.metrics = metrics;
      task.evaluation = evaluation;
    }

    /* ---------- 提案 ---------- */

    async function makeProposals(taskId, opts) {
      const task = findTask(taskId);
      if (!task || !task.metrics) throw new Error('还没有可用的分析结果');
      if (task.status === 'stale') throw new Error('结果已过期，请重新检查');
      opts = opts || {};
      const m = task.metrics, p = task.preset;
      const defs = [
        { kind: 'uniform', plan: LC.planUniform(m, p) },
        { kind: 'envelope', plan: LC.planEnvelope(m, p, { slewDBpS: opts.slewDBpS || 12 }) },
        { kind: 'limiter', plan: LC.planLimiter(m, p) },
      ].filter(d => d.plan);
      const out = [];
      for (const d of defs) {
        const prop = {
          id: uid('pp'), taskId, kind: d.kind, params: d.plan,
          status: 'planned', result: null, stale: false, applicable: false,
          createdAt: Date.now(),
        };
        task.proposals.push(prop);
        out.push(prop);
      }
      emit(task); persist();
      return out;
    }

    async function evaluateProposal(taskId, proposalId, opts) {
      const task = findTask(taskId);
      const prop = task && task.proposals.find(p => p.id === proposalId);
      if (!prop) throw new Error('提案不存在');
      if (task.status === 'stale' || prop.stale) throw new Error('提案已过期，不能评估或应用');
      prop.status = 'evaluating'; emit(task);
      try {
        const r = await LC.evaluateProposal(task.snap, task.a, task.b, prop.params, task.preset,
          depsDeps(deps, task), Object.assign({
            channels: task.channels,
            collectWave: opts && opts.collectWave,
            chunkSec: deps.chunkSec || 0.5,
            shouldCancel: () => task.cancelRequested,
            isPaused: () => task.pauseRequested,
          }, opts || {}));
        if (r.status === 'canceled') { prop.status = 'planned'; emit(task); return r; }
        prop.result = r;
        prop.applicable = r.feasible; // 冲突提案不能「看似通过」地应用
        prop.status = 'evaluated';
        emit(task); persist();
        return r;
      } catch (e) {
        prop.status = 'error'; prop.error = friendlyError(e);
        emit(task); throw e;
      }
    }

    function setActiveProposal(taskId, proposalId) {
      const task = findTask(taskId);
      if (!task) return;
      if (proposalId) {
        const p = task.proposals.find(x => x.id === proposalId);
        if (!p || p.stale || !p.result) return;
      }
      task.activeProposalId = proposalId || null;
      emit(task); persist();
    }

    /* 接受提案：返回可直接交给历史层的批量补丁（由 UI 决定如何提交）。
       非破坏：提案参数只作用于渲染；接受时由 UI 把统一增益/包络落成一次批量编辑。 */
    function acceptProposal(taskId, proposalId) {
      const task = findTask(taskId);
      const prop = task && task.proposals.find(p => p.id === proposalId);
      if (!prop) throw new Error('提案不存在');
      if (task.status === 'stale' || prop.stale) throw new Error('提案已过期，不能应用');
      if (!prop.result) throw new Error('提案尚未完成分析');
      if (!prop.result.feasible) {
        throw new Error('该提案无法同时满足响度目标与峰值上限，不能应用');
      }
      prop.applied = true;
      task.activeProposalId = null;
      emit(task); persist();
      return { task, proposal: prop, result: prop.result };
    }

    function discardProposal(taskId, proposalId) {
      const task = findTask(taskId);
      if (!task) return;
      const i = task.proposals.findIndex(p => p.id === proposalId);
      if (i >= 0) task.proposals.splice(i, 1);
      if (task.activeProposalId === proposalId) task.activeProposalId = null;
      emit(task); persist();
    }

    /* ---------- 序列化（崩溃恢复） ---------- */

    function serialize() {
      // 不保存 snap 中的 AudioBuffer（由 UI 重新物化）；只保存任务簿记与已完成段结果
      return JSON.stringify({
        v: 1,
        tasks: tasks.map(t => ({
          id: t.id, key: t.key, a: t.a, b: t.b, rangeLabel: t.rangeLabel,
          presetId: t.preset.id,
          status: ['running', 'waiting'].includes(t.status) ? 'paused' : t.status,
          channels: t.channels, progress: t.progress, error: t.error,
          cancelRequested: false, pauseRequested: t.status === 'paused',
          createdAt: t.createdAt, finishedAt: t.finishedAt,
          staleReason: t.staleReason,
          seg: t.seg.map(s => ({
            fingerprint: s.fingerprint, status: s.status === 'failed' ? 'failed' : (s.result ? 'done' : 'waiting'),
            stash: s.result ? LC.stashSegment({
              segT: s.result.segT, coreFrames: s.result.coreFrames,
              channels: s.result.channels, e100: [...s.result.e100.entries()].map(([k, v]) => [k, v.sum, v.cnt]),
              tpMax: s.result.tpMax,
            }) : null,
            error: s.error, fromCache: !!s.fromCache,
          })),
          proposals: t.proposals.map(p => ({
            id: p.id, kind: p.kind, params: p.params, status: p.applied ? 'applied' : 'planned',
            applicable: !!p.applicable && !p.stale, stale: !!p.stale, applied: !!p.applied,
          })),
          activeProposalId: null,
        })),
      });
    }

    function restore(json, snapsByKey) {
      let data;
      try { data = JSON.parse(json); } catch (e) { return { restored: 0, problems: ['响度任务记录无法解析：' + e.message] }; }
      const problems = [];
      let restored = 0;
      for (const rt of data.tasks || []) {
        const snap = snapsByKey ? snapsByKey(rt) : null;
        const preset = LC.PRESETS[rt.presetId];
        if (!preset) { problems.push('任务 ' + rt.id + ' 的规范已不存在，跳过'); continue; }
        const plan = LC.planSegments(rt.a, rt.b, { segmentSec: deps.segmentSec || 5 });
        const task = {
          id: rt.id, key: rt.key, snap, a: rt.a, b: rt.b, preset, rangeLabel: rt.rangeLabel,
          plan, status: snap ? rt.status : 'failed', channels: rt.channels,
          seg: plan.map((seg, i) => {
            const rs = rt.seg[i] || {};
            let result = null;
            if (rs.stash) { try { result = LC.hydrateSegment(rs.stash); } catch (e) { problems.push('区段缓存恢复失败，将重算: ' + e.message); } }
            return { seg, fingerprint: rs.fingerprint, status: result ? 'done' : 'waiting', result, error: rs.error };
          }),
          progress: rt.progress || 0, error: rt.error || '', createdAt: rt.createdAt,
          finishedAt: rt.finishedAt, cancelRequested: false,
          pauseRequested: rt.status === 'paused', staleReason: rt.staleReason,
          evaluation: null, metrics: null, proposals: [], activeProposalId: null,
        };
        if (!snap) task.error = '快照无法重新物化（素材已变化），请重新检查';
        const doneN = task.seg.filter(s => s.status === 'done').length;
        if (snap && doneN) assemble(task);
        task.proposals = (rt.proposals || []).map(p => ({
          ...p, result: null, // 提案的渲染结果不持久化（含波形），恢复后需重新评估；参数保留
          status: p.applied ? 'applied' : 'planned',
        }));
        tasks.push(task);
        restored++;
        emit(task);
        // 暂停态保留（刷新前在暂停）；未完成且有快照的任务进入等待，自动续算（只补缺失段）。
        // 全部段已完成的任务保持 done（assemble 已给出指标，不必再跑）。
        if (snap && task.status !== 'done' && task.status !== 'stale' &&
            task.status !== 'failed' && task.status !== 'canceled') {
          if (rt.status === 'paused') {
            task.status = doneN === task.seg.length ? 'done' : (doneN ? 'partial' : 'paused');
            task.pauseRequested = true;
          } else {
            task.status = doneN && doneN < task.seg.length ? 'partial' : 'waiting';
          }
        }
      }
      persist();
      pump();
      return { restored, problems };
    }

    return {
      submit, cancel, pause, resume, pump,
      makeProposals, evaluateProposal, setActiveProposal, acceptProposal, discardProposal,
      markStaleAfterEdit, markStale, removeTask,
      serialize, restore, onUpdate,
      tasks, findTask, snapshotKey,
      getStatusText: s => STATUS_TEXT[s] || s,
    };
  }

  function LC_chan(snap) {
    if (snap.channels) return snap.channels;
    let ch = 1;
    for (const c of snap.clips || []) {
      let n = 1;
      try { n = c.buffer.numberOfChannels; } catch (_) { n = 1; }
      if (n >= 2) { ch = 2; break; }
    }
    return ch;
  }
  function depsDeps(deps, task) {
    return {
      renderMix: deps.renderMix,
      yieldControl: deps.yieldControl || (() => Promise.resolve()),
    };
  }
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function friendlyError(err) {
    const msg = String((err && err.message) || err);
    return /memory|allocation|array buffer/i.test(msg) ? '浏览器资源不足，该区段计算失败' : '计算失败：' + msg;
  }

  return {
    createTaskManager, snapshotKey, STATUS_TEXT,
  };
});
