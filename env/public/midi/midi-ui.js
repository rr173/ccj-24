'use strict';
/* midi-ui.js — DOM 渲染层
 * 只负责画与转发；状态/规则全在 Engine。 */
(function (global) {
  const MConsole = global.MConsole;
  const { clamp, fmtTime, shortHash, now } = MConsole.util;

  const CURVES = [['linear', '线性'], ['exp', '指数'], ['log', '对数'], ['scurve', 'S 曲线']];
  const WRITE_LABELS = { overwrite: '覆盖', latch: '锁存', touch: '触碰' };

  function UI(deps) {
    this.store = deps.store;
    this.hub = deps.hub;
    this.clock = deps.clock;
    this.engine = deps.engine;
    this.timeline = deps.timeline;
    this.$ = id => document.getElementById(id);
    this._virtualTwin = 0;
    this._takeStripCanvases = new Map();
    this._bindStatic();
  }

  UI.prototype._bindStatic = function () {
    // 静态按钮的点击由 main.js 通过 hooks 注入，保持 UI 可被测试
    this.hooks = {};
  };
  UI.prototype.on = function (name, fn) { this.hooks[name] = fn; };
  UI.prototype.fire = function (name, arg) { if (this.hooks[name]) return this.hooks[name](arg); };

  UI.prototype.toast = function (msg, ms) {
    const t = this.$('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2200);
  };

  // ---------------- 顶部状态 ----------------
  UI.prototype.setMidiPerm = function (state, text) {
    const el = this.$('midiPerm');
    el.className = 'pill pill-' + (state === 'ok' ? 'ok' : state === 'err' ? 'err' : 'warn');
    el.textContent = text;
  };
  UI.prototype.setPairing = function (on, controlId) {
    this.$('btnPair').classList.toggle('active', on);
    this.$('btnPair').textContent = '◎ 配对模式：' + (on ? '开' : '关');
    this.$('pairHint').hidden = !on;
    if (on && controlId) {
      const c = this.store.state.controls.find(x => x.id === controlId);
      this.$('pairHint').textContent = '配对中：已选「' + (c ? c.name : controlId) + '」，请转动硬件';
    }
    this.renderRack();
  };

  UI.prototype.setProjectFp = function () {
    this.$('projectFp').textContent = this.store.state.projectFp;
  };

  // ---------------- 端口 ----------------
  UI.prototype.renderPorts = function () {
    const list = this.$('portList');
    const ports = this.hub.listPorts();
    if (!ports.length) {
      list.innerHTML = '<div class="muted small">尚无 MIDI 输入。下方虚拟设备可在无硬件时体验全部流程。</div>';
    } else {
      list.innerHTML = '';
      ports.forEach(p => {        const row = document.createElement('div');
        row.className = 'port-row' + (p.online ? '' : ' offline');
        const health = p.online ? (p.identityMismatch ? '⚠ 身份不符' : '在线') : '离线（缺席保留）';
        row.innerHTML =
          '<i class="dot ' + (p.online && !p.identityMismatch ? 'online' : 'offline') + '"></i>' +
          '<div style="flex:1;min-width:0"><div class="port-name">' + escapeHtml(p.name) +
          (p.virtual ? ' <span class="small muted">[虚拟]</span>' : '') +
          (p.identityMismatch ? ' <span style="color:#f0a0a0">身份漂移，拒绝重认</span>' : '') +
          '</div><div class="port-fp mono">#' + p.fp + ' · ' + escapeHtml(p.manufacturer || '—') + ' · ' + health + '</div></div>' +
          '<span class="rx mono">' + p.msgCount + '</span>';
        if (p.virtual) {
          const btn = document.createElement('button');
          btn.className = 'unplug';
          btn.textContent = p.online ? '拔出' : '插回';
          btn.onclick = () => this.fire('toggleVirtual', p.id);
          row.appendChild(btn);
        }
        list.appendChild(row);
      });
      // 虚拟推子面板（独立于行，重建避免丢失）
      this.renderVirtualPanels();
    }
    this.$('portClock').textContent = fmtTime(this.clock.pos) + (this.clock.playing ? ' ▶' : '');
    this.$('schedLag').textContent = Math.round(this.clock.lastFrameLagMs) + ' ms';
    this.renderBindings();
  };

  UI.prototype.renderVirtualPanels = function () {
    const list = this.$('portList');
    // 清空旧面板（端口行不带 data-vpanel，不受影响）
    list.querySelectorAll('[data-vpanel]').forEach(n => n.remove());
    this.hub.listPorts().filter(p => p.virtual && p.online).forEach(p => {
      const wrap = document.createElement('div');
      wrap.setAttribute('data-vpanel', p.id);
      wrap.className = 'vpanel';
      for (let cc = 0; cc < 8; cc++) {
        const f = document.createElement('label');
        f.className = 'vfader';
        f.innerHTML = '<input type="range" min="0" max="127" value="0" orient="vertical"><span>CC' + (16 + cc) + '</span>';
        const input = f.querySelector('input');
        input.addEventListener('input', () => this.fire('virtualCC', { portId: p.id, ch: 0, cc: 16 + cc, value: +input.value }));
        wrap.appendChild(f);
      }
      list.appendChild(wrap);
    });
  };

  // ---------------- 绑定表 ----------------
  UI.prototype.renderBindings = function () {
    const el = this.$('bindingList');
    const bs = this.store.state.bindings;
    this.$('bindCount').textContent = bs.length ? '(' + bs.length + ')' : '';
    if (!bs.length) {
      el.innerHTML = '<div class="muted small">还没有绑定。开启配对模式后触碰控件再动硬件即可建立。</div>';
      return;
    }
    el.innerHTML = '';
    const disputed = this.engine.disputedBindings();
    bs.forEach(b => {
      const h = this.engine.bindingHealth(b);
      const ctrl = this.store.state.controls.find(c => c.id === b.controlId);
      const row = document.createElement('div');
      row.className = 'bind-row' + (h.state !== 'online' ? ' offline' : '') + (disputed.has(b.id) ? ' disputed' : '');
      row.innerHTML =
        '<div class="bind-head">' +
          '<button class="bind-arm' + (b.armed ? ' armed' : '') + '" data-act="arm">' + (b.armed ? 'R ●' : 'R') + '</button>' +
          '<span class="bind-target">' + escapeHtml(ctrl ? ctrl.name : b.controlId) + '</span>' +
          '<span class="bind-key mono">' + escapeHtml(b.port.name) + ' #' + (b.port.fp || '?') + ' CH' + (b.ch + 1) + ' CC' + b.cc + '</span>' +
          '<button class="bind-del" data-act="del">✕</button>' +
        '</div>' +
        '<div class="bind-grid">' +
          '<label>原始 <input type="number" min="0" max="127" data-f="inMin" value="' + b.inMin + '">–<input type="number" min="0" max="127" data-f="inMax" value="' + b.inMax + '"></label>' +
          '<label>输出 <input type="number" step="0.01" data-f="outMin" value="' + b.outMin + '">–<input type="number" step="0.01" data-f="outMax" value="' + b.outMax + '"></label>' +
          '<label><input type="checkbox" data-f="invert"' + (b.invert ? ' checked' : '') + '>反相</label>' +
          '<label>曲线 <select data-f="curve">' + CURVES.map(c => '<option value="' + c[0] + '"' + (b.curve === c[0] ? ' selected' : '') + '>' + c[1] + '</option>').join('') + '</select></label>' +
          '<label>平滑 <input type="range" min="0" max="95" data-f="smooth" value="' + Math.round((b.smooth || 0) * 100) + '"></label>' +
          '<label><input type="checkbox" data-f="clip"' + (b.clip ? ' checked' : '') + '>越界裁切</label>' +
        '</div>' +
        '<div class="bind-foot"><div class="meter"><i data-m></i><b data-mv></b></div>' +
        '<span class="small ' + (h.state === 'online' ? '' : 'muted') + '">' + h.label + (h.lagMs !== undefined ? ' · ' + Math.round(h.lagMs) + 'ms' : '') + '</span></div>' +
        ((b.sharedWith || []).length > 1 ? '<div class="small" style="color:#c8a8ff">共享：' + b.sharedWith.map(id => {
          const c = this.store.state.controls.find(x => x.id === id);
          return c ? c.name : id;
        }).join('、') + '</div>' : '');

      row.querySelector('[data-act="arm"]').onclick = () => this.fire('toggleArm', b.id);
      row.querySelector('[data-act="del"]').onclick = () => this.fire('deleteBinding', b.id);
      row.querySelectorAll('[data-f]').forEach(inp => {
        const commit = () => {
          const f = inp.getAttribute('data-f');
          let v;
          if (inp.type === 'checkbox') v = inp.checked;
          else if (inp.tagName === 'SELECT') v = inp.value;
          else if (f === 'smooth') v = clamp(+inp.value, 0, 95) / 100;
          else v = parseFloat(inp.value);
          this.fire('updateBinding', { id: b.id, patch: { [f]: v } });
        };
        inp.addEventListener('change', commit);
        if (inp.type === 'range') inp.addEventListener('input', () => {
          // 平滑实时生效但只在 change 落盘
          this.fire('liveBindingPatch', { id: b.id, patch: { smooth: clamp(+inp.value, 0, 95) / 100 }, save: false });
        });
      });
      el.appendChild(row);
    });
  };

  UI.prototype.updateMeter = function (bindingId, value, raw) {
    const el = this.$('bindingList');
    const rows = el.querySelectorAll('.bind-row');
    const idx = this.store.state.bindings.findIndex(b => b.id === bindingId);
    const row = rows[idx];
    if (!row) return;
    const bar = row.querySelector('[data-m]'), txt = row.querySelector('[data-mv]');
    if (bar) bar.style.width = (clamp(value, 0, 1) * 100).toFixed(1) + '%';
    if (txt) txt.textContent = (raw !== undefined ? raw + ' → ' : '') + value.toFixed(2);
  };

  // ---------------- 软件控件 ----------------
  UI.prototype.renderRack = function () {
    const rack = this.$('rack');
    rack.innerHTML = '';
    this.store.state.controls.forEach(c => {
      const div = document.createElement('div');
      div.setAttribute('data-ctrl', c.id);
      const bound = this.store.state.bindings.some(b => b.controlId === c.id);
      const armed = this.store.state.bindings.some(b => b.controlId === c.id && b.armed);
      const learn = this.engine.isLearning(c.id);
      div.className = 'ctrl' + (learn ? ' learn' : '') + (armed ? ' armed-badge' : '');
      const v = this.store.state.live[c.id] == null ? 0 : this.store.state.live[c.id];
      if (c.kind === 'fader') {
        div.innerHTML = '<div class="fader"><i data-handle></i></div>' +
          '<div class="ctrl-name" title="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</div>' +
          '<div class="ctrl-val mono" data-val>' + Math.round(v * 100) + '</div>' +
          '<div class="small midi-tag" style="color:#8fd0ff"' + (bound ? '' : ' hidden') + '>MIDI</div>';
        this._wireDrag(div, c, true);
      } else {
        div.innerHTML = '<div class="knob"><i data-handle></i></div>' +
          '<div class="ctrl-name" title="' + escapeHtml(c.name) + '">' + escapeHtml(c.name) + '</div>' +
          '<div class="ctrl-val mono" data-val>' + Math.round((v - 0.5) * 200) + '</div>' +
          '<div class="small midi-tag" style="color:#8fd0ff"' + (bound ? '' : ' hidden') + '>MIDI</div>';
        this._wireDrag(div, c, false);
      }
      rack.appendChild(div);
    });
    this.updateRackValues();
  };

  /** 高频值更新：只动 handle 位置与数值文本，不重建 DOM */
  UI.prototype.updateRackValues = function () {
    this.store.state.controls.forEach(c => {
      const div = this.$('rack').querySelector('[data-ctrl="' + c.id + '"]');
      if (!div) return;
      const v = clamp(this.store.state.live[c.id] == null ? 0 : this.store.state.live[c.id], 0, 1);
      const handle = div.querySelector('[data-handle]');
      const val = div.querySelector('[data-val]');
      if (c.kind === 'fader' && handle) handle.style.top = ((1 - v) * 118) + 'px';
      if (c.kind === 'knob' && handle) handle.style.transform = 'rotate(' + (-135 + v * 270) + 'deg)';
      if (val) val.textContent = c.kind === 'knob' ? Math.round((v - 0.5) * 200) : Math.round(v * 100);
    });
  };

  UI.prototype._wireDrag = function (div, c, vertical) {
    const start = (ev) => {
      if (ev.button !== 0) return;
      if (this.engine.learn) { this.fire('learnControl', c.id); return; }
      ev.preventDefault();
      this.fire('mouseTouch', c.id);
      const y0 = ev.clientY;
      const v0 = this.store.state.live[c.id];
      const move = (e) => {
        const dv = (y0 - e.clientY) / (vertical ? 130 : 120);
        this.fire('setLive', { controlId: c.id, value: clamp(v0 + dv, 0, 1) });
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    };
    div.addEventListener('pointerdown', start);
  };

  // ---------------- Take 列表 ----------------
  UI.prototype.renderTakes = function () {
    const el = this.$('takeList');
    const takes = this.store.state.takes;
    this.$('takeCount').textContent = takes.length ? '(' + takes.length + ')' : '';
    if (!takes.length) {
      el.innerHTML = '<div class="muted small">武装若干绑定 → 播放 → 采集。多个 take 可分别监听、按范围拼选。</div>';
      this.renderCompStatus();
      return;
    }
    el.innerHTML = '';
    const capturing = this.engine.capture;
    takes.forEach((t, i) => {
      const foreign = t.fp !== this.store.state.projectFp;
      const live = capturing && capturing.takeId === t.id;
      const row = document.createElement('div');
      row.className = 'take-row' + (live ? ' live' : t.state === 'partial' ? ' draft' : '') + (foreign ? ' foreign' : '');
      const dispLen = MConsole.util.unionLength(t.disputes);
      const gapLen = MConsole.util.unionLength(t.gaps);
      const selected = this.engine.compSelection.find(s => s.takeId === t.id);
      row.innerHTML =
        '<div class="take-head">' +
          '<span class="take-id">' + (live ? '● 正在采集' : 'Take ' + (takes.length - i)) + '</span>' +
          '<span class="take-meta mono">' + fmtTime(t.start) + '–' + fmtTime(t.end) +
            ' · ' + WRITE_LABELS[t.writeMode] + ' · ' + t.points.length + ' 控</span>' +
          (foreign ? '<span class="pill pill-warn">异工程·只可监听</span>' : '') +
          (t.truncated ? '<span class="pill pill-warn">被打断</span>' : '') +
        '</div>' +
        '<div class="take-strip" data-take="' + t.id + '"><canvas></canvas><div class="sel" hidden></div><div class="cursor" hidden></div></div>' +
        '<div class="take-foot">' +
          '<button data-act="mon">' + (this.engine.isMonitoring(t.id) ? '🔊 监听中' : '监听') + '</button>' +
          '<button data-act="del">删除</button>' +
          '<span>' + (dispLen > 0.01 ? '争议 ' + dispLen.toFixed(2) + 's' : '') +
          (gapLen > 0.01 ? ' · 缺口 ' + gapLen.toFixed(2) + 's' : '') +
          (t.lateDropped ? ' · 晚到丢弃×' + t.lateDropped : '') +
          (selected ? ' · 选 ' + fmtTime(selected.in) + '→' + fmtTime(selected.out) : '') + '</span>' +
        '</div>';
      el.appendChild(row);
      const canvas = row.querySelector('canvas');
      this._takeStripCanvases.set(t.id, canvas);
      this._wireStrip(row.querySelector('.take-strip'), t, foreign);
      row.querySelector('[data-act="mon"]').onclick = () => this.fire('toggleMonitor', t.id);
      row.querySelector('[data-act="del"]').onclick = () => this.fire('deleteTake', t.id);
    });
    this.renderCompStatus();
    requestAnimationFrame(() => this.drawTakeStrips());
  };

  UI.prototype._wireStrip = function (strip, take, foreign) {
    let drag = null;
    const toT = (ev) => {
      const r = strip.getBoundingClientRect();
      return take.start + clamp((ev.clientX - r.left) / r.width, 0, 1) * (take.end - take.start);
    };
    strip.addEventListener('pointerdown', (ev) => {
      if (foreign) { this.toast('工程指纹不符：该草稿只供监听，不可采纳/拼选'); return; }
      drag = { t0: toT(ev) };
    });
    strip.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      drag.t1 = toT(ev);
      this._previewStripSel(strip, drag);
    });
    const finish = (ev) => {
      if (!drag) return;
      const t1 = drag.t1 !== undefined ? drag.t1 : drag.t0;
      if (Math.abs(t1 - drag.t0) > 0.02) {
        const r = this.engine.addSelection(take.id, drag.t0, t1);
        if (!r.ok) this.toast(r.reason);
      }
      drag = null;
      strip.querySelector('.sel').hidden = true;
    };
    strip.addEventListener('pointerup', finish);
    strip.addEventListener('pointercancel', () => { drag = null; strip.querySelector('.sel').hidden = true; });
    strip.addEventListener('click', (ev) => {
      // 单击：定位播放头到 take 内
      this.clock.seek(toT(ev));
    });
  };

  UI.prototype._previewStripSel = function (strip, drag) {
    const take = this.store.state.takes.find(t => t.id === strip.getAttribute('data-take'));
    const sel = strip.querySelector('.sel');
    const span = take.end - take.start;
    const a = (Math.min(drag.t0, drag.t1) - take.start) / span * 100;
    const w = Math.abs(drag.t1 - drag.t0) / span * 100;
    sel.hidden = false;
    sel.style.left = a + '%'; sel.style.width = w + '%';
  };

  UI.prototype.drawTakeStrips = function () {
    this._takeStripCanvases.forEach((canvas, id) => {
      const take = this.store.state.takes.find(t => t.id === id);
      if (!take) return;
      const parent = canvas.parentElement;
      const w = parent ? parent.clientWidth : 0, h = parent ? parent.clientHeight : 0;
      if (w < 2 || h < 2) return; // 面板隐藏/未布局时跳过
      const dpr = global.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const X = t => (t - take.start) / (take.end - take.start) * w;
      const band = (t0, t1, color, hatch) => {
        const x = X(t0), ww = X(t1) - x;
        if (hatch) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x, 0, ww, h); ctx.clip();
          ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.globalAlpha = .7;
          for (let xx = x - 8; xx < x + ww + 8; xx += 6) {
            ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx + 7, h); ctx.stroke();
          }
          ctx.restore();
        } else {
          ctx.fillStyle = color; ctx.fillRect(x, 0, ww, h);
        }
      };
      // gap 橙
      take.gaps.forEach(g => band(Math.max(g[0], take.start), Math.min(g[1], take.end), '#c88a3a', true));
      // 争议红（分段并集）
      const disp = [];
      take.points.forEach(s => (s.disputes || []).forEach(d => disp.push(d)));
      MConsole.util.mergeRanges(disp).forEach(g => {
        if (g[1] > take.start && g[0] < take.end) band(Math.max(g[0], take.start), Math.min(g[1], take.end), '#e07070', true);
      });
      // 可采纳范围（蓝淡，按当前争议策略）
      const policy = (document.querySelector('input[name="dispute"]:checked') || {}).value || 'live';
      const sel = this.engine.compSelection.find(s => s.takeId === id);
      if (sel) {
        const ranges = this.engine.effectiveRanges(sel, policy);
        ranges.forEach(r => band(r[0], r[1], 'rgba(79,142,247,.28)', false));
      }
      // 折线（全部分段叠画）
      take.points.forEach((seg, k) => {
        ctx.strokeStyle = take.fp === this.store.state.projectFp ? ['#8fd0ff', '#7fe0a0', '#e0c87f', '#d08fe0'][k % 4] : '#6a7080';
        ctx.beginPath();
        seg.pts.forEach((p, j) => {
          const x = X(p.t), y = h - 3 - clamp(p.v, 0, 1) * (h - 6);
          if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
      // 播放头
      if (this.clock.pos >= take.start && this.clock.pos <= take.end) {
        const cur = strip.querySelector('.cursor');
        cur.hidden = false;
        cur.style.left = X(this.clock.pos) + 'px';
      } else {
        strip.querySelector('.cursor').hidden = true;
      }
    });
  };

  UI.prototype.renderCompStatus = function () {
    const el = this.$('compStatus');
    const sel = this.engine.compSelection;
    if (!sel.length) { el.textContent = '未选择范围。在 take 条（或时间线泳道）上横向拖选。'; return; }
    const policy = (document.querySelector('input[name="dispute"]:checked') || {}).value || 'live';
    let total = 0;
    const lines = sel.map(s => {
      const ranges = this.engine.effectiveRanges(s, policy);
      const len = ranges.reduce((a, r) => a + r[1] - r[0], 0);
      total += len;
      const t = this.store.state.takes.find(x => x.id === s.takeId);
      return '<div class="comp-line">▸ ' + fmtTime(s.in) + ' → ' + fmtTime(s.out) +
        '，可采纳 ' + len.toFixed(2) + 's' + (ranges.length > 1 ? '（' + ranges.length + ' 段无争议）' : '') + '</div>';
    });
    el.innerHTML = lines.join('') + '<div>合计可采纳 <b>' + total.toFixed(2) + 's</b>，采纳后合并为一个撤销单元。</div>';
  };

  // ---------------- 横幅 ----------------
  UI.prototype.showSuspend = function (reason) {
    this.$('suspendBanner').hidden = false;
    this.$('suspendReason').textContent = '原因：' + reason + '（位置 ' + fmtTime(this.clock.pos) + '）';
    const check = this.engine.canResume();
    this.$('btnResume').disabled = !check.ok;
    this.$('btnResume').title = check.ok ? '' : (check.reason || '端口未就绪');
  };
  UI.prototype.hideSuspend = function () { this.$('suspendBanner').hidden = true; };

  UI.prototype.showConflict = function (key) {
    this.$('conflictBar').hidden = false;
    this.$('conflictKey').textContent = key;
  };
  UI.prototype.hideConflict = function () { this.$('conflictBar').hidden = true; };

  UI.prototype.setCaptureState = function (text, rec) {
    this.$('captureState').textContent = text;
    const btn = this.$('btnCapture');
    btn.classList.toggle('rec', !!rec);
    btn.textContent = rec ? '■ 停止采集' : '● 采集一遍手势';
  };

  UI.prototype.setLoopControls = function (on) {
    this.$('btnLoop').textContent = '循环：' + (on ? '开' : '关');
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  MConsole.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
