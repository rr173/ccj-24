'use strict';

/* loudness-core.js 单元测试（Node，无 DOM）：
   - K 加权滤波器频响与电平校准（1 kHz / 10 kHz 正弦）
   - 综合响度 / LRA / 短时响度 / 真峰值（含样本间峰值）
   - 混音一致性：重叠相加、增益、淡化（直接用 export-core 的渲染管线）
   - 分段指纹缓存：部分编辑只失效受影响区段
   - 提案：统一增益 / 分段包络 / 限制器；目标与峰值冲突必须如实上报
   - 取消 / 暂停恢复 / CRC 缓存帧 */

const assert = require('assert');
const LC = require('../public/loudness-core.js');
const EC = require('../public/export-core.js');

const {
  PRESETS, ANALYSIS_SR, ANALYSIS_CH, SUB,
  kCoef48, kState, kStep, tpState, tpProcess, buildOversampler,
  createMeasurer, assembleMetrics, planSegments, segmentFingerprint,
  analyzeSegment, hydrateSegment, stashSegment, metricsFromSegments,
  planUniform, planEnvelope, planLimiter, evaluateProposal, renderProcessed,
  encodeSegmentRecord, decodeSegmentRecord, clipFingerprint,
  makeEnvelope, makeLimiter,
} = LC;

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (err) {
    console.error('  FAIL - ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}
/* dBFS 以满量程正弦为 0：峰值幅度 A 的正弦 RMS 电平 = 20log10(A)+3.01；
   要让信号电平（LUFS，K 加权后 1 kHz≈单位增益）为 L，幅度 A = 10^((L-3.01)/20) */
function ampForLevel(lufs) { return Math.pow(10, (lufs + 3.01) / 20); }
const approx = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 0.25),
  `${msg || ''} expected ≈${b}, got ${a}`);

/* ---------- 测试信号 / 混音适配器 ---------- */

function fakeBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length, sampleRate,
    length: channels[0].length, duration: channels[0].length / sampleRate,
    getChannelData(i) { return channels[i]; },
  };
}
function sineBuf(freq, dur, sr, amp, ch) {
  const n = Math.round(dur * sr);
  const chans = [];
  for (let c = 0; c < (ch || 1); c++) {
    const d = new Float32Array(n);
    const f = typeof freq === 'number' ? freq : freq[c];
    for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * f * i / sr) * amp;
    chans.push(d);
  }
  return fakeBuffer(chans, sr);
}
function noiseBuf(dur, sr, amp, seed) {
  let s = seed || 1;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const n = Math.round(dur * sr), d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * amp;
  return fakeBuffer([d], sr);
}
function clip(over) {
  return Object.assign({
    name: 'c', buffer: null, mediaHash: 'h' + (over._hid || 0),
    offset: 0, gain: 1, fadeIn: 0, fadeOut: 0, duration: 0,
  }, over);
}
/* 与 app 相同的快照形状；mediaHash 已在 clip 上给出 */
function snapshot(a, b, clips) { return { a, b, clips }; }

/* renderMix 适配器：直接复用 export-core 的混音/重采样/淡化实现，
   保证「分析反映实际混音中的重叠、增益和淡化」。回调被 await（暂停在块边界生效）。 */
function makeRenderDeps(renderChunkFrames) {
  return {
    renderMix(snap, t0, t1, channels, onChunk, sampleRate) {
      return EC.renderMix(snap, t0, t1, channels, onChunk, sampleRate, {
        chunkFrames: renderChunkFrames || (1 << 15),
        yieldControl: () => Promise.resolve(),
      });
    },
    yieldControl: () => Promise.resolve(),
  };
}

/* 便捷：分析整个快照（默认分段设置，可注入） */
async function analyzeAll(snap, preset, opts) {
  opts = opts || {};
  const deps = opts.deps || makeRenderDeps();
  const plan = planSegments(snap.a, snap.b, { segmentSec: opts.segmentSec || 5 });
  const cache = opts.cache || new Map();
  const segments = [];
  for (const seg of plan) {
    const fp = segmentFingerprint(snap, seg);
    if (cache.has(fp)) { segments.push(hydrateSegment(cache.get(fp))); continue; }
    const r = await LC.analyzeSegment(snap, seg, deps, {});
    assert.strictEqual(r.status, 'done');
    cache.set(fp, stashSegment(r));
    segments.push(hydrateSegment(stashSegment(r)));
  }
  const out = metricsFromSegments(segments, preset);
  out.cache = cache; out.plan = plan; out.deps = deps;
  return out;
}

/* ---------- 滤波器 / 测量基元 ---------- */

function steadyGain(coef, f, sr) {
  const w = 2 * Math.PI * f / sr;
  const z1 = { re: Math.cos(-w), im: Math.sin(-w) };
  const z2 = { re: Math.cos(-2 * w), im: Math.sin(-2 * w) };
  const num = { re: coef.b[0] + coef.b[1] * z1.re + coef.b[2] * z2.re, im: coef.b[1] * z1.im + coef.b[2] * z2.im };
  const den = { re: 1 + coef.a[0] * z1.re + coef.a[1] * z2.re, im: coef.a[0] * z1.im + coef.a[1] * z2.im };
  const m2 = den.re * den.re + den.im * den.im;
  const H = { re: (num.re * den.re + num.im * den.im) / m2, im: (num.im * den.re - num.re * den.im) / m2 };
  return 20 * Math.log10(Math.hypot(H.re, H.im));
}

(async () => {

  await test('K 加权频响：低频陡降、500 Hz≈0、1 kHz≈+0.7、10 kHz≈+4 dB（ffmpeg 同曲线）', () => {
    const [shelf, hpf] = kCoef48();
    const chain = f => steadyGain(shelf, f, 48000) + steadyGain(hpf, f, 48000);
    approx(chain(500), 0.0, 0.15, '500 Hz');
    approx(chain(1000), 0.7, 0.15, '1 kHz');
    approx(chain(10000), 4.0, 0.15, '10 kHz');
    assert.ok(chain(50) < -3, '50 Hz 应明显衰减: ' + chain(50));
    assert.ok(chain(20) < -12, '20 Hz 衰减 > 12 dB: ' + chain(20));
  });

  await test('电平校准：−23 dBFS（RMS）的 997 Hz 正弦 ⇒ −23 LUFS（容差 0.5 LU）', () => {
    const sr = ANALYSIS_SR, n = 5 * sr;
    const amp = Math.pow(10, (-23 + 3.01) / 20); // 峰值幅度：RMS −23 dBFS 的正弦
    const st = kState();
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const y = kStep(st, amp * Math.sin(2 * Math.PI * 997 * i / sr));
      sum += y * y;
    }
    const mz = -0.691 + 10 * Math.log10(sum / n);
    approx(mz, -23, 0.5, '997 Hz 校准');
  });

  /* ---------- 整段测量（经真实混音管线） ---------- */

  await test('整段正弦 −14 dBFS（流媒体目标）：综合 −14、真峰值 ≈ −14、达标', async () => {
    const buf = sineBuf(997, 6, ANALYSIS_SR, ampForLevel(-14));
    const snap = snapshot(0, 6, [clip({ buffer: buf, duration: 6, _hid: 1 })]);
    const { metrics, evaluation } = await analyzeAll(snap, PRESETS.stream);
    approx(metrics.integrated, -14, 0.3, 'integrated');
    approx(metrics.truePeak, -11.0, 0.25, 'truePeak（峰值幅度比 RMS 低 3.01 dB）');
    assert.strictEqual(evaluation.pass, true, JSON.stringify(evaluation.zones));
    assert.strictEqual(evaluation.zones.length, 0);
  });

  await test('过响信号（−14 dBFS vs R128 −23）：不达标且出现 loud 区段', async () => {
    const buf = sineBuf(997, 6, ANALYSIS_SR, ampForLevel(-14));
    const snap = snapshot(0, 6, [clip({ buffer: buf, duration: 6, _hid: 2 })]);
    const { evaluation } = await analyzeAll(snap, PRESETS.r128);
    assert.strictEqual(evaluation.pass, false);
    assert.strictEqual(evaluation.integPass, false);
    assert.ok(evaluation.zones.some(z => z.kind === 'loud'), '应有 loud 区段');
  });

  await test('重叠片段按增益相加：两个同相 −20 dBFS 正弦重叠 ⇒ 综合高约 6 dB', async () => {
    const buf1 = sineBuf(997, 4, ANALYSIS_SR, ampForLevel(-20));
    const buf2 = sineBuf(997, 4, ANALYSIS_SR, ampForLevel(-20));
    const s1 = snapshot(0, 4, [clip({ buffer: buf1, duration: 4, _hid: 3 })]);
    const s2 = snapshot(0, 4, [
      clip({ buffer: buf1, duration: 4, _hid: 3 }),
      clip({ buffer: buf2, duration: 4, offset: 0, _hid: 4 }),
    ]);
    const a = await analyzeAll(s1, PRESETS.stream);
    const b = await analyzeAll(s2, PRESETS.stream);
    approx(b.metrics.integrated, a.metrics.integrated + 6.02, 0.4,
      `单 ${a.metrics.integrated} → 重叠 ${b.metrics.integrated}`);
  });

  await test('淡化被计入：同内容 +10 dB 淡入，前 2 秒短时响度明显低于后段', async () => {
    const buf = sineBuf(997, 6, ANALYSIS_SR, ampForLevel(-14));
    const noFade = snapshot(0, 6, [clip({ buffer: buf, duration: 6, _hid: 5 })]);
    const faded = snapshot(0, 6, [clip({ buffer: buf, duration: 6, fadeIn: 3, _hid: 5 })]);
    const r1 = await analyzeAll(noFade, PRESETS.stream);
    const r2 = await analyzeAll(faded, PRESETS.stream);
    assert.ok(r2.metrics.integrated < r1.metrics.integrated - 1.5,
      `淡入后综合应更低: ${r2.metrics.integrated} vs ${r1.metrics.integrated}`);
    const early = r2.metrics.shortTerm.filter(s => s.t < 1.5).map(s => s.lufs);
    const late = r2.metrics.shortTerm.filter(s => s.t > 4).map(s => s.lufs);
    assert.ok(Math.min(...late) - Math.min(...early) > 6, '淡入期应明显更轻');
  });

  await test('源采样率重采样：22.05k 正弦经混音到 48k 后指标一致', async () => {
    const buf = sineBuf(997, 4, 22050, ampForLevel(-16));
    const snap = snapshot(0, 4, [clip({ buffer: buf, duration: 4, _hid: 6 })]);
    const { metrics } = await analyzeAll(snap, PRESETS.podcast);
    approx(metrics.integrated, -16, 0.5, 'integrated @22.05k src');
  });

  /* ---------- 真峰值 ---------- */

  await test('真峰值：方波（样本峰 −14 dBFS）过采样峰更高，触发 peak 区段', async () => {
    const sr = ANALYSIS_SR, n = sr * 4;
    const d = new Float32Array(n);
    const amp = 0.9; // 样本峰 ≈ -0.9 dBFS；方波过采样峰 > 0 dBFS，必然超 −1 dBTP 上限
    for (let i = 0; i < n; i++) d[i] = (Math.sin(2 * Math.PI * 880 * i / sr) >= 0 ? 1 : -1) * amp;
    const snap = snapshot(0, 4, [clip({ buffer: fakeBuffer([d], sr), duration: 4, _hid: 7 })]);
    const { metrics, evaluation } = await analyzeAll(snap, PRESETS.stream);
    const samplePeak = 20 * Math.log10(amp);
    assert.ok(metrics.truePeak > samplePeak + 0.5,
      `过采样峰应高于样本峰 ${samplePeak.toFixed(1)}: ${metrics.truePeak}`);
    assert.ok(evaluation.zones.some(z => z.kind === 'peak'), '应有 peak 区段');
  });

  await test('过采样器：稳态正弦峰与直流保持（不引入增益偏差）', () => {
    const st = tpState(1);
    const sr = 48000;
    let max = 0;
    for (let i = 0; i < sr; i++) { const fp = tpProcess(st, [0.9 * Math.sin(2 * Math.PI * 1000 * i / sr)]); max = st.max; }
    approx(max, 0.9, 0.005, '正弦');
    // 直流：预热 64 样本越过启动瞬态后，稳态峰应保持
    const st2 = tpState(1);
    let dcMax = 0;
    for (let i = 0; i < 200; i++) { const fp = tpProcess(st2, [0.9]); if (i >= 64) dcMax = Math.max(dcMax, fp); }
    approx(dcMax, 0.9, 0.02, '直流稳态');
  });

  /* ---------- LRA ---------- */

  await test('响度范围：前半 −23 / 后半 −14 的拼接 LRA 显著（约 9 LU）', async () => {
    const sr = ANALYSIS_SR, n = 12 * sr;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const db = i < n / 2 ? -23 : -14;
      d[i] = Math.sin(2 * Math.PI * 330 * i / sr) * Math.pow(10, db / 20);
    }
    const snap = snapshot(0, 12, [clip({ buffer: fakeBuffer([d], sr), duration: 12, _hid: 8 })]);
    const { metrics } = await analyzeAll(snap, PRESETS.r128, { segmentSec: 4 });
    assert.ok(metrics.lra !== null, '12 s 节目应有 LRA');
    assert.ok(metrics.lra > 6 && metrics.lra < 11, `LRA ≈ 9, got ${metrics.lra}`);
  });

  /* ---------- 分段 / 指纹 / 缓存复用 ---------- */

  await test('分段指纹：未触及区段指纹不变；移动/增益/淡化/换素材后变化', () => {
    const bufA = sineBuf(440, 2, 48000, 0.5), bufB = sineBuf(550, 2, 48000, 0.5);
    const c1 = clip({ buffer: bufA, mediaHash: 'A', duration: 2, offset: 0, _hid: 10 });
    const c2 = clip({ buffer: bufB, mediaHash: 'B', duration: 2, offset: 4, _hid: 11 });
    const base = snapshot(0, 10, [c1, c2]);
    const plan = planSegments(0, 10, { segmentSec: 2 });
    const fps = plan.map(seg => segmentFingerprint(base, seg));
    const moved = snapshot(0, 10, [{ ...c1, offset: 0.5 }, c2]);
    assert.notStrictEqual(segmentFingerprint(moved, plan[0]), fps[0]);
    assert.strictEqual(segmentFingerprint(moved, plan[4]), fps[4]); // 8–10s 不受影响
    const gained = snapshot(0, 10, [c1, { ...c2, gain: 0.5 }]);
    assert.notStrictEqual(segmentFingerprint(gained, plan[2]), fps[2]); // 4–6s 受影响
    const faded = snapshot(0, 10, [{ ...c1, fadeOut: 2 }, c2]);
    assert.notStrictEqual(segmentFingerprint(faded, plan[0]), fps[0]);
  });

  await test('部分编辑后只有受影响区段重算，其余区段结果直接复用', async () => {
    const buf = sineBuf(440, 2, ANALYSIS_SR, Math.pow(10, -14 / 20));
    const mk = g => snapshot(0, 10, [
      clip({ buffer: buf, duration: 2, offset: 0, gain: 1, _hid: 12 }),
      clip({ buffer: buf, duration: 2, offset: 8, gain: g, _hid: 13 }),
    ]);
    const cache = new Map();
    const r1 = await analyzeAll(mk(1), PRESETS.stream, { segmentSec: 2, cache });
    const keysAfterFirst = [...cache.keys()];
    assert.ok(keysAfterFirst.length >= 5, '应有多个区段指纹');
    // 只改 8s 处片段的增益：只有含它的区段指纹变化
    const r2 = await analyzeAll(mk(0.5), PRESETS.stream, { segmentSec: 2, cache });
    const newKeys = [...cache.keys()].filter(k => !keysAfterFirst.includes(k));
    assert.strictEqual(newKeys.length, 1, '恰好一个区段需要重算: ' + newKeys.length);
    // 最终指标确实反映了改动（后段变轻）
    assert.ok(r2.metrics.integrated !== r1.metrics.integrated);
  });

  await test('缓存帧编码/校验：篡改 1 字节即 CRC 失败', () => {
    const rec = stashSegment({ segT: 1, coreFrames: 240000, channels: 1, e100: [[0, 1.23, 4800]], tpMax: 0.2 });
    const bytes = encodeSegmentRecord(rec);
    const dec = decodeSegmentRecord(bytes);
    assert.strictEqual(dec.ok, true);
    assert.deepStrictEqual(dec.rec, rec);
    const bad = bytes.slice(); bad[bad.length - 3] ^= 0xff;
    const badDec = decodeSegmentRecord(bad);
    assert.strictEqual(badDec.ok, false);
    assert.ok(/CRC/.test(badDec.reason));
  });

  /* ---------- 取消 / 暂停 ---------- */

  await test('分析可在块边界取消（无半成品结果）', async () => {
    const buf = noiseBuf(30, ANALYSIS_SR, 0.5, 7); // 长节目，确保取消时还没跑完
    const snap = snapshot(0, 30, [clip({ buffer: buf, duration: 30, _hid: 14 })]);
    const [seg] = planSegments(0, 30, { segmentSec: 30 });
    let blocks = 0, cancel = false;
    const deps = {
      renderMix(s, t0, t1, ch, cb, sr) {
        return EC.renderMix(s, t0, t1, ch, async (m) => {
          if (++blocks === 2) cancel = true; // 第二个渲染块后请求取消
          await cb(m);
        }, sr, { chunkFrames: 4800, yieldControl: () => Promise.resolve() });
      },
      yieldControl: () => Promise.resolve(),
    };
    const r = await LC.analyzeSegment(snap, seg, deps, {
      chunkSec: 0.2, shouldCancel: () => cancel,
    });
    assert.strictEqual(r.status, 'canceled');
    assert.ok(!r.e100, '取消不返回统计半成品');
  });

  await test('暂停期间不前进，恢复后得到正确结果', async () => {
    const buf = sineBuf(997, 4, ANALYSIS_SR, ampForLevel(-16));
    const snap = snapshot(0, 4, [clip({ buffer: buf, duration: 4, _hid: 15 })]);
    const [seg] = planSegments(0, 4, { segmentSec: 4 });
    let paused = true;
    const deps = makeRenderDeps(4800);
    let progressed = false;
    const p = LC.analyzeSegment(snap, seg, deps, {
      chunkSec: 0.2, isPaused: () => paused, pausePollMs: 10,
      onProgress: () => { progressed = true; },
    });
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(progressed, false, '暂停时不应推进');
    paused = false;
    const r = await p;
    assert.strictEqual(r.status, 'done');
    const { metrics } = metricsFromSegments([hydrateSegment(stashSegment(r))], PRESETS.podcast);
    approx(metrics.integrated, -16, 0.4);
  });

  /* ---------- 修正提案 ---------- */

  await test('统一增益提案：−18 dBFS 节目对 −14 目标 +4 dB，评估后达标且峰值不超限', async () => {
    const buf = sineBuf(997, 6, ANALYSIS_SR, ampForLevel(-18));
    const snap = snapshot(0, 6, [clip({ buffer: buf, duration: 6, _hid: 20 })]);
    const { metrics } = await analyzeAll(snap, PRESETS.stream);
    const prop = planUniform(metrics, PRESETS.stream);
    approx(prop.gainDB, 4, 0.3);
    const r = await evaluateProposal(snap, 0, 6, prop, PRESETS.stream, makeRenderDeps(), {});
    assert.strictEqual(r.feasible, true, JSON.stringify(r.conflicts));
    approx(r.metrics.integrated, -14, 0.3);
  });

  await test('冲突上报：−10 dBFS 对 −14 目标需衰减但峰值仍可能超限——统一增益无法同时满足时明确冲突', async () => {
    // −10 dBFS 正弦：要达到 −14 LUFS 需 −4 dB；应用后 TP=−14 dBTP < −1，实际可行。
    // 构造真正冲突：目标 −23（R128）但要求 TP ≤ −25（改严上限），−20 dBFS 正弦，
    // 综合 −20，需 −3 dB 到 −23，峰值 −23 仍 > −25 ⇒ 统一增益做不到。
    const buf = sineBuf(997, 6, ANALYSIS_SR, ampForLevel(-20));
    const snap = snapshot(0, 6, [clip({ buffer: buf, duration: 6, _hid: 21 })]);
    const { metrics } = await analyzeAll(snap, PRESETS.r128);
    const prop = planUniform(metrics, PRESETS.r128);
    const strict = { ...PRESETS.r128, maxTP: -25 };
    const r = await evaluateProposal(snap, 0, 6, prop, strict, makeRenderDeps(), {});
    assert.strictEqual(r.feasible, false, '统一增益在严格峰值上限下不可行');
    assert.ok(r.conflicts.some(c => c.kind === 'peak'), '必须指出峰值冲突');
    assert.strictEqual(r.evaluation.pass, false, '不能给出看似通过的结果');
    assert.ok(r.conflicts.find(c => c.kind === 'peak').over > 0, '差距为正');
  });

  await test('限制器提案：响度合规但带超限尖峰的节目，压峰后真峰达标且响度基本不变', async () => {
    const sr = ANALYSIS_SR, n = sr * 6;
    const d = new Float32Array(n);
    const base = Math.pow(10, (-14 + 3.01) / 20); // −14 LUFS 的 997Hz 基底
    for (let i = 0; i < n; i++) {
      let v = base * Math.sin(2 * Math.PI * 997 * i / sr);
      const ph = i % Math.round(sr / 2); // 每 0.5 s 一个 12 样本尖峰
      if (ph < 12) v += 0.75 * Math.sin(2 * Math.PI * 2000 * i / sr);
      d[i] = v;
    }
    const snap = snapshot(0, 6, [clip({ buffer: fakeBuffer([d], sr), duration: 6, _hid: 22 })]);
    const { metrics } = await analyzeAll(snap, PRESETS.stream);
    assert.ok(metrics.integrated > -15 && metrics.integrated < -13, '基底响度已合规: ' + metrics.integrated);
    assert.ok(metrics.truePeak > PRESETS.stream.maxTP, '前提：尖峰真峰值超限: ' + metrics.truePeak);
    const prop = planLimiter(metrics, PRESETS.stream);
    const r = await evaluateProposal(snap, 0, 6, prop, PRESETS.stream, makeRenderDeps(), { chunkSec: 0.25 });
    assert.strictEqual(r.status, 'done');
    assert.ok(r.limiterStats.maxReduction > 0.02, '限制器确实做了压峰: ' + r.limiterStats.maxReduction);
    assert.ok(r.metrics.truePeak <= PRESETS.stream.maxTP + 0.2,
      '限制后真峰值不超上限: ' + r.metrics.truePeak);
    assert.ok(Math.abs(r.metrics.integrated - metrics.integrated) < 0.8,
      `响度基本不变: ${metrics.integrated} → ${r.metrics.integrated}`);
  });

  await test('分段包络提案：前轻后响节目的各段短时响度被拉向目标，区间内偏差缩小', async () => {
    const sr = ANALYSIS_SR, n = 8 * sr;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const db = i < n / 2 ? -22 : -10;
      d[i] = Math.sin(2 * Math.PI * 330 * i / sr) * Math.pow(10, db / 20);
    }
    const snap = snapshot(0, 8, [clip({ buffer: fakeBuffer([d], sr), duration: 8, _hid: 23 })]);
    const before = await analyzeAll(snap, PRESETS.stream);
    const spreadBefore = before.metrics.stMax - before.metrics.stMin;
    const prop = planEnvelope(before.metrics, PRESETS.stream);
    assert.strictEqual(prop.kind, 'envelope');
    assert.ok(prop.nodes.length >= 2);
    const r = await evaluateProposal(snap, 0, 8, prop, PRESETS.stream, makeRenderDeps(), {});
    assert.strictEqual(r.status, 'done');
    const spreadAfter = r.metrics.stMax - r.metrics.stMin;
    assert.ok(spreadAfter < spreadBefore - 3,
      `包络应压缩短时离散: ${spreadBefore} → ${spreadAfter}`);
  });

  await test('提案处理不修改原素材/快照（非破坏性）', async () => {
    const buf = sineBuf(997, 4, ANALYSIS_SR, Math.pow(10, -10 / 20));
    const c0 = clip({ buffer: buf, duration: 4, _hid: 24 });
    const snap = snapshot(0, 4, [c0]);
    const before = buf.getChannelData(0)[12345];
    const { metrics } = await analyzeAll(snap, PRESETS.stream);
    await evaluateProposal(snap, 0, 4, planUniform(metrics, PRESETS.stream), PRESETS.stream, makeRenderDeps(), {});
    assert.strictEqual(buf.getChannelData(0)[12345], before);
    assert.strictEqual(c0.gain, 1);
  });

  await test('renderProcessed：输出长度精确等于区间帧数（含限制器延迟补偿）', async () => {
    const buf = sineBuf(997, 3.2, ANALYSIS_SR, 0.5);
    const snap = snapshot(0, 3.2, [clip({ buffer: buf, duration: 3.2, _hid: 25 })]);
    const { metrics } = await analyzeAll(snap, PRESETS.stream);
    const prop = planLimiter(metrics, PRESETS.stream);
    const r = await renderProcessed(snap, 0, 3.2, prop, makeRenderDeps(), {});
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.frames, Math.round(3.2 * ANALYSIS_SR / SUB) * SUB);
    assert.strictEqual(r.pcm.length, r.frames * r.channels);
    assert.strictEqual(r.channels, 1); // 单声道源：单声道渲染，不凭空翻倍
  });

  await test('多段结果与单段结果一致（分段不改变综合响度/真峰值）', async () => {
    const buf = noiseBuf(12, ANALYSIS_SR, 0.4, 99);
    const snap = snapshot(0, 12, [clip({ buffer: buf, duration: 12, _hid: 26 })]);
    const multi = await analyzeAll(snap, PRESETS.r128, { segmentSec: 2 });
    const single = await analyzeAll(snap, PRESETS.r128, { segmentSec: 12, cache: new Map() });
    approx(multi.metrics.integrated, single.metrics.integrated, 0.2, 'integrated');
    approx(multi.metrics.truePeak, single.metrics.truePeak, 0.15, 'truePeak');
    approx(multi.metrics.lra, single.metrics.lra, 0.4, 'lra');
  });

  /* ---------- 提案增益曲线：试听/落地同源、只作用框内 ---------- */

  async function renderRms(snap, t0, t1, ch) {
    const parts = [];
    await EC.renderMix(snap, t0, t1, ch || 1, m => parts.push(m), ANALYSIS_SR,
      { chunkFrames: 1 << 14, yieldControl: () => Promise.resolve() });
    let sum = 0, cnt = 0;
    for (const p of parts) for (const v of p) { sum += v * v; cnt++; }
    return Math.sqrt(sum / cnt);
  }
  async function renderMaxAbs(snap, t0, t1, ch) {
    const parts = [];
    await EC.renderMix(snap, t0, t1, ch || 1, m => parts.push(m), ANALYSIS_SR,
      { chunkFrames: 1 << 14, yieldControl: () => Promise.resolve() });
    let mx = 0;
    for (const p of parts) for (const v of p) mx = Math.max(mx, Math.abs(v));
    return mx;
  }

  await test('提案导出增益曲线：统一增益只覆盖框选区间，框外严格为 1', async () => {
    const buf = sineBuf(997, 8, ANALYSIS_SR, ampForLevel(-18));
    const c0 = clip({ buffer: buf, duration: 8, _hid: 30 });
    const snap = snapshot(2, 6, [c0]);
    const before = await analyzeAll(snap, PRESETS.stream);
    const prop = planUniform(before.metrics, PRESETS.stream);
    const r = await evaluateProposal(snap, 2, 6, prop, PRESETS.stream, makeRenderDeps(), {});
    assert.strictEqual(r.gainNodes.length, 2);
    approx(r.gainNodes[0].t, 2, 1e-6); approx(r.gainNodes[1].t, 6, 1e-4);
    const g = r.gainNodes[0].g;
    assert.ok(Math.abs(g - Math.pow(10, prop.gainDB / 20)) < 1e-9);
    // 落地为片段 autoGain：框内 RMS 按比例变化，框外逐口径不变
    const landed = clip({ buffer: buf, duration: 8, _hid: 30, autoGain: r.gainNodes });
    const outBefore = await renderRms(snapshot(0, 8, [c0]), 0, 2);
    const outAfter = await renderRms(snapshot(0, 8, [landed]), 0, 2);
    approx(outAfter, outBefore, 1e-9, '框外电平不变');
    const inBefore = await renderRms(snapshot(0, 8, [c0]), 2, 6);
    const inAfter = await renderRms(snapshot(0, 8, [landed]), 2, 6);
    assert.ok(Math.abs(inAfter / inBefore - g) < 1e-4, `框内按 g=${g.toFixed(3)} 缩放，实际 ${inAfter / inBefore}`);
  });

  await test('包络提案落地保留曲线形状（不退化成整段恒定）且只作用框内', async () => {
    const sr = ANALYSIS_SR, n = 8 * sr;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const db = i < n / 2 ? -22 : -10;
      d[i] = Math.sin(2 * Math.PI * 330 * i / sr) * Math.pow(10, db / 20);
    }
    const buf = fakeBuffer([d], sr);
    const c0 = clip({ buffer: buf, duration: 8, _hid: 31 });
    const snap = snapshot(2, 6, [c0]);
    const before = await analyzeAll(snap, PRESETS.stream);
    const prop = planEnvelope(before.metrics, PRESETS.stream);
    const r = await evaluateProposal(snap, 2, 6, prop, PRESETS.stream, makeRenderDeps(), {});
    assert.ok(r.gainNodes.length >= 3, '曲线有多个不同增益点，不是恒定值: ' + r.gainNodes.length);
    const gMin = Math.min(...r.gainNodes.map(x => x.g));
    const gMax = Math.max(...r.gainNodes.map(x => x.g));
    assert.ok(gMax / gMin > 1.5, `曲线确实起伏（前轻后响）：${gMin.toFixed(3)}..${gMax.toFixed(3)}`);
    // 框外不变
    const landed = clip({ buffer: buf, duration: 8, _hid: 31, autoGain: r.gainNodes });
    const outBefore = await renderRms(snapshot(0, 8, [c0]), 6, 8);
    const outAfter = await renderRms(snapshot(0, 8, [landed]), 6, 8);
    approx(outAfter, outBefore, 1e-9, '框外电平不变');
    // 曲线形状：框内前半（原过轻）提升大于后半
    const firstQ = await renderRms(snapshot(0, 8, [landed]), 2, 3);
    const lastQ = await renderRms(snapshot(0, 8, [landed]), 5, 6);
    const firstQ0 = await renderRms(snapshot(0, 8, [c0]), 2, 3);
    const lastQ0 = await renderRms(snapshot(0, 8, [c0]), 5, 6);
    assert.ok(firstQ / firstQ0 > lastQ / lastQ0 * 1.2, '轻段提升明显大于响段');
  });

  await test('限制器提案导出实际增益曲线，可确认/落地，落地后不削波且框外零变化', async () => {
    const sr = ANALYSIS_SR, n = 6 * sr;
    const d = new Float32Array(n);
    const base = ampForLevel(-14);
    for (let i = 0; i < n; i++) {
      let v = base * Math.sin(2 * Math.PI * 997 * i / sr);
      if (i % Math.round(sr / 2) < 12) v += 0.75 * Math.sin(2 * Math.PI * 2000 * i / sr);
      d[i] = v;
    }
    const buf = fakeBuffer([d], sr);
    const c0 = clip({ buffer: buf, duration: 6, _hid: 32 });
    const snap = snapshot(0, 6, [c0]);
    const before = await analyzeAll(snap, PRESETS.stream);
    const prop = planLimiter(before.metrics, PRESETS.stream);
    const r = await evaluateProposal(snap, 0, 6, prop, PRESETS.stream, makeRenderDeps(1 << 12), {});
    assert.strictEqual(r.feasible, true, '可行提案可确认');
    assert.ok(r.gainNodes.some(x => x.g < 0.999), '曲线记录了真实衰减');
    // 落地（autoGain）后峰值不超过上限
    const landed = clip({ buffer: buf, duration: 6, _hid: 32, autoGain: r.gainNodes });
    const peak = await renderMaxAbs(snapshot(0, 6, [landed]), 0, 6);
    const peakDB = 20 * Math.log10(peak);
    assert.ok(peakDB <= PRESETS.stream.maxTP + 0.25, '落地后不削波: ' + peakDB);
    // 局部框选 2..4：框外逐样本不变
    const r2 = await evaluateProposal(snap, 2, 4, prop, PRESETS.stream, makeRenderDeps(1 << 12), {});
    const local = clip({ buffer: buf, duration: 6, _hid: 32, autoGain: r2.gainNodes });
    const a = [], b = [];
    await EC.renderMix(snapshot(0, 6, [local]), 0, 2, 1, m => a.push(m.slice()), ANALYSIS_SR);
    await EC.renderMix(snapshot(0, 6, [c0]), 0, 2, 1, m => b.push(m.slice()), ANALYSIS_SR);
    let diff = 0;
    for (let i = 0; i < a[0].length; i++) diff += Math.abs(a[0][i] - b[0][i]);
    assert.strictEqual(diff, 0, '框外逐样本完全不变');
  });

  await test('autoGain 进入片段指纹：改动曲线后分段缓存/导出指纹必须失效', () => {
    const buf = sineBuf(997, 4, ANALYSIS_SR, 0.5);
    const c1 = clip({ buffer: buf, duration: 4, _hid: 40, gain: 1 });
    const c2 = clip({ buffer: buf, duration: 4, _hid: 40, gain: 1, autoGain: [{ t: 1, g: 0.5 }, { t: 2, g: 0.5 }] });
    assert.notStrictEqual(clipFingerprint(c1), clipFingerprint(c2));
    const fp1 = EC.snapshotFingerprint(snapshot(0, 4, [c1]), { sampleRate: 48000, channels: 1, bitDepth: '16' });
    const fp2 = EC.snapshotFingerprint(snapshot(0, 4, [c2]), { sampleRate: 48000, channels: 1, bitDepth: '16' });
    assert.notStrictEqual(fp1, fp2);
  });

  console.log(passed + ' 项 loudness-core 测试通过');
})().catch(err => { console.error(err); process.exit(1); });
