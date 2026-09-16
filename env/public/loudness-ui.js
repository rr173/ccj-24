'use strict';

/* ================= 响度检查的浏览器 UI 控制器 =================
   把 loudness-app 任务管理器接到时间尺覆盖层、侧栏面板与试听：
   - 覆盖层：超限区段（红=过响、蓝=过轻、紫=真峰值），点击从该区段试听
   - 任务卡片：状态（等待/正在计算/已暂停/部分可用/已完成/失败/已取消/已过期）、
     综合响度/LRA/真峰值、暂停/继续/取消、提案列表
   - 提案：统一增益 / 分段包络 / 真峰值限制；原声↔修正即时切换试听；接受=一次批量编辑；放弃不改动
   - 编辑后任务/提案标记过期（由 app.js 在每次提交后调用 markStaleAfterEdit）
   依赖注入 app 上下文（快照、渲染、存储、提交历史、播放/定位），便于测试桩复用。 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.createLoudnessUI = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const LC = typeof require !== 'undefined' ? require('./loudness-core.js') : globalThis;
  const LA = typeof require !== 'undefined' ? require('./loudness-app.js') : globalThis;

  function createLoudnessUI(ctx) {
    const {
      $, snapshot, getRange, playFrom, commitBatch, store, renderMix,
      timelineWidth, timelineHeight, redrawOverlays, projectEnd,
    } = ctx;

    const SEG_SEC = 5;
    let manager = null;
    let currentTask = null;          // 当前在覆盖层/面板展示的任务
    let previewProposal = null;      // 试听中的提案
    let previewGainNode = null;      // 试听用增益/包络节点（非破坏）

    /* ---------- 管理器（注入浏览器混音与 CRC 缓存） ---------- */

    function initManager() {
      manager = LA.createTaskManager({
        renderMix,
        yieldControl: () => new Promise(r => setTimeout(r, 0)),
        getSegment: fp => store.getLoudSegment(fp),
        putSegment: (fp, bytes) => store.putLoudSegment(fp, bytes),
        segmentSec: SEG_SEC, chunkSec: 0.5, pausePollMs: 80,
        persist: () => persistTasks(),
        onUpdate: () => { renderTaskCard(); redrawOverlays(); },
      });
      return manager;
    }

    /* ---------- 提交检查 ---------- */

    function readRange() {
      const a = parseFloat($('#lfStart').value);
      const b = parseFloat($('#lfEnd').value);
      const end = projectEnd();
      return {
        a: isFinite(a) && a >= 0 ? a : 0,
        b: isFinite(b) && b > 0 ? b : end,
      };
    }

    function startCheck() {
      if (!projectEnd() || projectEnd() <= 0) { ctx.toast('时间线上还没有片段', 'err'); return; }
      const { a, b } = readRange();
      if (!(b > a)) { ctx.toast('检查区间无效', 'err'); return; }
      const preset = LC.PRESETS[$('#lfPreset').value];
      const snap = snapshot(a, b);
      if (!snap.clips.length) { ctx.toast('所选区间内没有可用片段（素材可能缺失）', 'err'); return; }
      const r = manager.submit({ snap, a, b, preset, rangeLabel: `${fmt(a)}–${fmt(b)}` });
      currentTask = r.task;
      renderTaskCard(); redrawOverlays();
      if (r.duplicated) ctx.toast('相同内容+规范的检查已存在（已复用，未重复计算）');
    }

    /* ---------- 覆盖层：超限区段 ---------- */

    function drawOverlays(g, width) {
      if (!currentTask || !currentTask.evaluation) return null;
      const task = currentTask;
      const zones = task.evaluation.zones || [];
      const xFor = t => (t - task.a) / (task.b - task.a) * width;
      const drawn = [];
      for (const z of zones) {
        const x = xFor(z.a), w = Math.max(3, xFor(z.b) - x);
        const color = z.kind === 'loud' ? 'rgba(255,95,95,.28)'
          : z.kind === 'quiet' ? 'rgba(80,160,255,.22)'
            : 'rgba(210,120,255,.30)';
        const edge = z.kind === 'loud' ? '#ff5f5f' : z.kind === 'quiet' ? '#5aa0ff' : '#c778ff';
        g.fillStyle = color; g.fillRect(x, 0, w, timelineHeight());
        g.strokeStyle = edge; g.lineWidth = 1;
        g.strokeRect(x + 0.5, 0.5, w - 1, timelineHeight() - 1);
        drawn.push({ x, w, zone: z });
      }
      return drawn;
    }

    function hitTest(pxClientX, width) {
      if (!currentTask || !currentTask.evaluation) return null;
      const zones = currentTask.evaluation.zones || [];
      const xFor = t => (t - currentTask.a) / (currentTask.b - currentTask.a) * width;
      let best = null;
      for (const z of zones) {
        const x = xFor(z.a), w = Math.max(3, xFor(z.b) - x);
        if (pxClientX >= x && pxClientX <= x + w) {
          if (!best || (z.b - z.a) < (best.zone.b - best.zone.a)) best = { x, w, zone: z };
        }
      }
      return best;
    }

    function onOverlayClick(pxClientX, width) {
      const hit = hitTest(pxClientX, width);
      if (!hit) return false;
      const t = Math.max(0, hit.zone.a);
      ctx.toast(`${zoneKindText(hit.zone.kind)}：${hit.zone.detail} · 从 ${fmt(t)} 试听`, 'warn');
      playFrom(t);
      return true;
    }

    function zoneKindText(k) {
      return k === 'loud' ? '过响区段' : k === 'quiet' ? '过轻区段' : '真峰值超限';
    }

    /* ---------- 任务卡片 ---------- */

    const cardState = { el: null };

    function ensureCard() {
      if (cardState.el) return cardState.el;
      const el = document.createElement('div');
      el.className = 'ltask';
      const headEl = document.createElement('div'); headEl.className = 'lt-body';
      const actions = document.createElement('div'); actions.className = 'lt-actions';
      const propWrap = document.createElement('div'); propWrap.className = 'lt-props';
      el.appendChild(headEl); el.appendChild(actions); el.appendChild(propWrap);
      el._body = headEl; el._actions = actions; el._props = propWrap;
      $('#lfTasks').appendChild(el);
      cardState.el = el;
      return el;
    }

    function renderTaskCard() {
      if (!currentTask) return;
      const task = currentTask;
      const el = ensureCard();
      el.className = 'ltask lt-' + task.status;
      const statusText = LA.STATUS_TEXT[task.status] || task.status;
      const m = task.metrics;
      const pass = task.evaluation && task.evaluation.pass;
      let html = `<div class="lt-head">
        <span class="lt-title">${task.preset.name} · ${task.rangeLabel || fmt(task.a) + '–' + fmt(task.b)}</span>
        <span class="lt-state lt-st-${task.status}">${statusText}</span>
      </div>`;
      html += `<div class="lt-bar"><div class="lt-fill" style="width:${Math.round(task.progress * 100)}%"></div></div>`;
      if (m) {
        const ev = task.evaluation;
        const fmtV = (v, u) => v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(1) + u;
        html += `<div class="lt-metrics">
          <span>综合 <b class="${ev && !ev.integPass ? 'bad' : 'good'}">${fmtV(m.integrated, '')}</b>/${task.preset.target}</span>
          <span>LRA <b>${m.lra === null ? '—' : m.lra.toFixed(1)}</b></span>
          <span>真峰 <b class="${ev && !ev.tpPass ? 'bad' : 'good'}">${fmtV(m.truePeak, '')}</b>/${task.preset.maxTP}</span>
        </div>`;
        if (task.status === 'done' || task.status === 'partial') {
          html += `<div class="lt-verdict ${pass ? 'ok' : 'no'}">${pass ? '✓ 符合规范' : '✗ 不符合规范（' + ev.zones.length + ' 处超限，时间尺上已标出）'}</div>`;
        }
      }
      if (task.statusNote) html += `<div class="lt-note">${task.statusNote}</div>`;
      const failedSegs = task.seg.filter(s => s.status === 'failed');
      if (failedSegs.length) html += `<div class="lt-err">${failedSegs.length} 个区段失败，其余结果可用（可重试失败段）</div>`;
      if (task.staleReason) html += `<div class="lt-stale">已过期：${task.staleReason}，请重新检查</div>`;
      if (task.error) html += `<div class="lt-err">${task.error}</div>`;

      // 稳定的三段容器：头部信息 / 操作按钮 / 提案列表（引用直接持有，不依赖 querySelector）
      const headEl = el._body, actions = el._actions, propWrap = el._props;
      headEl.innerHTML = html;
      actions.innerHTML = '';
      const addBtn = (text, fn, cls) => {
        const b = document.createElement('button');
        b.textContent = text; if (cls) b.className = cls;
        b.addEventListener('click', fn); actions.appendChild(b); return b;
      };
      if (['waiting', 'running', 'partial'].includes(task.status)) {
        addBtn(task.pauseRequested ? '继续' : '暂停', () => {
          if (task.pauseRequested) manager.resume(task.id); else manager.pause(task.id);
        });
        addBtn('取消', () => manager.cancel(task.id));
      }
      if ((task.status === 'done' || task.status === 'partial') && m) {
        addBtn('生成修正提案', () => makeProposals(task));
      }
      if (task.status === 'failed' || task.status === 'canceled') {
        addBtn('重新检查', () => { currentTask = manager.submit({
          snap: task.snap, a: task.a, b: task.b, preset: task.preset, rangeLabel: task.rangeLabel }).task; });
      }
      if (task.status === 'partial' && failedSegs.length) {
        addBtn('重试失败段', () => manager.resume(task.id));
      }

      // 提案列表：每个提案节点复用（_el），删除已不存在的
      const have = new Set(task.proposals.map(p => p._el));
      for (const child of [...propWrap.children]) if (!have.has(child)) propWrap.removeChild(child);
      for (const prop of task.proposals) {
        if (!prop._el) { const box = document.createElement('div'); box.className = 'lprop'; prop._el = box; propWrap.appendChild(box); }
        renderProposal(el, task, prop);
      }
    }

    /* ---------- 提案 ---------- */

    async function makeProposals(task) {
      try {
        await manager.makeProposals(task.id);
        const props = task.proposals.filter(p => p.status === 'planned' && !p.result && !p.stale);
        for (const p of props) {
          // 自动评估三个提案（后台渲染；可取消由任务取消联动）
          manager.evaluateProposal(task.id, p.id, { collectWave: 600 }).catch(e => ctx.toast(e.message, 'err'));
        }
        renderTaskCard();
      } catch (e) { ctx.toast(e.message, 'err'); }
    }

    function renderProposal(el, task, prop) {
      const box = prop._el;
      const kindName = { uniform: '统一增益', envelope: '分段包络', limiter: '真峰值限制' }[prop.kind];
      let param = '';
      if (prop.kind === 'uniform') param = `${prop.params.gainDB >= 0 ? '+' : ''}${prop.params.gainDB.toFixed(2)} dB`;
      if (prop.kind === 'limiter') param = `前置 ${prop.params.preGainDB.toFixed(2)} dB · 上限 ${prop.params.ceilingDBTP} dBTP`;
      if (prop.kind === 'envelope') param = `${prop.params.nodes.length} 个关键点`;
      const stText = { planned: '待评估', evaluating: '评估中…', evaluated: '', error: '评估失败', applied: '已应用' }[prop.status] || '';
      box.className = 'lprop' + (prop.stale ? ' stale' : '') + (prop.applied ? ' applied' : '');
      let html = `<div class="lp-head"><b>${kindName}</b> <span class="lp-param">${param}</span>
        <span class="lp-state">${stText}</span></div>`;

      const r = prop.result;
      if (r && r.status === 'done') {
        html += r.feasible
          ? `<div class="lp-verdict ok">修正后 综合 ${r.metrics.integrated.toFixed(1)} · 真峰 ${r.metrics.truePeak.toFixed(1)} dBTP ✓</div>`
          : `<div class="lp-verdict no">无法同时满足：${r.conflicts.map(conflictText).join('；')}</div>`;
      }
      if (prop.error) html += `<div class="lp-verdict no">${prop.error}</div>`;
      box.innerHTML = html;
      if (r && r.status === 'done' && r.wave) box.appendChild(renderMiniWave(r.wave, r.feasible));

      // 操作区独立于 innerHTML，重绘时复用/清空，避免重复按钮
      let acts = prop._actions;
      if (!acts) { acts = document.createElement('div'); acts.className = 'lp-actions'; prop._actions = acts; box.appendChild(acts); }
      acts.innerHTML = '';
      const addBtn = (text, fn, disabled) => {
        const b = document.createElement('button'); b.textContent = text;
        if (disabled) b.disabled = true;
        b.addEventListener('click', fn); acts.appendChild(b);
      };
      if (r && r.status === 'done') {
        const active = task.activeProposalId === prop.id;
        addBtn(active ? '停止试听（回到原声）' : '试听修正声', () => togglePreview(task, prop));
        // 三类提案都已等价为框内增益曲线：评估可行即可一次批量编辑落地（含真峰值限制）
        const canApply = r.feasible && !prop.stale && Array.isArray(r.gainNodes);
        addBtn('接受（一次批量编辑，只作用于框内）',
          () => acceptProposal(task, prop), !canApply);
        addBtn('放弃', () => { manager.discardProposal(task.id, prop.id); renderTaskCard(); stopPreview(); });
      } else if (prop.status === 'evaluating') {
        const b = document.createElement('span'); b.className = 'lp-state'; b.textContent = '评估中…'; acts.appendChild(b);
      } else if (prop.status !== 'applied' && !prop.stale) {
        // 恢复后参数保留、渲染结果不持久化 ⇒ 提供「重新评估」
        addBtn('重新评估', () => {
          manager.evaluateProposal(task.id, prop.id, { collectWave: 600 })
            .then(() => renderTaskCard())
            .catch(e => ctx.toast(e.message, 'err'));
        });
        addBtn('放弃', () => { manager.discardProposal(task.id, prop.id); renderTaskCard(); });
      }
    }

    function conflictText(c) {
      if (c.kind === 'peak') return `真峰值仍超 ${c.over.toFixed(2)} dB（限制器也无法在不削波下满足，请放宽峰值上限或降低响度目标）`;
      if (c.kind === 'integrated') return `综合响度偏差 ${(c.gap || 0).toFixed(2)} LU`;
      return c.kind;
    }

    /* ---------- 修正后波形小图 ---------- */

    function renderMiniWave(wave, feasible) {
      const cv = document.createElement('canvas');
      cv.width = wave.npx; cv.height = 36;
      cv.className = 'lp-wave';
      const g = cv.getContext('2d');
      g.strokeStyle = feasible ? '#4fc77f' : '#ff8f5f';
      g.beginPath();
      const mid = 18;
      for (let i = 0; i < wave.npx; i++) {
        const up = mid - wave.max[i] * 14, dn = mid - wave.min[i] * 14;
        g.moveTo(i + 0.5, up); g.lineTo(i + 0.5, dn);
      }
      g.stroke();
      return cv;
    }

    /* ---------- 原声↔修正声即时切换试听 ----------
       非破坏：不改片段参数，只在播放主链上插入一个 GainNode；
       分段包络/限制器试听同样通过实时处理节点（与离线评估同参数）。 */

    function togglePreview(task, prop) {
      if (task.activeProposalId === prop.id) { stopPreview(); return; }
      if (!prop.result || !Array.isArray(prop.result.gainNodes)) {
        ctx.toast('提案尚未完成评估，无法试听', 'err');
        return;
      }
      stopPreview();
      previewProposal = prop;
      // 试听曲线与离线评估/落地同一份节点：框内分段线性、框外恒 1，逐片段叠加（非破坏）
      ctx.attachPreviewProcessor(prop.kind, prop.params, task.a, task.b, prop.result.gainNodes);
      manager.setActiveProposal(task.id, prop.id);
      renderTaskCard();
    }
    function stopPreview() {
      if (previewProposal) {
        ctx.detachPreviewProcessor && ctx.detachPreviewProcessor();
        if (currentTask) manager.setActiveProposal(currentTask.id, null);
        previewProposal = null;
        renderTaskCard();
      }
    }

    /* ---------- 接受提案：一次批量编辑 ---------- */

    function acceptProposal(task, prop) {
      let accepted;
      try { accepted = manager.acceptProposal(task.id, prop.id); }
      catch (e) { ctx.toast(e.message, 'err'); return; }
      // 提案已等价为框内增益曲线：落成一次提交的批量 autoGain 补丁（播放/导出/分析同口径）
      const patch = ctx.buildProposalPatch(task, prop.params, prop.kind, accepted.result);
      if (!patch || !patch.length) { ctx.toast('该提案没有可应用的参数变化'); return; }
      commitBatch(patch, proposalLabel(prop.kind));
      stopPreview();
      ctx.toast(`已应用「${kindLabel(prop.kind)}」修正（只作用于框选区间，一次批量编辑，可撤销）`);
      // 接受后任务过期（混音已改变）
      manager.markStaleAfterEdit('已应用响度修正提案');
      renderTaskCard(); redrawOverlays();
    }

    function proposalLabel(k) {
      return { uniform: '响度修正：统一增益', envelope: '响度修正：分段包络', limiter: '响度修正：峰值限制' }[k] || '响度修正';
    }
    function kindLabel(k) { return { uniform: '统一增益', envelope: '分段包络', limiter: '真峰值限制' }[k]; }

    /* ---------- 持久化 / 恢复 ---------- */

    function persistKey() { return 'audio-timeline:loudtasks'; }
    function persistTasks() {
      try { localStorage.setItem(persistKey(), manager.serialize()); }
      catch (_) { /* 配额/隐私：只影响崩溃恢复 */ }
    }
    async function restoreTasks(snapshotResolver) {
      let raw = null;
      try { raw = localStorage.getItem(persistKey()); } catch (_) {}
      if (!raw) return;
      const rec = manager.restore(raw, rt => {
        try { return snapshotResolver(rt.a, rt.b); } catch (e) { return null; }
      });
      if (rec.restored) currentTask = manager.tasks[0] || null;
      if (rec.problems && rec.problems.length) ctx.toast('响度任务恢复：' + rec.problems[0], 'warn');
      renderTaskCard(); redrawOverlays();
    }

    /* ---------- 编辑后失效 ---------- */

    function onProjectEdited() {
      if (manager) manager.markStaleAfterEdit('工程已编辑');
      stopPreview();
      renderTaskCard(); redrawOverlays();
    }
    function onHistoryMove() {
      // 撤销/重做/切换分支：当前文档可能是任意历史状态，任务一律过期
      if (manager) manager.markStale(() => true, '历史位置已变化');
      stopPreview();
      renderTaskCard(); redrawOverlays();
    }

    function fmt(t) { return (t < 0 ? '+' : '') + t.toFixed(2) + 's'; }
    function selectTask(t) { currentTask = t; renderTaskCard(); redrawOverlays(); }
    function getManager() { return manager; }
    function getCurrentTask() { return currentTask; }

    return {
      initManager, startCheck, drawOverlays, onOverlayClick,
      renderTaskCard, onProjectEdited, onHistoryMove, restoreTasks,
      stopPreview, getManager, selectTask, getCurrentTask,
    };
  }

  return createLoudnessUI;
});
