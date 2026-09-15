'use strict';

/* ================= 全局状态 ================= */

let ctx = null;          // AudioContext（首次交互时创建）
let master = null;       // 主增益 → 压限 → 输出。所有片段在此汇合，重叠处自然按增益相加
let comp = null;

const LANE_H = 60;       // 每条泳道高度(px)，与 .clip 高度一致
const LOOKAHEAD = 0.25;  // 调度前瞻（秒）
const TICK_MS = 40;      // 调度器节拍

const palette = ['#4f8ef7', '#f7794f', '#4fc77f', '#c86ef0', '#e0b53e', '#4fc3c7'];

let store = null;        // 存储编排（历史引擎 + WAL + 素材库）
const PREBOOT_DOC = { clips: [], media: {}, loop: null, loopOn: true };
function doc() { return store ? store.eng.doc : PREBOOT_DOC; }
let buffers = new Map(); // mediaHash -> AudioBuffer（运行时；历史里不存音频字节）
let relinkTarget = null; // {hashes:[...]} 等待文件选择
let previewDoc = null;   // 非空 = 正在预览检查点（独立文档，绝不污染工作状态）

const state = {
  clips: [],        // 运行时片段 {id,name,mediaHash,duration,offset,gain,fadeIn,fadeOut,buffer,lane,color,el,els}
  doc: null,        // = doc()（编辑状态唯一事实源）
  pps: 100,
  playing: false,
  playhead: 0,
  playStartTL: 0,
  loop: null,
  loopOn: true,
  selectedIds: [],
  // —— 播放期调度状态 ——
  segments: [],
  scheduled: [],
  scheduledUntil: 0,
  loopAnchorCtx: 0,
  loopCycle: 0,
  timer: null,
};

const $ = s => document.querySelector(s);
const eng = () => store.eng;
/* UMD 模块把函数挂到全局；浏览器与 Node 测试同一份代码 */
function hashBytesRef(b) { return globalThis.hashBytes(b); }
function newClipId() { return globalThis.genClipId(); }

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

/* ================= 历史/存储 适配 ================= */

/* 所有真实编辑的唯一入口：预览中禁止编辑；落盘由 store FIFO 排队 */
function commit(patch, opts) {
  if (previewDoc) return null;
  const r = store.commit(patch, opts);
  afterEdit();
  return r;
}

function docClips() { return doc().clips; }
function projectEnd() {
  return docClips().reduce((m, c) => Math.max(m, c.offset + c.duration), 0);
}
function timelineWidth() { return Math.max(60, projectEnd() + 30) * state.pps; }

function colorFor(id) {
  let s = 0; for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  return palette[s % palette.length];
}
function isMissing(c) {
  const m = doc().media[c.mediaHash];
  return !c.buffer || (m && (m.missing || m.corrupt));
}

/* 根据当前文档重建全部运行时片段与 DOM（切换分支/撤销/重做/恢复后调用） */
function rebuildClips(preservePlay) {
  $('#lanes').innerHTML = '';
  state.clips = [];
  for (const dc of docClips()) {
    const clip = { ...dc, buffer: buffers.get(dc.mediaHash) || null };
    clip.color = colorFor(clip.id);
    state.clips.push(clip);
    buildClipDom(clip);
  }
  if (state.selectedIds.some(id => !docClips().find(c => c.id === id))) {
    state.selectedIds = state.selectedIds.filter(id => docClips().find(c => c.id === id));
  }
  state.loop = doc().loop ? { ...doc().loop } : null;
  state.loopOn = doc().loopOn !== false;
  layout();
  refreshSelectionUI();
  if (!preservePlay && state.playing) { /* 播放中允许重建，但保守起见停止旧源 */ stopSources(); }
  drawAllWaves();
}

function drawAllWaves() { for (const c of state.clips) if (c.buffer) drawWave(c); }

function clipById(id) { return state.clips.find(c => c.id === id); }

function endOffsetForNew() {
  const e = projectEnd();
  return e ? e + 0.25 : 0;
}

/* 导入/测试音：写素材字节（按哈希去重，历史里永不重复保存音频）+ 历史提交 */
async function importFile(file) {
  ensureCtx();
  const ab = await file.arrayBuffer();
  let buf;
  try { buf = await ctx.decodeAudioData(ab.slice(0)); }
  catch (e) { toast('无法解码: ' + file.name, 'err'); return; }
  const bytes = new Uint8Array(ab);
  const hash = hashBytesRef(bytes);
  const mediaAdded = await store.putMedia(hash, bytes); // true=新写入；false=同哈希已存在
  const clipData = {
    id: newClipId(), name: file.name, mediaHash: hash,
    duration: buf.duration, offset: endOffsetForNew(),
    gain: 1, fadeIn: 0, fadeOut: 0,
  };
  buffers.set(hash, buf);
  addClipFromData(clipData, hash, {
    name: file.name, size: bytes.length, type: file.type || '',
    duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate,
  }, mediaAdded);
}

/* 测试音：合成后编码成 WAV 字节，同样进素材库（刷新后可解码恢复） */
function addDemo() {
  ensureCtx();
  const sr = ctx.sampleRate, dur = 2;
  const freqs = [440, 523.25, 659.25];
  const f = freqs[state.clips.length % 3];
  const buf = ctx.createBuffer(1, sr * dur, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * f * i / sr) * 0.8;
  const bytes = encodeMonoPcm16Wav(d, sr);
  const hash = hashBytesRef(bytes);
  const name = `测试音 ${Math.round(f)}Hz.wav`;
  const clipData = {
    id: newClipId(), name, mediaHash: hash,
    duration: dur, offset: endOffsetForNew(), gain: 1, fadeIn: 0, fadeOut: 0,
  };
  store.putMedia(hash, bytes).then(() => {}, () => {});
  buffers.set(hash, buf);
  addClipFromData(clipData, hash, {
    name, size: bytes.length, type: 'audio/wav', duration: dur, channels: 1, sampleRate: sr,
  }, true);
}

/* 一次导入 = 素材登记 + 片段新增，作为同一个可撤销操作 */
function addClipFromData(clipData, hash, meta, mediaIsNew) {
  if (previewDoc) return;
  const patch = [];
  if (mediaIsNew && !doc().media[hash]) patch.push({ op: 'mediaAdd', m: { hash, ...meta } });
  patch.push({ op: 'add', clip: clipData });
  const r = commit(patch, { label: '导入 ' + clipData.name });
  // commit 后运行时同步 DOM
  syncNewClip(r);
}

function syncNewClip(r) {
  if (!r || r.merged) { rebuildClips(); return; }
  // 找到文档里有、运行时尚未建 DOM 的片段（新增补丁里的）
  const have = new Set(state.clips.map(c => c.id));
  for (const d of docClips()) {
    if (!have.has(d.id)) {
      const clip = { ...d, buffer: buffers.get(d.mediaHash) || null, color: colorFor(d.id) };
      state.clips.push(clip);
      buildClipDom(clip);
      if (clip.buffer) drawWave(clip);
    }
  }
  layout();
  selectOnly(docClips().length ? docClips()[docClips().length - 1].id : null);
}

function buildClipDom(clip) {
  const el = document.createElement('div');
  el.className = 'clip' + (isMissing(clip) ? ' missing' : '');
  el.style.background = clip.color + '55';
  el.style.borderColor = clip.color;
  const wave = document.createElement('canvas'); wave.className = 'wave';
  const fi = document.createElement('div'); fi.className = 'fade fade-in';
  const fo = document.createElement('div'); fo.className = 'fade fade-out';
  const hi = document.createElement('div'); hi.className = 'handle hi';
  const ho = document.createElement('div'); ho.className = 'handle ho';
  const label = document.createElement('span'); label.className = 'label';
  label.textContent = clip.name + (isMissing(clip) ? '（素材缺失）' : '');
  el.appendChild(wave); el.appendChild(fi); el.appendChild(fo);
  el.appendChild(hi); el.appendChild(ho); el.appendChild(label);
  clip.el = el;
  clip.els = { wave, fi, fo, hi, ho };
  $('#lanes').appendChild(el);

  // 点选：Shift=区间选 / Ctrl=增减选 / 普通=单选
  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('handle')) return;
    handleSelect(e, clip.id);
    if (e.shiftKey || e.ctrlKey || e.metaKey) return; // 多选时不拖动
    beginMoveGesture(e, clip);
  });
  bindFadeHandle(clip.els.hi, clip, 'fadeIn');
  bindFadeHandle(clip.els.ho, clip, 'fadeOut');
}

function handleSelect(e, id) {
  if (e.ctrlKey || e.metaKey) {
    if (state.selectedIds.includes(id)) state.selectedIds = state.selectedIds.filter(x => x !== id);
    else state.selectedIds.push(id);
  } else if (e.shiftKey && state.selectedIds.length) {
    const ids = docClips().map(c => c.id);
    const a = ids.indexOf(state.selectedIds[state.selectedIds.length - 1]);
    const b = ids.indexOf(id);
    state.selectedIds = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
  } else {
    state.selectedIds = [id];
  }
  refreshSelectionUI();
}

function selectOnly(id) {
  state.selectedIds = id ? [id] : [];
  refreshSelectionUI();
}

/* ---------- 移动：整次拖动 = 一个可撤销操作（合并提交） ---------- */

function beginMoveGesture(e, clip) {
  const el = clip.el;
  const startX = e.clientX;
  const moved = new Map(); // id -> 起始 offset
  const targets = state.selectedIds.includes(clip.id) && state.selectedIds.length > 1
    ? state.clips.filter(c => state.selectedIds.includes(c.id))
    : [clip];
  for (const c of targets) moved.set(c.id, c.offset);
  el.setPointerCapture(e.pointerId);
  let did = false;
  let firstMove = true;

  const move = ev => {
    const dt = (ev.clientX - startX) / state.pps;
    for (const c of targets) {
      const v = Math.max(0, Math.round((moved.get(c.id) + dt) * 1000) / 1000);
      c.offset = v; // 只更新运行时视图；文档由 commit 统一改
      if (state.playing) killPendingForClip(c.id);
    }
    layout();
    if (targets.length === 1) {
      // 一次拖动 = 一个可撤销操作：第一次移动建新节点（不跨手势合并），其后合并
      commit([{ op: 'update', id: clip.id, set: { offset: targets[0].offset }, old: { offset: moved.get(clip.id) } }],
        { coalesceWithLast: !firstMove, label: '移动片段' });
      firstMove = false;
      did = true;
    } else {
      if (!did) did = 'multi'; // 多片段：pointerup 一次性提交
    }
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    if (did === 'multi') {
      const patch = [];
      for (const c of targets) {
        patch.push({ op: 'update', id: c.id, set: { offset: c.offset }, old: { offset: moved.get(c.id) } });
      }
      if (targets.some(c => Math.abs(c.offset - moved.get(c.id)) > 1e-9)) {
        commit(patch, { label: '批量移动 ' + targets.length + ' 个片段' });
      }
    }
    for (const c of targets) rescheduleClipNow(c);
    refreshPanel();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

/* ---------- 淡化柄：整次拖动 = 一个可撤销操作 ---------- */

function bindFadeHandle(handle, clip, key) {
  handle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    selectOnly(clip.id);
    const startX = e.clientX, startFade = clip[key];
    handle.setPointerCapture(e.pointerId);
    let firstMove = true;
    const move = ev => {
      const d = (ev.clientX - startX) / state.pps;
      const v = key === 'fadeIn' ? startFade + d : startFade - d;
      const val = Math.min(clip.duration, Math.max(0, Math.round(v * 1000) / 1000));
      clip[key] = val; // 运行时视图；文档由 commit 改
      updateFades(clip);
      // 第一次移动建新节点（不跨手势合并），其后合并；old 锁定为手势起始值
      commit([{ op: 'update', id: clip.id, set: { [key]: val }, old: { [key]: startFade } }],
        { coalesceWithLast: !firstMove, label: key === 'fadeIn' ? '调淡入' : '调淡出' });
      firstMove = false;
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

/* 泳道分配 */
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
    c.el.classList.toggle('missing', isMissing(c));
    c.el.querySelector('.label').textContent = c.name + (isMissing(c) ? '（素材缺失）' : '');
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
  if (!clip.buffer) return;
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

/* 删除：单个或批量都在一个补丁里 = 一次撤销 */
function deleteClips(ids) {
  const patch = [];
  for (const id of ids) {
    const dc = doc().clips.find(c => c.id === id);
    if (!dc) continue;
    stopSourcesForClip(id);
    patch.push({ op: 'remove', id, clip: JSON.parse(JSON.stringify(dc)) });
  }
  if (!patch.length) return;
  commit(patch, { label: ids.length > 1 ? `批量删除 ${ids.length} 个片段` : '删除片段' });
  rebuildClips();
  selectOnly(null);
}

function stopSourcesForClip(id) {
  state.scheduled = state.scheduled.filter(e => {
    if (e.clipId === id) { try { e.src.stop(); } catch (_) {} return false; }
    return true;
  });
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

/* 标尺交互：单击=定位；拖动=框选循环区。整个拖框 = 一个撤销操作（pointerup 提交） */
$('#ruler').addEventListener('pointerdown', e => {
  const ruler = $('#ruler');
  ruler.setPointerCapture(e.pointerId);
  const tOf = ev => {
    const r = ruler.getBoundingClientRect();
    return Math.max(0, (ev.clientX - r.left) / state.pps);
  };
  const t0 = tOf(e);
  let moved = false; let draft = null;
  const move = ev => {
    const t1 = tOf(ev);
    if (!moved && Math.abs(t1 - t0) * state.pps < 4) return;
    moved = true;
    draft = { a: Math.min(t0, t1), b: Math.max(t0, t1) };
    state.loop = draft;
    renderRuler(); renderLoopRegion();
  };
  const up = ev => {
    ruler.removeEventListener('pointermove', move);
    ruler.removeEventListener('pointerup', up);
    if (!moved) { seek(tOf(ev)); return; }
    let a = snapSec(draft.a), b = snapSec(draft.b);
    if (b - a < 1 / ctx.sampleRate) b = a + 1 / ctx.sampleRate;
    const old = doc().loop ? { ...doc().loop } : null;
    state.loop = { a, b }; state.loopOn = true;
    commit([{ op: 'loop', new: { a, b }, old }], { label: '设置循环区间' });
    updateLoopUI(); renderRuler();
    fillExportRange(a, b);
  };
  ruler.addEventListener('pointermove', move);
  ruler.addEventListener('pointerup', up);
});

/* ================= 播放引擎（与历史无关，读 state.clips） ================= */

function effectiveLoop() {
  return (state.loop && state.loopOn && state.loop.b - state.loop.a > 0) ? state.loop : null;
}

function beginPlayback(from) {
  stopSources();
  state.segments = [];
  state.scheduled = [];
  const startCtx = ctx.currentTime + 0.08;
  state.playStartTL = from;
  const loop = effectiveLoop();
  if (loop && from < loop.b) {
    state.segments.push({ tlStart: from, ctxStart: startCtx, tlEnd: loop.b });
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

function scheduleClipInSeg(clip, tlFrom, tlTo, seg) {
  if (!clip.buffer) return; // 缺失/损坏素材：静默跳过，其余片段照常播放
  const cs = clip.offset, ce = cs + clip.duration;
  const s = Math.max(cs, tlFrom), e = Math.min(ce, tlTo);
  if (e - s <= 0.0005) return;
  const when = seg.ctxStart + (s - seg.tlStart);
  const src = ctx.createBufferSource();
  src.buffer = clip.buffer;
  const g = ctx.createGain();
  applyEnvelope(g.gain, clip, when, s, e);
  src.connect(g).connect(master);
  src.start(when, s - cs, e - s);
  state.scheduled.push({ clipId: clip.id, src, gain: g, whenCtx: when, endCtx: when + (e - s) });
}

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

function rescheduleClipNow(clip) {
  if (!state.playing || !ctx || !clip.buffer) return;
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
    if (seg === last && s >= state.scheduledUntil - 1e-9) continue;
    scheduleClipInSeg(clip, s, e, seg);
  }
}

function stopSources() {
  for (const e of state.scheduled) { try { e.src.stop(); } catch (_) {} }
  state.scheduled = [];
}

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
  if (previewDoc) return; // 预览只读视图，不允许播放（避免与工作状态的调度混淆）
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
  if (state.playing) { beginPlayback(t); schedulerTick(); }
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

/* ================= 面板 / 选择 ================= */

function refreshSelectionUI() {
  for (const c of state.clips) c.el.classList.toggle('selected', state.selectedIds.includes(c.id));
  refreshPanel();
}

function refreshPanel() {
  const n = state.selectedIds.length;
  $('#selCount').textContent = n > 1 ? `（已选 ${n}）` : '';
  const clip = n === 1 ? clipById(state.selectedIds[0]) : null;
  $('#panelEmpty').hidden = !!clip || n > 1;
  $('#panelBody').hidden = !clip && n <= 1;
  $('#multiBox').hidden = n < 2;
  if (n > 1) { $('#multiN').textContent = n; }
  if (!clip) {
    $('#missingBox').hidden = true;
    return;
  }
  $('#pName').textContent = clip.name;
  $('#pPos').value = clip.offset.toFixed(3);
  $('#pGain').value = clip.gain;
  $('#pGainVal').textContent = clip.gain.toFixed(2);
  $('#pFadeIn').value = clip.fadeIn;
  $('#pFadeOut').value = clip.fadeOut;
  $('#missingBox').hidden = !isMissing(clip);
}

function selectedClips() { return state.selectedIds.map(clipById).filter(Boolean); }
function commitParam(id, key, value, label, coalesce) {
  const dc = doc().clips.find(c => c.id === id);
  if (!dc) return;
  const old = dc[key];
  if (old === value) return;
  dc[key] = value;
  const rt = clipById(id); if (rt) rt[key] = value;
  commit([{ op: 'update', id, set: { [key]: value }, old: { [key]: old } }],
    { label: label || '修改片段', coalesceWithLast: !!coalesce });
}

$('#pPos').addEventListener('change', () => {
  const c = selectedClips()[0]; if (!c) return;
  const v = Math.max(0, parseFloat($('#pPos').value) || 0);
  commitParam(c.id, 'offset', v, '移动片段', false);
  const clip = clipById(c.id); layout(); rescheduleClipNow(clip);
});
/* 滑杆手势边界：每次「指针按下→松开」是一个可撤销操作。
   手势内第一次 input 建新节点，后续 input 合并进该节点；
   松手后或键盘/步进（无 pointerdown）的调节各自独立成步。 */
function bindSliderGesture(inputEl, onInput) {
  let dragging = false, fired = false;
  inputEl.addEventListener('pointerdown', () => { dragging = true; fired = false; });
  const end = () => { dragging = false; fired = false; };
  inputEl.addEventListener('pointerup', end);
  inputEl.addEventListener('pointercancel', end);
  inputEl.addEventListener('blur', end);
  inputEl.addEventListener('input', () => {
    const coalesce = dragging && fired; // 手势内除第一次外都合并
    fired = true;
    onInput(coalesce);
  });
}

bindSliderGesture($('#pGain'), coalescing => {
  const c = selectedClips()[0];
  if (!c) return;
  const v = parseFloat($('#pGain').value);
  $('#pGainVal').textContent = v.toFixed(2);
  commitParam(c.id, 'gain', v, '调节增益', coalescing);
  rescheduleClipNow(c);
});
$('#pFadeIn').addEventListener('change', () => {
  const c = selectedClips()[0]; if (!c) return;
  const v = Math.min(c.duration, Math.max(0, parseFloat($('#pFadeIn').value) || 0));
  commitParam(c.id, 'fadeIn', v, '调淡入', false);
  updateFades(clipById(c.id)); rescheduleClipNow(clipById(c.id)); refreshPanel();
});
$('#pFadeOut').addEventListener('change', () => {
  const c = selectedClips()[0]; if (!c) return;
  const v = Math.min(c.duration, Math.max(0, parseFloat($('#pFadeOut').value) || 0));
  commitParam(c.id, 'fadeOut', v, '调淡出', false);
  updateFades(clipById(c.id)); rescheduleClipNow(clipById(c.id)); refreshPanel();
});
$('#pDelete').addEventListener('click', () => {
  if (state.selectedIds.length) deleteClips(state.selectedIds.slice());
});

/* ---------- 批量 ---------- */

bindSliderGesture($('#mGain'), coalescing => {
  const ids = state.selectedIds.slice();
  const v = parseFloat($('#mGain').value);
  // 每个原子的 old 取当前值；手势内除第一次外合并（以首帧 old 为准），
  // 因此整次批量拖动是一个可撤销操作、撤销回到手势起始值。
  const patch = ids.map(id => {
    const dc0 = doc().clips.find(c => c.id === id);
    const start = dc0.gain;
    const rt = clipById(id); if (rt) rt.gain = v;
    return { op: 'update', id, set: { gain: v }, old: { gain: start } };
  });
  commit(patch, { label: `批量增益 ${ids.length} 个片段`, coalesceWithLast: coalescing });
  for (const id of ids) rescheduleClipNow(clipById(id));
});
$('#mDelete').addEventListener('click', () => deleteClips(state.selectedIds.slice()));

/* ================= 撤销 / 重做 / 分支跳转后统一重建 ================= */

function afterEdit() {
  // 提交只改了文档；这里把运行时视图对齐（轻量同步参数，新增/删除走重建）
  syncRuntimeFromDoc();
  refreshHistoryPanels();
  updateUndoButtons();
  updateStatusSave();
}

/* 低成本对齐：参数变化直接同步；增删导致数量变化才整体重建 DOM */
function syncRuntimeFromDoc() {
  const docs = docClips();
  if (docs.length !== state.clips.length) { rebuildClips(); return; }
  let orderChanged = false;
  for (let i = 0; i < docs.length; i++) if (docs[i].id !== state.clips[i].id) orderChanged = true;
  if (orderChanged) { rebuildClips(); return; }
  for (const dc of docs) {
    const rt = clipById(dc.id);
    if (!rt) { rebuildClips(); return; }
    Object.assign(rt, {
      name: dc.name, mediaHash: dc.mediaHash, duration: dc.duration, offset: dc.offset,
      gain: dc.gain, fadeIn: dc.fadeIn, fadeOut: dc.fadeOut,
      buffer: buffers.get(dc.mediaHash) || null,
    });
  }
  state.loop = doc().loop ? { ...doc().loop } : null;
  state.loopOn = doc().loopOn !== false;
  layout();
  drawAllWaves();
  refreshPanel();
  updateLoopUI();
}

function doUndo() {
  if (previewDoc || !globalThis.historyCanUndo()) return;
  globalThis.historyUndo();
  postNavigation();
}
function doRedo() {
  if (previewDoc || !globalThis.historyCanRedo()) return;
  globalThis.historyRedo();
  postNavigation();
}
function postNavigation() {
  rebuildClips();
  store.persistPosition('撤销/重做');
  refreshHistoryPanels();
  updateUndoButtons();
  updateStatusSave();
}

/* ================= 分支 ================= */

function refreshBranchSelect() {
  const sel = $('#branchSel');
  const list = globalThis.historyBranches();
  sel.innerHTML = '';
  for (const b of list) {
    const o = document.createElement('option');
    o.value = b.id; o.textContent = b.name + (b.id === 'b-main' ? '' : ' ⑂');
    if (b.current) o.selected = true;
    sel.appendChild(o);
  }
}
$('#branchSel').addEventListener('change', () => {
  const id = $('#branchSel').value;
  globalThis.historySwitchBranch(id);
  rebuildClips();
  store.persistPosition('切换分支');
  refreshHistoryPanels();
  updateUndoButtons();
  toast('已切换到分支：' + eng().branches[id].name);
});
$('#btnNewBranch').addEventListener('click', () => {
  const name = prompt('新分支名称（从当前状态分叉）', '分支 ' + new Date().toLocaleTimeString());
  if (name === null) { refreshBranchSelect(); return; }
  const b = globalThis.historyFork(name, false);
  globalThis.historySwitchBranch(b.id);
  rebuildClips();
  store.persistMeta('newBranch', { ...b }, '新建分支 ' + name);
  refreshHistoryPanels();
  toast('已创建并切换到分支：' + name);
});

/* ================= 检查点 ================= */

$('#btnCp').addEventListener('click', () => {
  const name = $('#cpName').value.trim() || ('检查点 ' + new Date().toLocaleString());
  const cp = globalThis.historyCheckpoint(name);
  store.persistMeta('checkpoint', { ...cp }, '创建检查点 ' + name);
  $('#cpName').value = '';
  refreshHistoryPanels();
  toast('已创建检查点：' + name);
});

function refreshCheckpoints() {
  const box = $('#checkpoints');
  box.innerHTML = '';
  const cps = Object.values(eng().checkpoints).sort((a, b) => b.time - a.time);
  if (!cps.length) { box.innerHTML = '<div class="muted" style="font-size:12px">还没有检查点</div>'; return; }
  for (const cp of cps) {
    const row = document.createElement('div');
    row.className = 'cp';
    const nm = document.createElement('span'); nm.className = 'cpname';
    nm.textContent = cp.name + (cp.dangling ? '（节点已丢失）' : '');
    row.appendChild(nm);
    const mk = (txt, fn, title) => {
      const b = document.createElement('button'); b.textContent = txt; b.title = title || '';
      b.addEventListener('click', fn); row.appendChild(b); return b;
    };
    if (!cp.dangling) {
      mk('比较/预览', () => previewCheckpoint(cp), '把检查点状态与当前比较并预览（不改动工程）');
      mk('恢复为新分支', () => restoreCheckpoint(cp), '从检查点拉出一条新分支，原分支保留');
    }
    mk('重命名', () => {
      const n = prompt('检查点新名称', cp.name);
      if (!n) return;
      globalThis.historyRenameCheckpoint(cp.id, n);
      store.persistMeta('renameCheckpoint', { id: cp.id, name: n }, '重命名检查点');
      refreshHistoryPanels();
    });
    mk('删除', () => {
      globalThis.historyRemoveCheckpoint(cp.id);
      store.persistMeta('removeCheckpoint', { id: cp.id }, '删除检查点');
      refreshHistoryPanels();
    });
    box.appendChild(row);
  }
}

/* 预览：在独立文档上构建只读视图，与当前状态做新增/删除/参数变化比较。
   绝不写回 eng().doc，退出即丢弃，播放也不经过它。 */
let previewCp = null; // 当前预览对应的检查点（用引用，避免重名误匹配）
function previewCheckpoint(cp) {
  const nodeId = cp.node;
  const preview = globalThis.historyMaterialize(nodeId);
  const diff = globalThis.historyDiff(preview);
  previewDoc = preview;
  previewCp = cp;
  $('#previewBar').hidden = false;
  $('#previewTitle').textContent = '预览检查点：' + cp.name;
  renderDiff($('#previewDiff'), diff);
  // 用预览文档构建临时片段视图（独立 DOM 状态：直接在 lanes 上渲染快照）
  renderPreviewDoc(preview);
  $('#stPreview').hidden = false;
}

function renderDiff(el, d) {
  el.innerHTML = '';
  const sec = t => { const s = document.createElement('div'); s.className = 'd-sec'; s.textContent = t; el.appendChild(s); };
  const line = (cls, txt) => { const s = document.createElement('div'); s.className = cls; s.textContent = txt; el.appendChild(s); };
  if (!d.added.length && !d.removed.length && !d.changed.length && !d.loop) {
    line('d-none', '与当前状态完全相同');
  }
  if (d.added.length) { sec(`新增 ${d.added.length} 个片段（当前有、检查点没有）`); d.added.forEach(c => line('d-add', '＋ ' + c.name)); }
  if (d.removed.length) { sec(`删除 ${d.removed.length} 个片段（检查点有、当前没有）`); d.removed.forEach(c => line('d-del', '－ ' + c.name)); }
  if (d.changed.length) {
    sec(`参数变化 ${d.changed.length} 个片段`);
    for (const ch of d.changed) {
      const parts = Object.entries(ch.fields).map(([k, v]) => {
        const kn = { offset: '位置', gain: '增益', fadeIn: '淡入', fadeOut: '淡出', duration: '长度', name: '名称' }[k] || k;
        return `${kn}: ${fmtParam(k, v.from)} → ${fmtParam(k, v.to)}`;
      });
      line('d-chg', '∿ ' + ch.name + '：' + parts.join('，'));
    }
  }
  if (d.loop) { sec('循环区间'); line('d-chg', d.loop.from ? `${fmt(d.loop.from.a)}–${fmt(d.loop.from.b)}` : '无' + ' → ' + (d.loop.to ? `${fmt(d.loop.to.a)}–${fmt(d.loop.to.b)}` : '无')); }
  if (d.media && d.media.length) {
    sec('素材状态');
    for (const m of d.media) line('d-chg', m.name + '：' + mediaKindText(m));
  }
}
function fmtParam(k, v) { return (k === 'gain') ? Number(v).toFixed(2) : (typeof v === 'number' ? v.toFixed(3) : String(v)); }
function mediaKindText(m) {
  if (m.kind === 'status') return `缺失 ${m.from.missing}→${m.to.missing}，损坏 ${m.from.corrupt}→${m.to.corrupt}`;
  return m.kind;
}

/* 预览视图：临时把运行时片段换成预览文档的快照（DOM 重建）。
   预览期间 state.clips 保持为预览片段，编辑/播放均被禁止，退出时整体重建工作视图。 */
let savedWorkClips = null;
function renderPreviewDoc(doc) {
  if (state.playing) pause();
  savedWorkClips = state.clips;
  $('#lanes').innerHTML = '';
  state.clips = doc.clips.map(dc => ({
    ...dc, buffer: buffers.get(dc.mediaHash) || null, color: colorFor(dc.id),
  }));
  for (const clip of state.clips) {
    buildClipDom(clip);
    if (clip.buffer) drawWave(clip);
  }
  $('#lanes').style.pointerEvents = 'none'; // 预览片段禁用编辑手势
  state.loop = doc.loop ? { ...doc.loop } : null;
  state.loopOn = doc.loopOn !== false;
  layout();
}
function exitPreview() {
  previewDoc = null;
  previewCp = null;
  savedWorkClips = null;
  $('#previewBar').hidden = true;
  $('#stPreview').hidden = true;
  $('#lanes').style.pointerEvents = '';
  rebuildClips();
}
$('#pvExit').addEventListener('click', exitPreview);
$('#pvFork').addEventListener('click', () => {
  // 从当前预览的检查点恢复为一条新分支（原分支完整保留，可随时切回）
  if (previewCp) restoreCheckpoint(previewCp);
  exitPreview();
});

function restoreCheckpoint(cp) {
  const name = (cp.name + ' 恢复 ' + new Date().toLocaleTimeString()).slice(0, 40);
  globalThis.historyRestoreCheckpoint(cp.id, name);
  const nb = eng().branches[eng().branchId];
  rebuildClips();
  // 先登记新分支（重放兜底需要完整分支对象），再记恢复位置
  store.persistMeta('newBranch', { ...nb }, '恢复检查点为新分支 ' + name);
  store.persistMeta('restoreCheckpoint', { id: cp.id, branch: nb.id }, '恢复检查点为新分支');
  refreshHistoryPanels();
  toast(`已从检查点创建并切换到新分支「${name}」，原分支保留，可在分支下拉中切回`);
}

/* ================= 历史列表 ================= */

function refreshHistoryList() {
  const box = $('#historyList');
  box.innerHTML = '';
  const e = eng();
  const br = e.branches[e.branchId];
  // 当前分支链 head → root
  const chain = [];
  let cur = br.head;
  const guard = new Set();
  while (cur && !guard.has(cur)) {
    guard.add(cur); chain.push(cur); cur = e.nodes[cur].parent;
  }
  // 其他分支的末端（提示分叉存在，可切换）
  const otherHeads = Object.values(e.branches).filter(b => b.id !== e.branchId).map(b => b.head);
  chain.forEach((nid, i) => {
    const n = e.nodes[nid];
    const row = document.createElement('div');
    row.className = 'hrow' + (nid === e.current ? ' current' : '');
    if (otherHeads.includes(nid)) row.classList.add('fork-dot');
    const lab = document.createElement('span'); lab.className = 'hl';
    lab.textContent = (nid === 'n0' ? '■ ' : (i === 0 ? '● ' : '○ ')) + (n.label || '编辑');
    row.appendChild(lab);
    const meta = document.createElement('span'); meta.className = 'hmeta';
    const undoable = nid !== br.root || br.id === 'b-main';
    meta.textContent = n.compact ? '已压缩' : '';
    row.appendChild(meta);
    row.addEventListener('click', () => {
      if (previewDoc) return;
      globalThis.historyGoTo(nid);
      rebuildClips();
      store.persistPosition('查看历史');
      refreshHistoryPanels();
      updateUndoButtons();
    });
    box.appendChild(row);
  });
  $('#stPos').textContent = `位置 ${globalThis.historyUndoDepth()} 步前 / 可前进 ${globalThis.historyRedoDepth()} 步`;
}

function refreshHistoryPanels() { refreshBranchSelect(); refreshCheckpoints(); refreshHistoryList(); updateStatusBranch(); }

function updateUndoButtons() {
  $('#btnUndo').disabled = !globalThis.historyCanUndo() || !!previewDoc;
  $('#btnRedo').disabled = !globalThis.historyCanRedo() || !!previewDoc;
}

/* ================= 素材缺失/损坏 与重新关联 ================= */

/* 启动后 / 每次编辑后核对素材可用性，标记缺失（走历史，可撤销、可跨分支）。
   注意：不在这里直接改 doc —— 状态变更必须由 store.commit 统一施加，否则撤销会失效。 */
function reconcileMedia() {
  let changed = false;
  for (const [hash, m] of Object.entries(doc().media)) {
    const shouldMissing = !buffers.has(hash);
    if (!!m.missing !== shouldMissing) {
      const old = { missing: !!m.missing };
      store.commit([{ op: 'mediaStatus', hash, set: { missing: shouldMissing }, old }],
        { label: shouldMissing ? '标记素材缺失' : '素材恢复可用' });
      changed = true;
    }
  }
  if (changed) syncRuntimeFromDoc();
}

$('#btnRelink').addEventListener('click', () => {
  const c = selectedClips()[0];
  if (!c) return;
  relinkTarget = { hashes: [c.mediaHash], clipId: c.id };
  $('#relinkInput').value = '';
  $('#relinkInput').click();
});
$('#relinkInput').addEventListener('change', async ev => {
  const file = ev.target.files[0];
  if (!file || !relinkTarget) return;
  ensureCtx();
  try {
    const ab = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab.slice(0));
    const bytes = new Uint8Array(ab);
    const newHash = hashBytesRef(bytes);
    await store.putMedia(newHash, bytes);
    buffers.set(newHash, buf);
    const oldHashes = relinkTarget.hashes;
    const clipId = relinkTarget.clipId;
    // 一次「重新关联」= 一个原子操作：换 mediaHash、登记新素材元数据、清除缺失标记
    const patch = [];
    if (!doc().media[newHash]) {
      patch.push({
        op: 'mediaAdd', m: {
          hash: newHash, name: file.name, size: bytes.length, type: file.type || '',
          duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate,
        },
      });
    }
    const dc = doc().clips.find(c => c.id === clipId);
    if (dc) patch.push({
      op: 'update', id: clipId,
      set: { mediaHash: newHash, duration: buf.duration },
      old: { mediaHash: oldHashes[0], duration: dc.duration },
    });
    // 新素材健康（旧素材若是缺失/损坏状态，新 hash 的元数据干净）；
    // 若恰好同 hash（重新放回原文件），显式清除缺失/损坏标记
    if (doc().media[newHash] && (doc().media[newHash].missing || doc().media[newHash].corrupt)) {
      patch.push({
        op: 'mediaStatus', hash: newHash,
        set: { missing: false, corrupt: false },
        old: { missing: !!doc().media[newHash].missing, corrupt: !!doc().media[newHash].corrupt },
      });
    }
    commit(patch, { label: '重新关联素材 ' + file.name });
    reconcileMedia();
    rebuildClips();
    selectOnly(clipId);
    toast('素材已重新关联，历史撤销/重做与播放继续可用');
  } catch (e) {
    toast('重新关联失败（无法解码该文件）', 'err');
  } finally {
    relinkTarget = null;
  }
});

/* ================= 工具栏 ================= */

$('#btnImport').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async e => {
  ensureCtx();
  for (const f of e.target.files) { try { await importFile(f); } catch (err) { toast('导入失败: ' + f.name, 'err'); } }
  e.target.value = '';
  reconcileMedia();
});
$('#btnDemo').addEventListener('click', () => {
  ensureCtx(); addDemo(); reconcileMedia();
});

$('#btnPlay').addEventListener('click', play);
$('#btnPause').addEventListener('click', pause);
$('#btnStop').addEventListener('click', stop);
$('#btnUndo').addEventListener('click', doUndo);
$('#btnRedo').addEventListener('click', doRedo);
$('#btnLoop').addEventListener('click', () => {
  const next = !state.loopOn;
  state.loopOn = next;
  commit([{ op: 'loopOn', new: next, old: !next }], { label: next ? '打开循环' : '关闭循环' });
  updateLoopUI();
});
$('#btnClearLoop').addEventListener('click', () => {
  if (!doc().loop) return;
  const old = { ...doc().loop };
  state.loop = null;
  commit([{ op: 'loop', new: null, old }], { label: '清除循环区间' });
  updateLoopUI(); renderRuler();
});
$('#zoom').addEventListener('input', e => {
  state.pps = parseInt(e.target.value, 10);
  layout();
  for (const c of state.clips) drawWave(c);
});

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    e.shiftKey ? doRedo() : doUndo();
    return;
  }
  if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
    e.preventDefault();
    state.playing ? pause() : play();
  }
});

/* ================= 保存状态 / 提示 ================= */

function updateStatusSave(st) {
  const el = $('#stSave');
  const d = store.state.degraded;
  if (d) { el.textContent = '持久化不可用（本次会话有效）'; el.className = 'offline'; return; }
  if (store.dirty()) { el.textContent = '保存中…'; el.className = 'saving'; }
  else { el.textContent = '已保存'; el.className = 'saved'; }
  const fails = store.state && store.status ? store.status().failures : [];
  if (fails && fails.length) { $('#stMsg').textContent = fails[fails.length - 1]; }
  else $('#stMsg').textContent = '';
}

/* 状态栏：当前分支 + 可撤销/重做范围 */
function updateStatusBranch() {
  const e = eng();
  const br = e.branches[e.branchId];
  $('#stBranch').innerHTML = '';
  const icon = document.createElement('b');
  icon.textContent = '🌿 ' + (br ? br.name : '?') + (previewDoc ? '（预览）' : '');
  $('#stBranch').appendChild(icon);
  const ud = globalThis.historyUndoDepth ? globalThis.historyUndoDepth() : 0;
  const rd = globalThis.historyRedoDepth ? globalThis.historyRedoDepth() : 0;
  $('#stUndo').textContent = `可撤销 ${ud} 步 · 可重做 ${rd} 步`;
  $('#btnUndo').disabled = ud === 0 || !!previewDoc;
  $('#btnRedo').disabled = rd === 0 || !!previewDoc;
}
let toastTimer = null;
function toast(msg, cls) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.className = cls || '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('beforeunload', e => {
    if (store && store.dirty()) { e.preventDefault(); e.returnValue = '还有操作正在保存，确定现在离开吗？'; return e.returnValue; }
  });
}

/* ================= WAV 导出（沿用任务化实现，快照取运行时缓冲） ================= */

const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const TASK_STATE_TEXT = { pending: '等待', running: '进行中', canceled: '已取消', failed: '失败', done: '已完成' };

let taskSeq = 1;
const exportTasks = [];
let runningTask = null;

function takeSnapshot(a, b) {
  const clips = [];
  for (const c of state.clips) {
    if (!c.buffer) continue;
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
  return { sampleRate: parseInt($('#xRate').value, 10), channels: parseInt($('#xCh').value, 10), bitDepth: $('#xBits').value };
}
function fillExportRange(a, b) { $('#xStart').value = a.toFixed(3); $('#xEnd').value = b.toFixed(3); updateExportInfo(); }
function updateExportInfo() {
  const a = parseFloat($('#xStart').value), b = parseFloat($('#xEnd').value);
  const el = $('#xInfo');
  el.classList.remove('over');
  if (!isFinite(a) || !isFinite(b) || a < 0 || b <= a) { el.textContent = ''; return; }
  const spec = readExportSpec();
  const frames = Math.round((b - a) * spec.sampleRate);
  const bytes = 44 + frames * bytesPerFrame(spec);
  el.textContent = `预计 ${frames.toLocaleString()} 采样 · 约 ${fmtBytes(bytes)}`;
  if (bytes > MAX_EXPORT_BYTES) { el.textContent += `（超过上限 ${fmtBytes(MAX_EXPORT_BYTES)}）`; el.classList.add('over'); }
}

function enqueueExport(snap, spec) {
  const fp = snapshotFingerprint(snap, spec);
  const dup = exportTasks.find(t => t.fingerprint === fp &&
    (t.state === 'pending' || t.state === 'running' || t.state === 'done'));
  if (dup) { flashTask(dup); return dup; }
  const task = {
    id: taskSeq++, fingerprint: fp, snap, spec,
    state: 'pending', progress: 0, error: '',
    blobUrl: '', blobSize: 0, cancelRequested: false,
    frames: Math.round((snap.b - snap.a) * spec.sampleRate), els: null,
  };
  exportTasks.unshift(task);
  buildTaskDom(task);
  const estBytes = 44 + task.frames * bytesPerFrame(spec);
  if (!(task.frames > 0)) failTask(task, '导出区间无效');
  else if (estBytes > MAX_EXPORT_BYTES) {
    failTask(task, `预计文件约 ${fmtBytes(estBytes)}，超过单次导出上限 ${fmtBytes(MAX_EXPORT_BYTES)}`);
  }
  updateTaskUI(task);
  pumpQueue();
  return task;
}
function failTask(task, msg) { task.state = 'failed'; task.error = msg; }
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
      onProgress: p => { task.progress = Math.max(task.progress, p); updateTaskProgress(task); },
      yieldControl: () => new Promise(r => setTimeout(r, 0)),
    });
    if (res.canceled) { task.state = 'canceled'; return; }
    const blob = new Blob(res.parts, { type: 'audio/wav' });
    task.blobUrl = URL.createObjectURL(blob);
    task.blobSize = blob.size;
    task.progress = 1;
    task.state = 'done';
  } catch (err) { task.state = 'failed'; task.error = friendlyError(err); }
  finally { updateTaskUI(task); }
}
function cancelTask(task) {
  if (task.state === 'pending') { task.cancelRequested = true; task.state = 'canceled'; updateTaskUI(task); }
  else if (task.state === 'running') { task.cancelRequested = true; }
}
function retryTask(task) {
  if (task.state !== 'failed' && task.state !== 'canceled') return;
  enqueueExport(task.snap, task.spec);
}
function mkDiv(cls) { const d = document.createElement('div'); d.className = cls; return d; }
function buildTaskDom(task) {
  const el = mkDiv('task');
  const head = mkDiv('t-head');
  const title = document.createElement('span'); title.className = 't-title';
  const tstate = document.createElement('span'); tstate.className = 't-state';
  head.appendChild(title); head.appendChild(tstate);
  const bar = mkDiv('t-bar'); const fill = mkDiv('t-fill'); bar.appendChild(fill);
  const meta = mkDiv('t-meta');
  const err = mkDiv('t-err'); err.hidden = true;
  const actions = mkDiv('t-actions');
  el.appendChild(head); el.appendChild(bar); el.appendChild(meta); el.appendChild(err); el.appendChild(actions);
  task.els = { root: el, title, state: tstate, fill, meta, err, actions };
  task.els.title.textContent = `#${task.id}  ${fmt(task.snap.a)} → ${fmt(task.snap.b)} · ${specText(task.spec)}`;
  $('#tasksEmpty').hidden = true;
  $('#tasks').prepend(el);
  updateTaskUI(task);
}
function mkTaskBtn(text, onclick) {
  const b = document.createElement('button'); b.textContent = text; b.addEventListener('click', onclick); return b;
}
function updateTaskUI(task) {
  const e = task.els; if (!e) return;
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
    const a = document.createElement('a');
    a.className = 'dl'; a.textContent = '下载 WAV';
    a.href = task.blobUrl; a.download = downloadName(task);
    e.actions.appendChild(a);
  }
}
function updateTaskProgress(task) {
  const e = task.els; if (!e) return;
  e.fill.style.width = (task.progress * 100) + '%';
  let meta = `${task.frames.toLocaleString()} 采样`;
  if (task.state === 'pending' || task.state === 'running') meta = `${Math.floor(task.progress * 100)}% · ` + meta;
  if (task.state === 'done') meta += ` · ${fmtBytes(task.blobSize)}`;
  e.meta.textContent = meta;
}
function downloadName(task) {
  const { snap, spec } = task;
  return `export_${snap.a.toFixed(3)}s-${snap.b.toFixed(3)}s_` +
    `${spec.sampleRate}Hz_${spec.channels}ch_${spec.bitDepth}.wav`;
}
function flashTask(task) {
  const el = task.els && task.els.root; if (!el) return;
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

$('#btnExport').addEventListener('click', () => {
  const a = parseFloat($('#xStart').value), b = parseFloat($('#xEnd').value);
  if (!isFinite(a) || !isFinite(b) || a < 0 || b <= a) { toast('导出区间无效：请检查起止时间', 'err'); return; }
  enqueueExport(takeSnapshot(a, b), readExportSpec());
});
$('#xUseLoop').addEventListener('click', () => {
  if (!state.loop) { toast('请先在标尺上拖出区间', 'err'); return; }
  fillExportRange(state.loop.a, state.loop.b);
});
$('#xUseAll').addEventListener('click', () => {
  const end = projectEnd();
  if (end <= 0) { toast('时间线上还没有片段', 'err'); return; }
  fillExportRange(0, end);
});
for (const id of ['xStart', 'xEnd', 'xRate', 'xCh', 'xBits']) {
  $('#' + id).addEventListener('input', updateExportInfo);
  $('#' + id).addEventListener('change', updateExportInfo);
}

/* ================= 小工具：测试音 WAV 编码 ================= */

function encodeMonoPcm16Wav(f32, sampleRate) {
  const n = f32.length, bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/* ================= 启动：打开存储 → 恢复素材 → 重建时间线 ================= */

async function boot() {
  let kvPick;
  try {
    if (globalThis.createDefaultKV) kvPick = await globalThis.createDefaultKV('audio-timeline');
    else kvPick = { kv: null, degraded: true, reason: '无 KV 工厂' };
  } catch (e) { kvPick = { kv: null, degraded: true, reason: String(e) }; }
  if (!kvPick.kv) {
    kvPick = { kv: globalThis.memAsyncKV ? globalThis.memAsyncKV() : globalThis.memKV(), degraded: true };
  }

  store = globalThis.createStore({
    H: globalThis, W: globalThis,
    wal: globalThis.createWAL(kvPick.kv),
    degraded: kvPick.degraded, degradeReason: kvPick.reason,
  });
  const rec = await store.open();

  // 历史薄封装（浏览器与 Node 桩统一经 globalThis 访问 UMD 导出的核心函数）
  const hApi = {
    historyCanUndo: () => canUndo(store.eng),
    historyCanRedo: () => canRedo(store.eng),
    historyUndo: () => undo(store.eng),
    historyRedo: () => redo(store.eng),
    historyUndoDepth: () => undoDepth(store.eng),
    historyRedoDepth: () => redoDepth(store.eng),
    historyBranches: () => branchesList(store.eng),
    historySwitchBranch: id => switchBranch(store.eng, id),
    historyFork: name => forkBranch(store.eng, name),
    historyCheckpoint: name => createCheckpoint(store.eng, name),
    historyRenameCheckpoint: (id, name) => renameCheckpoint(store.eng, id, name),
    historyRemoveCheckpoint: id => removeCheckpoint(store.eng, id),
    historyRestoreCheckpoint: (id, name) => restoreCheckpointAsBranch(store.eng, id, name),
    historyGoTo: nid => goToNode(store.eng, nid),
    historyMaterialize: nid => materialize(store.eng, nid),
    historyDiff: previewDoc => diffDocs(previewDoc, doc()),
  };
  Object.assign(globalThis, hApi);

  // 恢复素材字节 → AudioBuffer（素材表有什么就尝试取什么；取不到=缺失，解码失败=损坏）
  ensureCtx();
  const missingHashes = new Set();
  const corruptHashes = new Set();
  const hashes = Object.keys(doc().media);
  await Promise.all(hashes.map(async hash => {
    let bytes;
    try { bytes = await store.getMedia(hash); }
    catch (e) { missingHashes.add(hash); return; }
    if (!bytes) { missingHashes.add(hash); return; } // 字节缺失（如外部清理）
    try {
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buf = await ctx.decodeAudioData(ab);
      buffers.set(hash, buf);
    } catch (e) {
      corruptHashes.add(hash); // 解码失败 = 内容损坏
    }
  }));
  // 缺失/损坏标记走历史（单节点批量标记，可撤销、可跨分支、刷新后不丢）
  const patch = [];
  for (const hash of missingHashes) {
    const m = doc().media[hash];
    if (m && !m.missing) patch.push({ op: 'mediaStatus', hash, set: { missing: true }, old: { missing: false } });
  }
  for (const hash of corruptHashes) {
    const m = doc().media[hash];
    if (!m || (m.missing && m.corrupt)) continue;
    const set = { missing: true }, old = { missing: !!m.missing };
    if (!m.corrupt) { set.corrupt = true; old.corrupt = false; }
    patch.push({ op: 'mediaStatus', hash, set, old });
  }
  if (patch.length) store.commit(patch, { label: `恢复：标记 ${patch.length} 个素材缺失/损坏` });

  rebuildClips();
  refreshHistoryPanels();
  updateUndoButtons();
  updateStatusSave();
  store.onStatus(() => { updateStatusSave(); refreshHistoryPanels(); });

  // 恢复问题 / 丢失操作明确告知
  if (rec.problems.length) {
    toast('恢复报告：' + rec.problems[0] + (rec.problems.length > 1 ? `（等 ${rec.problems.length} 条）` : ''), 'warn');
    console.warn('[恢复]', rec.problems);
  }
  if (store.state.degraded) toast('IndexedDB 不可用，已降级为内存存储：本次编辑刷新后不会保留', 'warn');
}

function storeHashes() { return Object.keys(doc().media); }

/* ---------- 非浏览器（Node 测试桩）下不自动启动 ---------- */

const IN_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined' &&
  typeof window.addEventListener === 'function';
const IN_NODE_TEST = !IN_BROWSER && typeof module !== 'undefined';

if (IN_BROWSER) {
  /* 启动前使用 PREBOOT_DOC */
  layout();
  updateLoopUI();
  requestAnimationFrame(tickPlayhead);
  boot().catch(err => {
    console.error('启动失败', err);
    toast('历史恢复启动失败：' + (err.message || err), 'err');
  });
}

/* Node 集成测试引导：内存 KV + 显式建立存储（不自动跑浏览器界面） */
async function bootAppForTest() {
  await boot();
  return store;
}
/* 测试用：在全新的内存 KV 上重建存储（干净前提），并重置视图选择/预览 */
async function resetAppForTest() {
  state.selectedIds = [];
  previewDoc = null;
  $('#previewBar').hidden = true;
  $('#stPreview').hidden = true;
  $('#lanes').style.pointerEvents = '';
  const kv = globalThis.memKV ? globalThis.memKV() : globalThis.memAsyncKV();
  store = globalThis.createStore({ H: globalThis, W: globalThis, wal: globalThis.createWAL(kv) });
  buffers = new Map();
  await store.open();
  rebuildClips();
  refreshHistoryPanels();
  updateUndoButtons();
  return store;
}
if (IN_NODE_TEST) { globalThis.bootAppForTest = bootAppForTest; globalThis.resetAppForTest = resetAppForTest; }
