'use strict';
/* midi-main.js — 组装：Store / MidiHub / Clock / Engine / Transport / Timeline / UI */
(function () {
  const M = window.MConsole;
  const { now } = M.util;

  const store = new M.Store();
  const hub = new M.MidiHub();
  const clock = new M.Clock();
  const engine = new M.Engine(store, hub, clock);
  const transport = new M.Transport(engine, clock, store);
  const ui = new M.UI({ store, hub, clock, engine });
  const timeline = new M.Timeline(engine, clock, store,
    document.getElementById('tlCanvas'),
    document.getElementById('tlScroll'),
    document.getElementById('tlZoom'));
  ui.timeline = timeline;
  window.__mconsole = { store, hub, clock, engine, ui, timeline };

  const $ = id => document.getElementById(id);

  // ---------- 顶部 ----------
  $('btnMidi').onclick = async () => {
    const ok = await hub.init();
    if (ok) ui.toast('MIDI 已就绪');
    else ui.toast(hub.supported ? 'MIDI 权限被拒绝，可用虚拟设备体验' : '此浏览器不支持 Web MIDI（请用 Chrome/Edge），可用虚拟设备体验', 4200);
  };
  hub.on('ready', () => ui.setMidiPerm('ok', 'MIDI 已连接'));
  hub.on('permission-error', () => ui.setMidiPerm('err', 'MIDI 权限被拒绝'));
  if (!hub.supported) ui.setMidiPerm('warn', '不支持 Web MIDI · 用虚拟设备');
  else ui.setMidiPerm('warn', 'MIDI 未连接');

  $('btnPair').onclick = () => {
    if (engine.learn) engine.cancelLearn();
    else ui.toast('配对模式：请先点一个软件控件');
  };
  engine.on('learn-changed', (l) => {
    ui.setPairing(!!l, l ? l.controlId : null);
    if (l) ui.toast('已选定控件，请转动硬件旋钮/推子（值需变化两次）');
  });

  $('btnRotateFp').onclick = () => {
    store.rotateProject();
    ui.setProjectFp();
    ui.toast('已切换到新工程指纹：旧草稿只供监听，不可采纳');
    ui.renderTakes();
    timeline.render();
  };

  $('btnUndo').onclick = () => { if (engine.undo()) ui.toast('已撤销上次采纳'); };

  // ---------- 帮助 ----------
  $('btnHelp').onclick = () => { $('helpOverlay').hidden = false; };
  $('btnHelpClose').onclick = () => { $('helpOverlay').hidden = true; };
  $('helpOverlay').addEventListener('click', (e) => { if (e.target.id === 'helpOverlay') e.currentTarget.hidden = true; });

  // ---------- 端口 / 虚拟设备 ----------
  let twinCount = 0;
  $('btnAddVirtual').onclick = () => { hub.addVirtual(0); ui.toast('已插入虚拟 FauxFab VC-1（8 个 CC 推子）'); };
  $('btnAddTwin').onclick = () => { hub.addVirtual(++twinCount); ui.toast('已插入同型号第二台（不同 id，绝不接管第一台的绑定）', 3200); };
  hub.on('ports-changed', () => { ui.renderPorts(); ui.renderVirtualPanels(); ui.renderBindings(); timeline.render(); });
  hub.on('port-found', (p) => ui.toast('端口上线：' + p.name + ' (#' + p.fp + ')'));
  hub.on('port-lost', (p) => ui.toast('端口离线：' + p.name + '，绑定保持不串台', 3200));

  ui.on('toggleVirtual', (id) => {
    const p = hub.getPort(id);
    if (p.online) hub.removeVirtual(id); else hub.replugVirtual(id);
  });
  ui.on('virtualCC', ({ portId, ch, cc, value }) => hub.sendVirtualCC(portId, ch, cc, value));

  // ---------- 绑定 ----------
  ui.on('learnControl', (controlId) => { engine.startLearn(controlId); });
  engine.on('binding-conflict', ({ key }) => ui.showConflict(key));
  $('btnConflictReplace').onclick = () => { engine.resolveConflict('replace'); ui.hideConflict(); };
  $('btnConflictShare').onclick = () => { engine.resolveConflict('share'); ui.hideConflict(); };
  $('btnConflictCancel').onclick = () => { engine.cancelConflict(); ui.hideConflict(); };

  ui.on('toggleArm', (id) => {
    const b = store.state.bindings.find(x => x.id === id);
    engine.setArmed(id, !b.armed);
  });
  ui.on('deleteBinding', (id) => { engine.removeBinding(id); ui.toast('已删除绑定'); });
  ui.on('updateBinding', ({ id, patch }) => { engine.updateBinding(id, patch); });
  ui.on('liveBindingPatch', ({ id, patch }) => {
    const b = store.state.bindings.find(x => x.id === id);
    if (b) { Object.assign(b, patch); const p = engine.processors.get(id); if (p) p.smoother.setAmount(patch.smooth); }
  });

  engine.on('bindings-changed', () => { ui.renderBindings(); ui.renderRack(); timeline.render(); });
  engine.on('binding-updated', () => timeline.render()); // 参数编辑：不重绘输入框
  engine.on('binding-value', ({ bindingId, value, raw }) => ui.updateMeter(bindingId, value, raw));
  // 高频现场值：只更新控件位置，不重建 DOM（避免打断鼠标拖拽）
  engine.on('live-changed', () => ui.updateRackValues());
  engine.on('notice', (msg) => ui.toast(msg, 2800));

  // ---------- 软件控件 ----------
  ui.on('mouseTouch', (cid) => engine.noteMouseTouch(cid));
  ui.on('setLive', ({ controlId, value }) => {
    store.state.live[controlId] = value;
    ui.updateRackValues(); // 拖拽中只移动手柄，不重建 DOM
  });

  // ---------- 走带 ----------
  $('btnPlay').onclick = () => {
    if (clock.playing) { clock.stop(); $('btnPlay').textContent = '▶ 播放'; }
    else { clock.play(clock.pos); $('btnPlay').textContent = '⏸ 暂停'; }
  };
  $('btnStop').onclick = () => { clock.stop(); clock.seek(0); $('btnPlay').textContent = '▶ 播放'; };
  clock.on('stop', () => { $('btnPlay').textContent = '▶ 播放'; });

  document.querySelectorAll('input[name="writemode"]').forEach(r => {
    r.checked = (store.state.settings.writeMode || 'overwrite') === r.value;
    r.onchange = () => { store.state.settings.writeMode = r.value; store.save(); };
  });
  $('smoothAmt').value = Math.round(store.state.settings.smooth * 100);
  $('smoothVal').textContent = $('smoothAmt').value + '%';
  $('smoothAmt').oninput = (e) => {
    const v = +e.target.value;
    $('smoothVal').textContent = v + '%';
    store.state.settings.smooth = v / 100;
    store.state.bindings.forEach(b => {
      b.smooth = v / 100;
      const p = engine.processors.get(b.id);
      if (p) p.smoother.setAmount(b.smooth);
    });
    store.save();
  };
  $('clipOOB').checked = store.state.settings.clipOOB;
  $('clipOOB').onchange = (e) => { store.state.settings.clipOOB = e.target.checked; store.save(); };

  $('btnArmAll').onclick = () => engine.armAll(true);
  $('btnArmNone').onclick = () => engine.armAll(false);

  $('btnCapture').onclick = async () => {
    if (engine.capture && (engine.capture.active || engine.capture.suspended)) {
      const r = await engine.stopCapture();
      if (r.ok) ui.toast('Take 已保存：' + fmtShort(r.take));
    } else {
      const r = engine.startCapture();
      if (!r.ok) ui.toast(r.reason, 3200);
    }
  };
  function fmtShort(t) {
    return M.util.fmtTime(t.start) + '–' + M.util.fmtTime(t.end);
  }

  engine.on('capture-started', () => {
    ui.setCaptureState('采集中…硬件时间戳已投射', true);
    ui.toast('采集开始：请做一遍手势');
    ui.renderBindings();
  });
  engine.on('capture-ended', () => {
    ui.setCaptureState('', false);
    ui.renderTakes();
    ui.renderBindings();
    timeline.render();
  });
  engine.on('capture-suspended', ({ reason }) => {
    ui.setCaptureState('已挂起：' + reason, false);
    ui.showSuspend(reason);
    ui.toast('采集挂起：' + reason, 3200);
  });
  engine.on('capture-resumed', () => {
    ui.hideSuspend();
    ui.setCaptureState('采集中…（已续接，缺口已记录）', true);
  });
  engine.on('dispute', ({ controlId, reason }) => {
    ui.toast('争议范围已圈出：' + ui.store.state.controls.find(c => c.id === controlId)?.name + '（' + reason + '）', 2600);
    ui.renderBindings();
  });
  engine.on('late-drop', ({ dropped }) => {
    if (dropped <= 3 || dropped % 20 === 0) ui.setCaptureState('采集中…（晚到丢弃 ×' + dropped + '，不回写）', true);
  });
  engine.on('draft-saved', () => { /* 静默保存草稿 */ });

  $('btnResume').onclick = () => {
    const r = engine.resumeCapture();
    if (!r.ok) ui.toast(r.reason || '暂时无法续接', 3000);
  };
  $('btnRestart').onclick = () => {
    engine.restartCapture();
    ui.hideSuspend();
    ui.toast('已另起一遍，原 take 作为截断草稿保留');
  };

  // 标签页重新聚焦：不自动恢复，仅刷新续接可用性
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && engine.capture && engine.capture.suspended) ui.showSuspend(engine.capture.suspendReason);
  });

  // ---------- 循环 ----------
  $('btnLoop').onclick = () => {
    const lo = parseFloat($('loopIn').value), hi = parseFloat($('loopOut').value);
    const on = !(clock.loop) && isFinite(lo) && isFinite(hi) && hi > lo;
    clock.setLoop(on, lo || 0, hi || 0);
    ui.setLoopControls(on);
  };
  clock.on('loop-changed', () => ui.setLoopControls(clock.loop));
  $('btnMarkIn').onclick = () => { $('loopIn').value = clock.pos.toFixed(2); };
  $('btnMarkOut').onclick = () => { $('loopOut').value = clock.pos.toFixed(2); };

  // ---------- Takes / 拼选 / 采纳 ----------
  ui.on('toggleMonitor', (id) => engine.toggleMonitor(id, !engine.isMonitoring(id)));
  ui.on('deleteTake', (id) => { engine.store.removeTake(id); engine.toggleMonitor(id, false); ui.renderTakes(); timeline.render(); });

  document.querySelectorAll('input[name="dispute"]').forEach(r => { r.onchange = () => { ui.renderCompStatus(); ui.drawTakeStrips(); }; });
  $('btnCompClear').onclick = () => { engine.clearSelection(); };
  engine.on('selection-changed', () => { ui.renderCompStatus(); ui.renderTakes(); timeline.render(); });
  engine.on('monitor-changed', () => ui.renderTakes());

  $('btnAdopt').onclick = () => {
    const policy = (document.querySelector('input[name="dispute"]:checked') || {}).value || 'live';
    const r = engine.adopt(policy);
    if (r.ok) ui.toast('已采纳 ' + r.length.toFixed(2) + 's，合并为一个撤销单元（↶ 可整体撤销）');
    else ui.toast(r.reason, 3200);
    timeline.render();
  };
  engine.on('adopted', () => { ui.renderRack(); ui.renderTakes(); timeline.render(); });
  engine.on('undo-applied', () => { ui.renderRack(); ui.renderTakes(); timeline.render(); ui.toast('已撤销'); });

  // ---------- 渲染循环 ----------
  let lastStripDraw = 0;
  function frame() {
    $('clockMain').textContent = M.util.fmtTime(clock.pos);
    ui.$('portClock').textContent = M.util.fmtTime(clock.pos) + (clock.playing ? ' ▶' : '');
    ui.$('schedLag').textContent = Math.round(clock.lastFrameLagMs) + ' ms';
    $('markInfo').textContent = $('loopIn').value && $('loopOut').value
      ? '区间 ' + $('loopIn').value + '–' + $('loopOut').value + 's' : '';
    if (clock.playing && now() - lastStripDraw > 80) {
      lastStripDraw = now();
      ui.drawTakeStrips();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 采集点到达：草稿已实时 upsert，首次创建行、之后只重画条带（不打断指针拖选）
  let lastPointRender = 0;
  engine.on('capture-point', () => {
    const existed = ui._takeStripCanvases.has(engine.capture.takeId);
    if (!existed) ui.renderTakes();
    else if (now() - lastPointRender > 90) {
      lastPointRender = now();
      ui.drawTakeStrips();
    }
  });

  // ---------- 初次渲染 ----------
  ui.setProjectFp();
  ui.renderRack();
  ui.renderBindings();
  ui.renderPorts();
  ui.renderTakes();
  timeline.render();

  // 尝试自动初始化 MIDI（部分浏览器必须用户手势；失败则提示）
  if (hub.supported) {
    hub.init().then(ok => {
      if (ok) ui.setMidiPerm('ok', 'MIDI 已连接');
    }).catch(() => {});
  }
})();
