'use strict';

/* ================= 全局状态 ================= */

let ctx = null;          // AudioContext（首次交互时创建）
let master = null;       // 主增益 → 压限 → 输出。所有片段在此汇合，重叠处自然按增益相加
let comp = null;

const LANE_H = 60;       // 每条泳道高度(px)，与 .clip 高度一致
const LOOKAHEAD = 0.25;  // 调度前瞻（秒）
const TICK_MS = 40;      // 调度器节拍

const palette = ['#4f8ef7', '#f7794f', '#4fc77f', '#c86ef0', '#e0b53e', '#4fc3c7'];
let nextId = 1;

const state = {
  clips: [],        // {id,name,buffer,duration,offset,gain,fadeIn,fadeOut,lane,color,el,els}
  pps: 100,         // 缩放：像素/秒
  playing: false,
  playhead: 0,      // 暂停时的播放头位置（秒）
  playStartTL: 0,   // 本次播放起点（秒），⏹ 回到这里
  loop: null,       // {a,b} 秒，已吸附到整数采样
  loopOn: true,
  selectedId: null,
  // —— 播放期调度状态 ——
  segments: [],     // 时间轴→AudioContext 时间的分段映射 {tlStart, ctxStart, tlEnd}
  scheduled: [],    // 已调度源 {clipId, src, gain, whenCtx, endCtx}
  scheduledUntil: 0,// 当前段已调度到的时间轴位置（秒）
  loopAnchorCtx: 0, // 第 0 圈 loop.a 对应的 ctx 时间；第 k 圈 = anchor + k*loopLen
  loopCycle: 0,
  timer: null,
};

const $ = s => document.querySelector(s);

/* ================= 音频上下文 ================= */

function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.9;
  comp = ctx.createDynamicsCompressor(); // 重叠叠加时防止削波
  master.connect(comp).connect(ctx.destination);
}

/* 秒 → 吸附到整数采样后的秒 */
function snapSec(t) {
  ensureCtx();
  return Math.round(t * ctx.sampleRate) / ctx.sampleRate;
}

/* ================= 片段模型与渲染 ================= */

function projectEnd() {
  return state.clips.reduce((m, c) => Math.max(m, c.offset + c.duration), 0);
}
function timelineWidth() {
  return Math.max(60, projectEnd() + 30) * state.pps;
}

function addClip({ name, buffer }) {
  const clip = {
    id: nextId++,
    name,
    buffer,
    duration: buffer.duration,
    offset: projectEnd() ? projectEnd() + 0.25 : 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    lane: 0,
    color: palette[(nextId - 2) % palette.length],
  };
  buildClipDom(clip);
  state.clips.push(clip);
  layout();
  selectClip(clip.id);
  return clip;
}

function buildClipDom(clip) {
  const el = document.createElement('div');
  el.className = 'clip';
  el.style.background = clip.color + '55';
  el.style.borderColor = clip.color;
  const wave = document.createElement('canvas'); wave.className = 'wave';
  const fi = document.createElement('div'); fi.className = 'fade fade-in';
  const fo = document.createElement('div'); fo.className = 'fade fade-out';
  const hi = document.createElement('div'); hi.className = 'handle hi';
  const ho = document.createElement('div'); ho.className = 'handle ho';
  const label = document.createElement('span'); label.className = 'label';
  label.textContent = clip.name;
  el.appendChild(wave); el.appendChild(fi); el.appendChild(fo);
  el.appendChild(hi); el.appendChild(ho); el.appendChild(label);
  clip.el = el;
  clip.els = { wave, fi, fo, hi, ho };
  $('#lanes').appendChild(el);

  // 拖动片段本体：只改 clip.offset，淡化是片段属性（秒），天然跟着走
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('handle')) return;
    selectClip(clip.id);
    const startX = e.clientX, startOff = clip.offset;
    el.setPointerCapture(e.pointerId);
    const move = ev => {
      const dt = (ev.clientX - startX) / state.pps;
      clip.offset = Math.max(0, Math.round((startOff + dt) * 1000) / 1000);
      if (state.playing) killPendingForClip(clip.id); // 撤掉旧位置的未发声调度
      layout();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      rescheduleClipNow(clip); // 播放中：按新位置补调度（不影响播放头）
      refreshPanel();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });

  // 淡化柄：左柄控淡入，右柄控淡出
  bindFadeHandle(clip.els.hi, clip, 'fadeIn');
  bindFadeHandle(clip.els.ho, clip, 'fadeOut');
}

function bindFadeHandle(handle, clip, key) {
  handle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    selectClip(clip.id);
    const startX = e.clientX, startFade = clip[key];
    handle.setPointerCapture(e.pointerId);
    const move = ev => {
      const d = (ev.clientX - startX) / state.pps;
      const v = key === 'fadeIn' ? startFade + d : startFade - d;
      clip[key] = Math.min(clip.duration, Math.max(0, Math.round(v * 1000) / 1000));
      updateFades(clip);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      rescheduleClipNow(clip);
      refreshPanel();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

function updateFades(clip) {
  clip.els.fi.style.width = (clip.fadeIn * state.pps) + 'px';
  clip.els.fo.style.width = (clip.fadeOut * state.pps) + 'px';
}

/* 泳道分配：时间上重叠的片段自动叠到下一行（纯视觉，不影响混音） */
function layout() {
  const sorted = [...state.clips].sort((a, b) => a.offset - b.offset);
  const laneEnds = [];
  for (const c of sorted) {
    let lane = laneEnds.findIndex(end => c.offset >= end - 1e-9);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = c.offset + c.duration;
    c.lane = lane;
  }
  for (const c of state.clips) {
    c.el.style.left = (c.offset * state.pps) + 'px';
    c.el.style.width = (c.duration * state.pps) + 'px';
    c.el.style.top = (c.lane * LANE_H) + 'px';
    updateFades(c);
  }
  $('#lanes').style.height = (Math.max(1, laneEnds.length) * LANE_H) + 'px';
  $('#timeline').style.width = timelineWidth() + 'px';
  renderRuler();
  renderLoopRegion();
}

function drawWave(clip) {
  const cv = clip.els.wave;
  const w = Math.min(4000, Math.max(1, Math.round(clip.duration * state.pps)));
  const h = LANE_H - 14;
  cv.width = w; cv.height = h; cv.style.height = h + 'px';
  const g = cv.getContext('2d');
  const data = clip.buffer.getChannelData(0);
  const spp = data.length / w;
  const stride = Math.max(1, Math.floor(spp / 60));
  g.fillStyle = 'rgba(255,255,255,.75)';
  for (let x = 0; x < w; x++) {
    const s0 = Math.floor(x * spp), s1 = Math.min(data.length, Math.ceil((x + 1) * spp));
    let mn = 1, mx = -1;
    for (let i = s0; i < s1; i += stride) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const y0 = (1 - mx) * h / 2, y1 = (1 - mn) * h / 2;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function deleteClip(id) {
  const i = state.clips.findIndex(c => c.id === id);
  if (i < 0) return;
  const clip = state.clips[i];
  // 停掉该片段所有已调度源（含正在发声的）
  state.scheduled = state.scheduled.filter(e => {
    if (e.clipId === id) { try { e.src.stop(); } catch (_) {} return false; }
    return true;
  });
  clip.el.remove();
  state.clips.splice(i, 1);
  if (state.selectedId === id) selectClip(null);
  layout();
}

/* ================= 标尺与循环区 ================= */

function fmt(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return String(m).padStart(2, '0') + ':' + s.toFixed(3).padStart(6, '0');
}
function fmtShort(t) {
  const m = Math.floor(t / 60), s = Math.floor(t - m * 60);
  return m + ':' + String(s).padStart(2, '0');
}

function renderRuler() {
  const c = $('#ruler');
  const w = timelineWidth();
  c.width = w; c.height = 28; c.style.width = w + 'px';
  const g = c.getContext('2d');
  g.fillStyle = '#1c1f26'; g.fillRect(0, 0, w, 28);
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  const step = steps.find(s => s * state.pps >= 70) || 60;
  g.strokeStyle = '#3a4050'; g.fillStyle = '#9aa3b2';
  g.font = '10px sans-serif'; g.textBaseline = 'top';
  g.beginPath();
  for (let t = 0; t * state.pps <= w; t += step) {
    const x = Math.round(t * state.pps) + .5;
    g.moveTo(x, 14); g.lineTo(x, 28);
    g.fillText(fmtShort(t), x + 3, 4);
  }
  g.stroke();
  const L = state.loop;
  if (L) {
    g.fillStyle = 'rgba(80,160,255,.25)';
    g.fillRect(L.a * state.pps, 0, (L.b - L.a) * state.pps, 28);
  }
}

function renderLoopRegion() {
  const el = $('#loopregion');
  const L = state.loop;
  if (!L) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.classList.toggle('off', !state.loopOn);
  el.style.left = (L.a * state.pps) + 'px';
  el.style.width = ((L.b - L.a) * state.pps) + 'px';
}

function updateLoopUI() {
  $('#btnLoop').textContent = '循环:' + (state.loopOn && state.loop ? '开' : '关');
  $('#btnLoop').classList.toggle('active', !!(state.loopOn && state.loop));
  const L = state.loop;
  if (L && ctx) {
    const nA = Math.round(L.a * ctx.sampleRate);
    const nB = Math.round(L.b * ctx.sampleRate);
    $('#loopInfo').textContent =
      `${fmt(L.a)} → ${fmt(L.b)} · 长度 ${fmt(L.b - L.a)} = ${nB - nA} 采样`;
  } else {
    $('#loopInfo').textContent = L ? `${fmt(L.a)} → ${fmt(L.b)}` : '';
  }
  renderLoopRegion();
}

/* 标尺交互：单击=定位播放头；拖动=框选循环区（吸附到采样） */
$('#ruler').addEventListener('pointerdown', e => {
  const ruler = $('#ruler');
  ruler.setPointerCapture(e.pointerId);
  const tOf = ev => {
    const r = ruler.getBoundingClientRect();
    return Math.max(0, (ev.clientX - r.left) / state.pps);
  };
  const t0 = tOf(e);
  let moved = false;
  const move = ev => {
    const t1 = tOf(ev);
    if (!moved && Math.abs(t1 - t0) * state.pps < 4) return;
    moved = true;
    state.loop = { a: Math.min(t0, t1), b: Math.max(t0, t1) };
    renderRuler(); renderLoopRegion();
  };
  const up = ev => {
    ruler.removeEventListener('pointermove', move);
    ruler.removeEventListener('pointerup', up);
    if (!moved) {
      seek(tOf(ev));
    } else {
      // 进出点吸附到整数采样 —— 循环不漂移的前提
      let a = snapSec(state.loop.a), b = snapSec(state.loop.b);
      if (b - a < 1 / ctx.sampleRate) b = a + 1 / ctx.sampleRate;
      state.loop = { a, b };
      state.loopOn = true;
      updateLoopUI(); renderRuler();
      fillExportRange(a, b); // 框选区间同时作为导出区间
    }
  };
  ruler.addEventListener('pointermove', move);
  ruler.addEventListener('pointerup', up);
});

/* ================= 播放引擎 ================= */

function effectiveLoop() {
  return (state.loop && state.loopOn && state.loop.b - state.loop.a > 0) ? state.loop : null;
}

/* 开始（或重新定位）播放：建立时间轴→ctx 时间的分段映射 */
function beginPlayback(from) {
  stopSources();
  state.segments = [];
  state.scheduled = [];
  const startCtx = ctx.currentTime + 0.08;
  state.playStartTL = from;
  const loop = effectiveLoop();
  if (loop && from < loop.b) {
    // 首段：[from, loop.b)，之后每圈 [loop.a, loop.b)
    state.segments.push({ tlStart: from, ctxStart: startCtx, tlEnd: loop.b });
    // 第 0 圈 loop.a 的 ctx 时间锚点；第 k 圈 = anchor + k*loopLen
    // 每圈都由锚点直接算出，不做累加，因此不会逐圈漂移
    state.loopAnchorCtx = startCtx + (loop.b - from);
    state.loopCycle = 0;
  } else {
    state.segments.push({ tlStart: from, ctxStart: startCtx, tlEnd: Infinity });
    state.loopAnchorCtx = null;
  }
  state.scheduledUntil = from;
}

function schedulerTick() {
  if (!state.playing) return;
  const horizon = ctx.currentTime + LOOKAHEAD;
  let guard = 0;
  while (guard++ < 200) {
    const seg = state.segments[state.segments.length - 1];
    const tlHorizon = seg.tlStart + (horizon - seg.ctxStart);
    const tlTo = Math.min(tlHorizon, seg.tlEnd);
    if (tlTo > state.scheduledUntil) scheduleRange(state.scheduledUntil, tlTo, seg);
    state.scheduledUntil = tlTo;
    if (tlHorizon >= seg.tlEnd && seg.tlEnd !== Infinity) {
      const loop = effectiveLoop();
      if (!loop) break;
      const ctxStart = state.loopAnchorCtx + state.loopCycle * (loop.b - loop.a);
      state.segments.push({ tlStart: loop.a, ctxStart, tlEnd: loop.b });
      state.loopCycle++;
      state.scheduledUntil = loop.a;
      if (ctxStart > horizon) break;
    } else break;
  }
  // 清理已结束的源与过期的段
  const now = ctx.currentTime;
  state.scheduled = state.scheduled.filter(e => e.endCtx > now - 1);
  while (state.segments.length > 2) {
    const s0 = state.segments[0];
    if (s0.ctxStart + (s0.tlEnd - s0.tlStart) < now - 1) state.segments.shift();
    else break;
  }
}

function scheduleRange(tlFrom, tlTo, seg) {
  for (const clip of state.clips) scheduleClipInSeg(clip, tlFrom, tlTo, seg);
}

/* 把片段与时间轴区间 [tlFrom,tlTo] 的交集调度到 seg 对应的 ctx 时间上 */
function scheduleClipInSeg(clip, tlFrom, tlTo, seg) {
  const cs = clip.offset, ce = cs + clip.duration;
  const s = Math.max(cs, tlFrom), e = Math.min(ce, tlTo);
  if (e - s <= 0.0005) return;
  const when = seg.ctxStart + (s - seg.tlStart);
  const src = ctx.createBufferSource();
  src.buffer = clip.buffer;
  const g = ctx.createGain();
  applyEnvelope(g.gain, clip, when, s, e);
  src.connect(g).connect(master); // 全部汇入 master：重叠处按增益相加
  src.start(when, s - cs, e - s);
  state.scheduled.push({ clipId: clip.id, src, gain: g, whenCtx: when, endCtx: when + (e - s) });
}

/* 淡入淡出包络：以时间轴坐标计算，再映射到 ctx 时间。
   淡化秒数存在片段上，片段移动后重新调度时自然出现在新位置。 */
function applyEnvelope(p, clip, when, tlS, tlE) {
  const cs = clip.offset, ce = cs + clip.duration;
  let fi = Math.min(clip.fadeIn, clip.duration);
  let fo = Math.min(clip.fadeOut, clip.duration);
  if (fi + fo > clip.duration) { const k = clip.duration / (fi + fo); fi *= k; fo *= k; }
  const gainAt = t => {
    let v = clip.gain;
    if (fi > 1e-6 && t < cs + fi) v *= Math.max(0, (t - cs) / fi);
    if (fo > 1e-6 && t > ce - fo) v *= Math.max(0, (ce - t) / fo);
    return v;
  };
  const pts = [[tlS, gainAt(tlS)]];
  if (fi > 1e-6 && cs + fi > tlS && cs + fi < tlE) pts.push([cs + fi, gainAt(cs + fi)]);
  if (fo > 1e-6 && ce - fo > tlS && ce - fo < tlE) pts.push([ce - fo, gainAt(ce - fo)]);
  pts.push([tlE, gainAt(tlE)]);
  const t2c = tl => when + (tl - tlS);
  p.setValueAtTime(pts[0][1], t2c(pts[0][0]));
  for (let i = 1; i < pts.length; i++) {
    p.linearRampToValueAtTime(Math.max(pts[i][1], 1e-5), t2c(pts[i][0]));
  }
}

/* 撤掉某片段尚未发声的调度（正在响的保留，避免爆音） */
function killPendingForClip(id) {
  if (!ctx) return;
  const now = ctx.currentTime;
  state.scheduled = state.scheduled.filter(e => {
    if (e.clipId === id && e.whenCtx > now - 0.005) {
      try { e.src.stop(); } catch (_) {}
      return false;
    }
    return true;
  });
}

/* 播放中修改片段后调用：只补调度未来部分，绝不触碰播放头映射 */
function rescheduleClipNow(clip) {
  if (!state.playing || !ctx) return;
  killPendingForClip(clip.id);
  const now = ctx.currentTime;
  const last = state.segments[state.segments.length - 1];
  for (const seg of state.segments) {
    const segEndCtx = seg.ctxStart + (seg.tlEnd - seg.tlStart);
    if (segEndCtx < now) continue;
    const segNowTl = seg.tlStart + Math.max(0, now - seg.ctxStart);
    const cs = clip.offset, ce = cs + clip.duration;
    const s = Math.max(cs, seg.tlStart, segNowTl + 0.03);
    const e = Math.min(ce, seg.tlEnd);
    if (e - s < 0.005) continue;
    const when = seg.ctxStart + (s - seg.tlStart);
    if (when < now + 0.02) continue;
    // 当前段里调度器尚未覆盖的区域由调度器负责，避免重复发声
    if (seg === last && s >= state.scheduledUntil - 1e-9) continue;
    scheduleClipInSeg(clip, s, e, seg);
  }
}

function stopSources() {
  for (const e of state.scheduled) { try { e.src.stop(); } catch (_) {} }
  state.scheduled = [];
}

/* 播放头位置：只由 ctx.currentTime 与分段映射推出。
   移动/删除片段不改变 segments，因此指针绝不跳动。 */
function posNow() {
  if (!state.playing) return state.playhead;
  const t = ctx.currentTime;
  for (let i = state.segments.length - 1; i >= 0; i--) {
    const s = state.segments[i];
    const end = s.ctxStart + (s.tlEnd - s.tlStart);
    if (t >= s.ctxStart && t < end) return s.tlStart + (t - s.ctxStart);
  }
  if (state.segments.length && t < state.segments[0].ctxStart) return state.segments[0].tlStart;
  const last = state.segments[state.segments.length - 1];
  return last ? last.tlEnd : state.playhead;
}

function play() {
  ensureCtx();
  ctx.resume();
  if (state.playing) return;
  if (!state.clips.length) return;
  beginPlayback(state.playhead);
  state.playing = true;
  state.timer = setInterval(schedulerTick, TICK_MS);
  schedulerTick();
}

function teardown() {
  state.playing = false;
  clearInterval(state.timer); state.timer = null;
  stopSources();
  state.segments = [];
}

function pause() {
  if (!state.playing) return;
  state.playhead = posNow();
  teardown();
}

function stop() {
  if (!state.playing) return;
  teardown();
  state.playhead = state.playStartTL;
}

function seek(t) {
  t = Math.max(0, t);
  if (state.playing) {
    beginPlayback(t); // 用户主动定位：重建映射，这是预期的跳转
    schedulerTick();
  }
  state.playhead = t;
}

/* ================= 播放头刷新 ================= */

function tickPlayhead() {
  const pos = posNow();
  $('#playhead').style.left = (pos * state.pps) + 'px';
  $('#time').textContent = fmt(pos);
  if (state.playing && !effectiveLoop() && state.clips.length && pos > projectEnd() + 0.5) {
    teardown();
    state.playhead = projectEnd();
  }
  requestAnimationFrame(tickPlayhead);
}

/* ================= 面板 ================= */

function selectClip(id) {
  state.selectedId = id;
  for (const c of state.clips) c.el.classList.toggle('selected', c.id === id);
  refreshPanel();
}

function refreshPanel() {
  const clip = state.clips.find(c => c.id === state.selectedId);
  $('#panelEmpty').hidden = !!clip;
  $('#panelBody').hidden = !clip;
  if (!clip) return;
  $('#pName').textContent = clip.name;
  $('#pPos').value = clip.offset.toFixed(3);
  $('#pGain').value = clip.gain;
  $('#pGainVal').textContent = clip.gain.toFixed(2);
  $('#pFadeIn').value = clip.fadeIn;
  $('#pFadeOut').value = clip.fadeOut;
}

function selectedClip() {
  return state.clips.find(c => c.id === state.selectedId);
}

$('#pPos').addEventListener('change', () => {
  const c = selectedClip(); if (!c) return;
  c.offset = Math.max(0, parseFloat($('#pPos').value) || 0);
  layout(); rescheduleClipNow(c);
});
$('#pGain').addEventListener('input', () => {
  const c = selectedClip(); if (!c) return;
  c.gain = parseFloat($('#pGain').value);
  $('#pGainVal').textContent = c.gain.toFixed(2);
  rescheduleClipNow(c);
});
$('#pFadeIn').addEventListener('change', () => {
  const c = selectedClip(); if (!c) return;
  c.fadeIn = Math.min(c.duration, Math.max(0, parseFloat($('#pFadeIn').value) || 0));
  updateFades(c); rescheduleClipNow(c); refreshPanel();
});
$('#pFadeOut').addEventListener('change', () => {
  const c = selectedClip(); if (!c) return;
  c.fadeOut = Math.min(c.duration, Math.max(0, parseFloat($('#pFadeOut').value) || 0));
  updateFades(c); rescheduleClipNow(c); refreshPanel();
});
$('#pDelete').addEventListener('click', () => {
  if (state.selectedId != null) deleteClip(state.selectedId);
});

/* ================= 工具栏 ================= */

$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async e => {
  ensureCtx();
  for (const f of e.target.files) {
    try {
      const ab = await f.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      const clip = addClip({ name: f.name, buffer: buf });
      drawWave(clip);
    } catch (err) {
      alert('无法解码: ' + f.name);
    }
  }
  e.target.value = '';
});

$('#btnDemo').addEventListener('click', () => {
  ensureCtx();
  const sr = ctx.sampleRate, dur = 2;
  const buf = ctx.createBuffer(1, sr * dur, sr);
  const d = buf.getChannelData(0);
  const f = [440, 523.25, 659.25][(nextId - 1) % 3];
  for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * f * i / sr) * 0.8;
  const clip = addClip({ name: `测试音 ${f}Hz`, buffer: buf });
  drawWave(clip);
});

$('#btnPlay').addEventListener('click', play);
$('#btnPause').addEventListener('click', pause);
$('#btnStop').addEventListener('click', stop);
$('#btnLoop').addEventListener('click', () => {
  state.loopOn = !state.loopOn;
  updateLoopUI();
});
$('#btnClearLoop').addEventListener('click', () => {
  state.loop = null;
  updateLoopUI(); renderRuler();
});
$('#zoom').addEventListener('input', e => {
  state.pps = parseInt(e.target.value, 10);
  layout();
  for (const c of state.clips) drawWave(c);
});

document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    state.playing ? pause() : play();
  }
});

/* ================= WAV 导出（任务化） ================= */

const MAX_EXPORT_BYTES = 512 * 1024 * 1024; // 单次导出文件大小上限（超出即明确失败）
const TASK_STATE_TEXT = { pending: '等待', running: '进行中', canceled: '已取消', failed: '失败', done: '已完成' };

let taskSeq = 1;
const exportTasks = [];   // 本次会话的全部导出任务（新任务显示在最前）
let runningTask = null;

/* 冻结提交时刻的片段内容与参数：之后对时间线的任何编辑都不影响该任务。
   AudioBuffer 解码后内容不再被改写，引用即冻结；参数全部按值复制。
   只收与区间相交的片段（区间外的片段不影响导出结果）。 */
function takeSnapshot(a, b) {
  const clips = [];
  for (const c of state.clips) {
    if (c.offset >= b || c.offset + c.duration <= a) continue;
    clips.push({
      name: c.name, buffer: c.buffer,
      offset: c.offset, gain: c.gain,
      fadeIn: c.fadeIn, fadeOut: c.fadeOut, duration: c.duration,
    });
  }
  clips.sort((x, y) => x.offset - y.offset || bufferUid(x.buffer) - bufferUid(y.buffer));
  return { a, b, clips };
}

function specText(spec) {
  const bits = { '16': '16bit', '24': '24bit', '32f': '32f' }[spec.bitDepth];
  return `${spec.sampleRate}Hz · ${spec.channels === 1 ? '单声道' : '立体声'} · ${bits}`;
}

function readExportSpec() {
  return {
    sampleRate: parseInt($('#xRate').value, 10),
    channels: parseInt($('#xCh').value, 10),
    bitDepth: $('#xBits').value,
  };
}

function fillExportRange(a, b) {
  $('#xStart').value = a.toFixed(3);
  $('#xEnd').value = b.toFixed(3);
  updateExportInfo();
}

function updateExportInfo() {
  const a = parseFloat($('#xStart').value), b = parseFloat($('#xEnd').value);
  const el = $('#xInfo');
  el.classList.remove('over');
  if (!isFinite(a) || !isFinite(b) || a < 0 || b <= a) { el.textContent = ''; return; }
  const spec = readExportSpec();
  const frames = Math.round((b - a) * spec.sampleRate);
  const bytes = 44 + frames * bytesPerFrame(spec);
  el.textContent = `预计 ${frames.toLocaleString()} 采样 · 约 ${fmtBytes(bytes)}`;
  if (bytes > MAX_EXPORT_BYTES) {
    el.textContent += `（超过上限 ${fmtBytes(MAX_EXPORT_BYTES)}）`;
    el.classList.add('over');
  }
}

/* 提交导出：相同区间 + 相同快照 + 相同规格 ⇒ 复用已有任务，不产生第二个 */
function enqueueExport(snap, spec) {
  const fp = snapshotFingerprint(snap, spec);
  const dup = exportTasks.find(t => t.fingerprint === fp &&
    (t.state === 'pending' || t.state === 'running' || t.state === 'done'));
  if (dup) { flashTask(dup); return dup; }
  const task = {
    id: taskSeq++, fingerprint: fp, snap, spec,
    state: 'pending', progress: 0, error: '',
    blobUrl: '', blobSize: 0, cancelRequested: false,
    frames: Math.round((snap.b - snap.a) * spec.sampleRate),
    els: null,
  };
  exportTasks.unshift(task);
  buildTaskDom(task);
  // 提交即校验：预计文件超过限制 ⇒ 明确失败（任务留在列表里可查看原因）
  const estBytes = 44 + task.frames * bytesPerFrame(spec);
  if (!(task.frames > 0)) failTask(task, '导出区间无效');
  else if (estBytes > MAX_EXPORT_BYTES) {
    failTask(task, `预计文件约 ${fmtBytes(estBytes)}，超过单次导出上限 ${fmtBytes(MAX_EXPORT_BYTES)}`);
  }
  updateTaskUI(task);
  pumpQueue();
  return task;
}

function failTask(task, msg) {
  task.state = 'failed';
  task.error = msg;
}

function pumpQueue() {
  if (runningTask) return;
  const next = exportTasks.find(t => t.state === 'pending');
  if (!next) return;
  runningTask = next;
  runExport(next).then(
    () => { runningTask = null; pumpQueue(); },
    () => { runningTask = null; pumpQueue(); },
  );
}

async function runExport(task) {
  task.state = 'running';
  updateTaskUI(task);
  try {
    const res = await renderWav(task.snap, task.spec, {
      shouldCancel: () => task.cancelRequested,
      onProgress: p => { // 进度只向前
        task.progress = Math.max(task.progress, p);
        updateTaskProgress(task);
      },
      yieldControl: () => new Promise(r => setTimeout(r, 0)), // 块间让出：导出期间可继续编辑/预听
    });
    if (res.canceled) { task.state = 'canceled'; return; } // 不留半成品
    const blob = new Blob(res.parts, { type: 'audio/wav' });
    task.blobUrl = URL.createObjectURL(blob);
    task.blobSize = blob.size;
    task.progress = 1;
    task.state = 'done';
  } catch (err) {
    task.state = 'failed';
    task.error = friendlyError(err);
  } finally {
    updateTaskUI(task);
  }
}

function cancelTask(task) {
  if (task.state === 'pending') {
    task.cancelRequested = true;
    task.state = 'canceled';
    updateTaskUI(task);
  } else if (task.state === 'running') {
    task.cancelRequested = true; // 渲染循环在块边界响应
  }
}

function retryTask(task) {
  if (task.state !== 'failed' && task.state !== 'canceled') return;
  enqueueExport(task.snap, task.spec); // 从同一快照重新发起；去重逻辑照常生效
}

/* ---------- 任务列表 UI ---------- */

function mkDiv(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function buildTaskDom(task) {
  const el = mkDiv('task');
  const head = mkDiv('t-head');
  const title = document.createElement('span'); title.className = 't-title';
  const state = document.createElement('span'); state.className = 't-state';
  head.appendChild(title); head.appendChild(state);
  const bar = mkDiv('t-bar');
  const fill = mkDiv('t-fill');
  bar.appendChild(fill);
  const meta = mkDiv('t-meta');
  const err = mkDiv('t-err'); err.hidden = true;
  const actions = mkDiv('t-actions');
  el.appendChild(head); el.appendChild(bar); el.appendChild(meta);
  el.appendChild(err); el.appendChild(actions);
  task.els = { root: el, title, state, fill, meta, err, actions };
  task.els.title.textContent =
    `#${task.id}  ${fmt(task.snap.a)} → ${fmt(task.snap.b)} · ${specText(task.spec)}`;
  $('#tasksEmpty').hidden = true;
  $('#tasks').prepend(el);
  updateTaskUI(task);
}

function mkTaskBtn(text, onclick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.addEventListener('click', onclick);
  return b;
}

function updateTaskUI(task) {
  const e = task.els;
  if (!e) return;
  const flashing = e.root.classList.contains('flash');
  e.root.className = 'task st-' + task.state + (flashing ? ' flash' : '');
  e.state.textContent = TASK_STATE_TEXT[task.state];
  updateTaskProgress(task);
  e.err.hidden = task.state !== 'failed';
  e.err.textContent = task.error || '';
  e.actions.innerHTML = '';
  if (task.state === 'pending' || task.state === 'running') {
    e.actions.appendChild(mkTaskBtn('取消', () => cancelTask(task)));
  } else if (task.state === 'failed') {
    e.actions.appendChild(mkTaskBtn('重试', () => retryTask(task)));
  } else if (task.state === 'canceled') {
    e.actions.appendChild(mkTaskBtn('重新导出', () => retryTask(task)));
  } else if (task.state === 'done') {
    // 只有完成的任务可以下载
    const a = document.createElement('a');
    a.className = 'dl';
    a.textContent = '下载 WAV';
    a.href = task.blobUrl;
    a.download = downloadName(task);
    e.actions.appendChild(a);
  }
}

function updateTaskProgress(task) {
  const e = task.els;
  if (!e) return;
  e.fill.style.width = (task.progress * 100) + '%';
  let meta = `${task.frames.toLocaleString()} 采样`;
  if (task.state === 'pending' || task.state === 'running') {
    meta = `${Math.floor(task.progress * 100)}% · ` + meta;
  }
  if (task.state === 'done') meta += ` · ${fmtBytes(task.blobSize)}`;
  e.meta.textContent = meta;
}

function downloadName(task) {
  const { snap, spec } = task;
  return `export_${snap.a.toFixed(3)}s-${snap.b.toFixed(3)}s_` +
    `${spec.sampleRate}Hz_${spec.channels}ch_${spec.bitDepth}.wav`;
}

function flashTask(task) {
  const el = task.els && task.els.root;
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth; // 重新触发动画
  el.classList.add('flash');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ---------- 导出表单 ---------- */

$('#btnExport').addEventListener('click', () => {
  const a = parseFloat($('#xStart').value), b = parseFloat($('#xEnd').value);
  if (!isFinite(a) || !isFinite(b) || a < 0 || b <= a) {
    alert('导出区间无效：请检查起止时间');
    return;
  }
  enqueueExport(takeSnapshot(a, b), readExportSpec());
});
$('#xUseLoop').addEventListener('click', () => {
  if (!state.loop) { alert('请先在标尺上拖出区间'); return; }
  fillExportRange(state.loop.a, state.loop.b);
});
$('#xUseAll').addEventListener('click', () => {
  const end = projectEnd();
  if (end <= 0) { alert('时间线上还没有片段'); return; }
  fillExportRange(0, end);
});
for (const id of ['xStart', 'xEnd', 'xRate', 'xCh', 'xBits']) {
  $('#' + id).addEventListener('input', updateExportInfo);
  $('#' + id).addEventListener('change', updateExportInfo);
}

/* ================= 启动 ================= */

layout();
updateLoopUI();
requestAnimationFrame(tickPlayhead);
