'use strict';

/* ================= 响度分析与非破坏性修正核心（纯计算，无 DOM） =================
   遵循 ITU-R BS.1770-4（K 加权、双门限综合响度、LRA）+ BS.1771（短时响度），
   真峰值采用 4× 过采样（BS.1770 建议）。
   - 分析在「与实际播放/导出一致」的离线混音上进行：重叠片段按增益相加、淡化跟随片段、
     源采样率线性重采样——通过注入 renderMix 与 export-core.accumulate 共用同一语义。
   - 分段计算：节目切成固定长度区段，每段内容指纹独立，可缓存、可跨任务复用；
     每段带前置 halo 让 K 加权进入稳态，只有核心区样本参与统计，边界块天然不跨段。
   - 修正提案（统一增益 / 分段包络 / 真峰值限制）在同一混音管线上渲染后再度量；
     目标响度与峰值上限无法同时满足时如实报告冲突，绝不给出看似通过的结果。
   浏览器挂 window；Node 下 module.exports 供单元测试。 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* ---------- 常量与预设 ---------- */

  const ANALYSIS_SR = 48000;                 // BS.1770 系数按 48 kHz 设计
  const ANALYSIS_CH = 2;                     // 立体声节目
  const MONO_CH = 1;                         // 单声道节目（BS.1770：单声道不做 −3 dB 折算）
  const SUB_MS = 100, SHORT_MS = 400, LRA_MS = 3000;
  const SUB = ANALYSIS_SR * SUB_MS / 1000;   // 4800
  const ABS_GATE = -70;                      // LUFS
  const REL_GATE = -10;                      // LU
  const TP_UPSAMPLE = 4;
  const HALO_SEC = 3;                        // 前置 halo（大于 K 加权建立时间）
  const DEFAULT_SEGMENT_SEC = 5;
  const DEFAULT_CHUNK_SEC = 0.5;

  /* EBU R128 / 流媒体 / 播客目标。tol=综合响度允许偏差；maxTP=真峰值上限 dBTP */
  const PRESETS = {
    r128:    { id: 'r128',   name: 'EBU R128',       target: -23, tol: 0.5, maxTP: -1 },
    stream:  { id: 'stream', name: '流媒体（通用）', target: -14, tol: 1.0, maxTP: -1 },
    podcast: { id: 'podcast', name: '播客',          target: -16, tol: 1.0, maxTP: -1 },
  };

  /* ---------- K 加权（BS.1770-4；48 kHz 系数） ----------
     采用 ffmpeg libavfilter/f_ebur128.c 的 De Man「PRE + RLB」双二阶（48 kHz），
     与 ffmpeg ebur128 互操作一致：997 Hz、−23 dBFS(RMS) 正弦 ⇒ −23 LUFS。
     分析统一重采样到 48 kHz，因此只需要这一组系数。 */
  function kCoef48() {
    const shelf = {
      b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
      a: [-1.69065929318241, 0.73248077421585],
    };
    const hpf = {
      b: [1.0, -2.0, 1.0],
      a: [-1.99004745483398, 0.99007225036621],
    };
    return [shelf, hpf];
  }
  const K_COEF = kCoef48();

  function kState() { return K_COEF.map(c => ({ c, x1: 0, x2: 0, y1: 0, y2: 0 })); }
  function kStep(st, v) {
    for (const s of st) {
      const y = s.c.b[0] * v + s.c.b[1] * s.x1 + s.c.b[2] * s.x2
        - s.c.a[0] * s.y1 - s.c.a[1] * s.y2;
      s.x2 = s.x1; s.x1 = v; s.y2 = s.y1; s.y1 = y; v = y;
    }
    return v;
  }

  /* ---------- 4× 过采样真峰值（Hann 窗 sinc，每相 16 tap，因果） ----------
     原型 h(x)=sinc(x/4)·hann，多相分解后逐相增益归一（直流增益 1）。
     全频带（≤20 kHz）峰值重建误差 < 0.1 dB。 */

  function buildOversampler() {
    const tapsPerPhase = 16, L = TP_UPSAMPLE * tapsPerPhase;
    const h = new Array(L);
    for (let n = 0; n < L; n++) {
      const x = (n - (L - 1) / 2) / TP_UPSAMPLE;
      const s = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (L - 1));
      h[n] = s * w;
    }
    const phases = [];
    for (let p = 0; p < TP_UPSAMPLE; p++) {
      const taps = [];
      let sum = 0;
      for (let k = 0; k < tapsPerPhase; k++) { const v = h[TP_UPSAMPLE * k + p]; taps.push(v); sum += v; }
      phases.push(taps.map(v => v / sum));
    }
    return phases;
  }

  /* ring[0]=x[n]…x[n-K]。非因果插值核中心在 n+7.5−p/4，
     因果化（延迟 8 个输入样本）后取 ring[k+1]；延迟不影响峰值幅度。 */
  function tpState(channels) {
    return { phases: buildOversampler(), rings: Array.from({ length: channels }, () => new Array(18).fill(0)), max: 0 };
  }
  function tpProcess(st, chVals, updateMax) {
    const K = st.phases[0].length;
    if (updateMax === undefined) updateMax = true;
    let framePeak = 0;
    for (let c = 0; c < chVals.length; c++) {
      const ring = st.rings[c];
      for (let j = ring.length - 1; j >= 1; j--) ring[j] = ring[j - 1];
      ring[0] = chVals[c];
      for (let p = 0; p < TP_UPSAMPLE; p++) {
        let v = 0;
        const taps = st.phases[p];
        for (let k = 0; k < K; k++) v += taps[k] * ring[k + 1];
        const a = Math.abs(v);
        if (a > framePeak) framePeak = a;
        if (updateMax && a > st.max) st.max = a;
      }
    }
    return framePeak;
  }

  /* ---------- 统计器：K 加权能量（100ms 子块）+ 真峰值 ----------
     喂入的是连续的混音块；coreStart=核心区起点（之前是 halo），coreFrames=核心帧数。
     只统计 [coreStart, coreStart+coreFrames)；子块按全局核心区网格对齐。 */
  function createMeasurer(channels, coreStart, coreFrames, indexOffset) {
    const kSt = Array.from({ length: channels }, kState);
    const tp = tpState(channels);
    let proc = 0;
    let open = null; // 当前未闭合子块 {idx,sum,cnt}
    const e100 = new Map();
    const idx0 = indexOffset || 0;

    function feed(mix) {
      const frames = mix.length / channels;
      for (let i = 0; i < frames; i++) {
        // 真峰值在「未经 K 加权」的原始样本上测（BS.1770）；K 加权只用于响度能量。
        // 过采样器需要连续历史 ⇒ halo 帧也喂，但只在核心区更新峰值（updateMax）。
        const raw = new Array(channels);
        let esum = 0;
        for (let c = 0; c < channels; c++) {
          const x = mix[i * channels + c];
          raw[c] = x;
          const y = kStep(kSt[c], x);
          if (proc >= coreStart && proc < coreStart + coreFrames) esum += y * y;
        }
        const inCore = proc >= coreStart && proc < coreStart + coreFrames;
        const frameTP = tpProcess(tp, raw, false);
        if (inCore && frameTP > tp.max) tp.max = frameTP;
        if (inCore) {
          const idx = idx0 + Math.floor((proc - coreStart) / SUB);
          if (!open || open.idx !== idx) {
            if (open && open.cnt === SUB) e100.set(open.idx, { sum: open.sum, cnt: SUB });
            open = { idx, sum: 0, cnt: 0 };
          }
          open.sum += esum; open.cnt++;
        }
        proc++;
      }
    }
    function finish() {
      if (open && open.cnt === SUB) e100.set(open.idx, { sum: open.sum, cnt: SUB });
      open = null;
    }
    return { feed, finish, e100, tpMax: () => tp.max, proc: () => proc, coreStart, coreFrames };
  }

  function meanSquaresToLUFS(sum, cnt, channels) {
    if (!cnt) return -Infinity;
    return -0.691 + 10 * Math.log10(sum / cnt / channels);
  }

  /* ---------- 指标汇总（跨段合并） ---------- */

  function assembleMetrics(segments, channels) {
    channels = channels || ANALYSIS_CH;
    const e100 = new Map();
    let tpMax = 0, totalFrames = 0, coreStartSec = Infinity, coreEndSec = -Infinity;
    for (const seg of segments) {
      const m = seg.e100 instanceof Map ? seg.e100 : new Map(seg.e100);
      for (const [k, v] of m) e100.set(+k, v);
      if (isFinite(seg.tpMax) && seg.tpMax > tpMax) tpMax = seg.tpMax;
      totalFrames += seg.coreFrames;
      coreStartSec = Math.min(coreStartSec, seg.segT);
      coreEndSec = Math.max(coreEndSec, seg.segT + seg.coreFrames / ANALYSIS_SR);
    }
    const idxs = [...e100.keys()].sort((a, b) => a - b);

    const blockSum = (first, n) => {
      let sum = 0, cnt = 0;
      for (let k = 0; k < n; k++) {
        const v = e100.get(first + k);
        if (!v) return null;
        sum += v.sum; cnt += v.cnt;
      }
      return meanSquaresToLUFS(sum, cnt, channels);
    };

    /* 综合响度 BS.1770-4：400ms 块（4×100ms 连续），绝对门限 −70，相对门限 −10 LU */
    const absPass = [];
    for (let i = 0; i + 3 < idxs.length; i++) {
      if (idxs[i + 3] !== idxs[i] + 3) continue;
      const L = blockSum(idxs[i], 4);
      if (L !== null && L > ABS_GATE) absPass.push(L);
    }
    let integrated = null;
    if (absPass.length) {
      const meanAbs = absPass.reduce((a, b) => a + Math.pow(10, b / 10), 0) / absPass.length;
      const relThr = -70 + 10 * Math.log10(meanAbs + 1e-300) + REL_GATE;
      const relPass = absPass.filter(L => L > relThr);
      const arr = relPass.length ? relPass : absPass;
      integrated = -0.691 + 10 * Math.log10(
        arr.reduce((a, b) => a + Math.pow(10, (b + 0.691) / 10), 0) / arr.length);
    }

    /* LRA BS.1770-4：3 s 滑动窗（30 子块），−20 LU 相对门限；节目不足 3 s 时返回 null */
    const lraBlocks = [];
    for (const i of idxs) {
      if (!e100.has(i + 29)) continue;
      let contiguous = true;
      for (let k = 1; k < 30; k++) if (!e100.has(i + k)) { contiguous = false; break; }
      if (!contiguous) continue;
      const L = blockSum(i, 30);
      if (L !== null) lraBlocks.push(L);
    }
    let lra = null;
    if (lraBlocks.length) {
      const s = lraBlocks.slice().sort((a, b) => a - b);
      const lk = -70 + 10 * Math.log10(s.reduce((a, b) => a + Math.pow(10, b / 10), 0) / s.length) - 20;
      const gated = s.filter(v => v > lk && v > ABS_GATE);
      const arr = gated.length ? gated : s;
      const pct = (p) => {
        const x = (arr.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
        return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (x - lo);
      };
      lra = pct(0.95) - pct(0.10);
    }

    /* 短时响度 BS.1771：400ms 滑窗、100ms 步进；时间戳为窗起点（节目绝对时间） */
    const shortTerm = [];
    for (const i of idxs) {
      if (!e100.has(i + 1) || !e100.has(i + 2) || !e100.has(i + 3)) continue;
      const L = blockSum(i, 4);
      if (L !== null) shortTerm.push({ t: coreStartSec + i * SUB_MS / 1000, lufs: L });
    }
    const stVals = shortTerm.map(s => s.lufs);

    return {
      integrated,
      lra,
      shortTerm,
      stMin: stVals.length ? Math.min(...stVals) : null,
      stMax: stVals.length ? Math.max(...stVals) : null,
      truePeak: tpMax > 0 ? 20 * Math.log10(tpMax) : null,
      duration: totalFrames / ANALYSIS_SR,
      subCount: idxs.length,
    };
  }

  /* ---------- 超限区段与达标判定 ---------- */

  function findViolations(shortTerm, segPeaks, preset) {
    const hi = preset.target + preset.tol, lo = preset.target - preset.tol;
    const tpLin = Math.pow(10, preset.maxTP / 20);
    const zones = [];
    if (shortTerm && shortTerm.length) {
      let cur = null;
      const flush = () => { if (cur) zones.push(cur); cur = null; };
      for (const s of shortTerm) {
        const kind = s.lufs > hi ? 'loud' : s.lufs < lo ? 'quiet' : null;
        if (kind && cur && cur.kind === kind && s.t - cur.lastT <= SUB_MS / 1000 * 1.5) {
          cur.b = s.t + SHORT_MS / 1000; cur.lastT = s.t;
          cur.max = Math.max(cur.max, s.lufs); cur.min = Math.min(cur.min, s.lufs);
        } else {
          flush();
          if (kind) cur = { kind, a: s.t, b: s.t + SHORT_MS / 1000, lastT: s.t, max: s.lufs, min: s.lufs };
        }
      }
      flush();
      for (const z of zones) {
        delete z.lastT;
        z.detail = z.kind === 'loud'
          ? `短时响度最高 ${z.max.toFixed(1)} LUFS（上限 ${hi.toFixed(1)}）`
          : `短时响度最低 ${z.min.toFixed(1)} LUFS（下限 ${lo.toFixed(1)}）`;
      }
    }
    for (const seg of segPeaks || []) {
      if (isFinite(seg.tpMax) && seg.tpMax > tpLin) {
        zones.push({
          kind: 'peak', a: seg.segT, b: seg.segT + seg.coreFrames / ANALYSIS_SR,
          detail: `真峰值 ${(20 * Math.log10(seg.tpMax)).toFixed(2)} dBTP 超过上限 ${preset.maxTP} dBTP`,
          tp: 20 * Math.log10(seg.tpMax),
        });
      }
    }
    return zones;
  }

  function evaluate(metrics, segPeaks, preset) {
    const zones = findViolations(metrics.shortTerm, segPeaks, preset);
    const hi = preset.target + preset.tol, lo = preset.target - preset.tol;
    const integ = metrics.integrated;
    const integPass = integ !== null && integ <= hi + 1e-6 && integ >= lo - 1e-6;
    const tpPass = metrics.truePeak === null || metrics.truePeak <= preset.maxTP + 1e-6;
    return {
      pass: tpPass && integPass, integPass, tpPass, zones, preset,
      integrated: integ, truePeak: metrics.truePeak, lra: metrics.lra,
      stMin: metrics.stMin, stMax: metrics.stMax,
    };
  }

  /* ---------- 指纹与分段 ---------- */

  function num(v) { return +(+v).toFixed(6); }
  const bufIds = new WeakMap();
  let bufSeq = 1;
  function bufUid(buf) {
    let id = bufIds.get(buf);
    if (!id) { id = 'b' + (bufSeq++); bufIds.set(buf, id); }
    return id;
  }
  function clipFingerprint(c) {
    const mid = c.mediaHash || ('buf:' + bufUid(c.buffer));
    const auto = Array.isArray(c.autoGain) && c.autoGain.length
      ? c.autoGain.slice().sort((p, q) => p.t - q.t)
        .map(n => (+(+n.t).toFixed(6)) + ':' + (+(+n.g).toFixed(6))).join('|')
      : '';
    return [mid, num(c.offset), num(c.gain), num(c.fadeIn), num(c.fadeOut), num(c.duration), auto].join(',');
  }

  /* 分段与核心区子块网格对齐：段长取整到 100ms，跨段子块索引连续可直接合并 */
  function planSegments(a, b, opts) {
    const wantSec = (opts && opts.segmentSec) || DEFAULT_SEGMENT_SEC;
    const segSec = Math.max(SHORT_MS / 1000, Math.round(wantSec * 10) / 10);
    const segs = [];
    let t = a, i = 0;
    while (t < b - 1e-9) {
      const end = Math.min(b, t + segSec);
      const frames = Math.round((end - t) * ANALYSIS_SR / SUB) * SUB;
      const realEnd = t + frames / ANALYSIS_SR;
      segs.push({ index: i++, segT: t, coreFrames: frames, coreEnd: realEnd });
      t = realEnd;
    }
    return segs;
  }

  function segmentFingerprint(snap, seg) {
    const end = seg.segT + seg.coreFrames / ANALYSIS_SR;
    const clips = (snap.clips || [])
      .filter(c => c.offset < end && c.offset + c.duration > seg.segT)
      .map(clipFingerprint).sort().join(';');
    return ['v2', ANALYSIS_SR, snapChannels(snap), num(seg.segT), seg.coreFrames, clips].join('|');
  }

  /* 分析声道布局：节目内出现过的最大声道数（1 或 2；多声道按前 2 声道）。
     单声道节目以单声道度量——BS.1770 单声道不做 −3 dB 电平折算。 */
  function snapChannels(snap) {
    if (snap.channels) return snap.channels;
    let ch = 1;
    for (const c of snap.clips || []) {
      let n = 0;
      try { n = c.buffer.numberOfChannels; } catch (_) { n = 1; }
      if (n >= 2) { ch = 2; break; }
    }
    return ch;
  }

  /* ---------- 单段分析（带 halo，逐块让出/响应暂停取消） ----------
     deps.renderMix(snap, t0, t1, channels, onChunk, sampleRate)
       onChunk(Float32Array interleaved)；混音语义与 export-core 一致。 */

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function analyzeSegment(snap, seg, deps, opts) {
    opts = opts || {};
    const channels = opts.channels || snapChannels(snap);
    const chunkFrames = Math.max(SUB, Math.round(((opts.chunkSec || DEFAULT_CHUNK_SEC)) * ANALYSIS_SR / SUB) * SUB);
    const halo = Math.min(HALO_SEC, Math.max(0, seg.segT - snap.a));
    const renderT0 = seg.segT - halo;
    const coreStart = Math.round(halo * ANALYSIS_SR);
    const totalFrames = coreStart + seg.coreFrames;
    const m = createMeasurer(channels, coreStart, seg.coreFrames,
      Math.round((seg.segT - snap.a) * ANALYSIS_SR / SUB));
    const shouldCancel = opts.shouldCancel || (() => false);
    const isPaused = opts.isPaused || (() => false);
    const yieldControl = deps.yieldControl || (() => Promise.resolve());

    let done = 0;
    let chunkState = 'ok';
    let pausedShown = false, resumedShown = false;
    const notePause = () => { if (!pausedShown && opts.onStatus) { opts.onStatus('paused'); pausedShown = true; resumedShown = false; } };
    const noteRun = () => { if (!resumedShown && opts.onStatus) { opts.onStatus('running'); resumedShown = true; pausedShown = false; } };
    const onChunk = async (mix) => {
      // 渲染按块回调：暂停/取消在块边界生效（不杀半块，保证段结果完整）
      if (shouldCancel()) { chunkState = 'canceled'; return; }
      if (isPaused()) notePause();
      while (isPaused()) {
        if (shouldCancel()) { chunkState = 'canceled'; return; }
        await sleep(opts.pausePollMs || 60);
      }
      noteRun();
      m.feed(mix);
    };
    while (done < totalFrames) {
      if (shouldCancel()) return { status: 'canceled', seg };
      while (isPaused()) {
        if (shouldCancel()) return { status: 'canceled', seg };
        await sleep(opts.pausePollMs || 60);
      }
      const f1 = Math.min(totalFrames, done + chunkFrames);
      const t0 = renderT0 + done / ANALYSIS_SR;
      const t1 = renderT0 + f1 / ANALYSIS_SR;
      await deps.renderMix(snap, t0, t1, channels, onChunk, ANALYSIS_SR);
      if (chunkState === 'canceled') return { status: 'canceled', seg };
      done = f1;
      if (opts.onProgress) opts.onProgress(f1 / totalFrames);
      await yieldControl();
    }
    m.finish();
    return {
      status: 'done', channels,
      segT: seg.segT,
      coreFrames: seg.coreFrames,
      e100: [...m.e100.entries()].map(([k, v]) => [k, v.sum, v.cnt]),
      tpMax: m.tpMax(),
    };
  }

  function hydrateSegment(rec) {
    return {
      segT: rec.segT, coreFrames: rec.coreFrames, tpMax: rec.tpMax, channels: rec.channels,
      e100: new Map((rec.e100 || []).map(([k, sum, cnt]) => [k, { sum, cnt }])),
    };
  }
  function stashSegment(res) {
    return { segT: res.segT, coreFrames: res.coreFrames, channels: res.channels, e100: res.e100, tpMax: res.tpMax };
  }
  function metricsFromSegments(segments, preset, channels) {
    const hydrated = segments.map(s => s.e100 instanceof Map ? s : hydrateSegment(s));
    const ch = channels || hydrated[0]?.channels || ANALYSIS_CH;
    const metrics = assembleMetrics(hydrated, ch);
    const evaluation = evaluate(metrics, hydrated, preset);
    return { metrics, evaluation, segments: hydrated, channels: ch };
  }

  /* ---------- 修正处理器 ---------- */

  /* 分段包络：节目时间上的关键点 dB 增益，块间线性（增益域线性插值避免 zipper） */
  function makeEnvelope(nodes, t0, channels) {
    const ch = channels || ANALYSIS_CH;
    const ns = nodes.slice().sort((a, b) => a.t - b.t);
    let cursor = 0;
    return {
      delaySamples: 0,
      process(mix, blockT0) {
        const frames = mix.length / ch;
        for (let i = 0; i < frames; i++) {
          const t = blockT0 + i / ANALYSIS_SR;
          while (cursor < ns.length - 2 && t > ns[cursor + 1].t) cursor++;
          const n0 = ns[cursor], n1 = ns[Math.min(cursor + 1, ns.length - 1)];
          let g;
          if (n1.t <= n0.t) g = Math.pow(10, n0.gainDB / 20);
          else {
            const r = Math.min(1, Math.max(0, (t - n0.t) / (n1.t - n0.t)));
            const g0 = Math.pow(10, n0.gainDB / 20), g1 = Math.pow(10, n1.gainDB / 20);
            g = g0 + (g1 - g0) * r;
          }
          for (let c = 0; c < ch; c++) mix[i * ch + c] *= g;
        }
      },
    };
  }

  /* 前瞻真峰值限制器（立体声联动，feed-forward）：
     检测用 4× 过采样真峰值（与响度分析同一插值器），确保限制后满足 dBTP 上限；
     增益需求由当前样本起 look+1 窗内最大真峰值决定；攻击快、恢复慢，输出延迟 look 帧。
     安全余量 0.35 dB：窗内真峰值按样本点更新，峰值可能略高于相邻样本。 */
  function makeLimiter(params) {
    const ch = params.channels || ANALYSIS_CH;
    const margin = 0.35;
    const ceilLin = Math.pow(10, (params.ceilingDBTP - margin) / 20);
    const look = Math.max(1, Math.round((params.lookaheadSec ?? 0.005) * ANALYSIS_SR));
    const attackCoef = Math.exp(-1 / (ANALYSIS_SR * (params.attackSec ?? 0.0005)));
    const releaseCoef = Math.exp(-1 / (ANALYSIS_SR * (params.releaseSec ?? 0.15)));
    let hist = new Float32Array(0); // 未输出的输入（尾部 look 帧）
    let env = 1;
    let maxReduction = 0, maxInputPeak = 0;
    // 过采样真峰值状态跨块连续（块边界处的样本间峰不能漏）
    const tp = tpState(ch);
    // 全速率输出增益记录（按输出帧时间连续）：供提案导出曲线（试听/落地同一来源）
    const gainLog = params.recordGain ? [] : null;

    function processWindow(all, frames) {
      // 1) 每帧 4× 过采样真峰值（插值器状态跨块连续）
      const tpPeak = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const vals = new Array(ch);
        for (let c = 0; c < ch; c++) vals[c] = all[i * ch + c];
        tpPeak[i] = tpProcess(tp, vals, false);
      }
      // 2) 前瞻窗最大真峰值（朴素滑动；look≈240、帧≈24k，成本可接受）
      const gain = new Float32Array(frames);
      for (let n = 0; n < frames; n++) {
        let p = 0;
        const e = Math.min(frames, n + look + 1);
        for (let i = n; i < e; i++) if (tpPeak[i] > p) p = tpPeak[i];
        if (p > maxInputPeak) maxInputPeak = p;
        const target = p > ceilLin ? ceilLin / p : 1;
        if (target < env) env = attackCoef * env + (1 - attackCoef) * target;
        else env = releaseCoef * env + (1 - releaseCoef) * target;
        if (target < 1 && env > target) env = target; // 前瞻要求必须满足
        if (1 - env > maxReduction) maxReduction = 1 - env;
        gain[n] = env;
      }
      if (gainLog) for (let n = 0; n < frames; n++) gainLog.push(gain[n]);
      const out = new Float32Array(frames * ch);
      for (let n = 0; n < frames; n++) {
        for (let c = 0; c < ch; c++) out[n * ch + c] = all[n * ch + c] * gain[n];
      }
      return out;
    }

    return {
      delaySamples: look,
      push(mix) {
        const merged = new Float32Array(hist.length + mix.length);
        merged.set(hist, 0); merged.set(mix, hist.length);
        const totalFrames = merged.length / ch;
        if (totalFrames <= look) { hist = merged; return new Float32Array(0); }
        const outFrames = totalFrames - look;
        const out = processWindow(merged, outFrames);
        hist = merged.slice(outFrames * ch);
        return out;
      },
      flush() {
        if (!hist.length) return new Float32Array(0);
        const padded = new Float32Array(hist.length + look * ch);
        padded.set(hist, 0);
        const frames = hist.length / ch;
        const out = processWindow(padded, frames);
        hist = new Float32Array(0);
        return out;
      },
      stats: () => ({ maxReduction, maxInputPeak, ceilLin, look }),
      gainLog,
    };
  }

  /* ---------- 提案参数 ---------- */

  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function planUniform(metrics, preset) {
    if (metrics.integrated === null) return null;
    return { kind: 'uniform', gainDB: clampNum(preset.target - metrics.integrated, -60, 30) };
  }

  /* 分段包络：每个 400ms 短时窗给出趋向目标的增益，斜率限制 slewDBpS 防抽泵 */
  function planEnvelope(metrics, preset, opts) {
    const slew = (opts && opts.slewDBpS) || 12;
    const st = metrics.shortTerm;
    if (!st || !st.length) return null;
    const g = st.map(s => clampNum(preset.target - s.lufs, -24, 12));
    const dtAt = i => (st[i].t - st[i - 1].t) || SUB_MS / 1000;
    for (let i = 1; i < g.length; i++) {
      const d = dtAt(i);
      g[i] = Math.min(g[i], g[i - 1] + slew * d);
      g[i] = Math.max(g[i], g[i - 1] - slew * d);
    }
    for (let i = g.length - 2; i >= 0; i--) {
      const d = dtAt(i + 1);
      g[i] = Math.min(g[i], g[i + 1] + slew * d);
      g[i] = Math.max(g[i], g[i + 1] - slew * d);
    }
    const t0 = st[0].t, t1 = st[st.length - 1].t + SHORT_MS / 1000;
    const nodes = [{ t: t0, gainDB: g[0] }];
    for (let i = 1; i < g.length; i++) if (Math.abs(g[i] - g[i - 1]) > 1e-6) nodes.push({ t: st[i].t, gainDB: g[i] });
    nodes.push({ t: t1, gainDB: g[g.length - 1] });
    return { kind: 'envelope', nodes, t0, t1 };
  }

  function planLimiter(metrics, preset, opts) {
    const uniform = planUniform(metrics, preset);
    return {
      kind: 'limiter',
      preGainDB: uniform ? clampNum(uniform.gainDB, -24, 12) : 0,
      ceilingDBTP: preset.maxTP,
      attackSec: (opts && opts.attackSec) || 0.0005,
      releaseSec: (opts && opts.releaseSec) || 0.15,
      lookaheadSec: (opts && opts.lookaheadSec) || 0.005,
    };
  }

  /* ---------- 提案增益曲线（试听与落地共用，保证所听即所得） ----------
     三类提案都等价于「节目时间上的一条标量增益曲线 G(t)」：
       uniform：框内恒定；envelope：关键点 dB（增益域线性）；limiter：限制器实际增益。
     标量后乘对求和可分配：g(t)·Σxᵢ(t) = Σ g(t)·xᵢ(t)，所以重叠片段各自乘同一条 g(t)
     与总线处理结果逐样本一致——无需烤轨也能精确落地，且框外 G≡1 完全不动。
     返回的节点均为线性增益、节目绝对时间，恰好覆盖 [a,b]；框外由播放/渲染侧按 1 处理。 */
  function proposalGainNodes(proposal, a, b, limLog) {
    if (proposal.kind === 'uniform') {
      const g = Math.pow(10, proposal.gainDB / 20);
      return [{ t: num(a), g }, { t: num(b), g }];
    }
    if (proposal.kind === 'envelope') {
      const src = proposal.nodes.slice().sort((p, q) => p.t - q.t);
      const dbAt = (t) => {
        let i = 0;
        while (i < src.length - 1 && t > src[i + 1].t) i++;
        const n0 = src[i], n1 = src[Math.min(i + 1, src.length - 1)];
        if (n1.t <= n0.t) return n0.gainDB;
        const r = Math.min(1, Math.max(0, (t - n0.t) / (n1.t - n0.t)));
        return n0.gainDB + (n1.gainDB - n0.gainDB) * r;
      };
      const out = [];
      if (a < src[0].t - 1e-9) out.push({ t: num(a), g: Math.pow(10, dbAt(a) / 20) });
      for (const n of src) {
        if (n.t < a - 1e-9 || n.t > b + 1e-9) continue;
        out.push({ t: num(n.t), g: Math.pow(10, n.gainDB / 20) });
      }
      if (b > src[src.length - 1].t + 1e-9) out.push({ t: num(b), g: Math.pow(10, dbAt(b) / 20) });
      out.sort((p, q) => p.t - q.t);
      return out;
    }
    if (proposal.kind === 'limiter') {
      if (!limLog || !limLog.log) return [{ t: num(a), g: 1 }, { t: num(b), g: 1 }];
      const i0 = limLog.coreStartFrame | 0;
      const i1 = Math.min(limLog.log.length, i0 + Math.round((b - a) * limLog.sr / SUB) * SUB);
      return simplifyGainCurve(limLog.log, i0, i1, limLog.sr, a, limLog.scale ?? 1);
    }
    return null;
  }

  /* 全速率限制器增益曲线 → 分段线性节点（一维 ε-管道折线简化）。
     maxGap 保证慢变化段也有足够分辨率；误差超 tol 即落一个关键点（快攻击自然变密）。
     scale=前置恒定增益（limiter 提案实际处理 = preGain × 包络）。
     安全偏置：衰减段节点增益整体再降 bias（朝更安全方向），线性插值即便略高于真实
     增益曲线，落地后真峰值仍不超过离线验证过的上限；未衰减区强制为 1（框外语义）。 */
  function simplifyGainCurve(log, i0, i1, sr, tOffset, scale) {
    scale = scale ?? 1;
    const TOL = 0.002, BIAS = 0.0015, MAX_GAP = Math.round(0.02 * sr);
    const keep = [0];
    let start = 0;
    const n = i1 - i0;
    for (let i = 1; i < n; i++) {
      let force = i - start >= MAX_GAP;
      if (!force) {
        const g0 = log[i0 + start], g1 = log[i0 + i];
        for (let k = start + 1; k < i; k++) {
          const chord = g0 + (g1 - g0) * ((k - start) / (i - start));
          if (Math.abs(log[i0 + k] - chord) > TOL) { force = true; break; }
        }
      }
      if (force) { keep.push(i - 1); start = i - 1; }
    }
    keep.push(n - 1);
    return keep.map(k => {
      let e = log[i0 + k];                 // 限制器包络
      if (e > 0.9995) e = 1;              // 未衰减区：严格 1，框边/框外绝不引入变化
      else e = Math.max(0, e - BIAS);     // 衰减段：朝更安全方向偏置
      return { t: num((tOffset || 0) + k / sr), g: num(e * scale) };
    });
  }

  /* ---------- 提案评估：渲染 → 非破坏处理 → 度量（整区间一次流式） ----------
     处理器作用在临时渲染缓冲上，绝不触碰素材。返回修正后指标、波形与冲突差距。 */
  async function evaluateProposal(snap, a, b, proposal, preset, deps, opts) {
    opts = opts || {};
    const channels = opts.channels || snapChannels(snap);
    const chunkFrames = Math.max(SUB, Math.round((opts.chunkSec || DEFAULT_CHUNK_SEC) * ANALYSIS_SR / SUB) * SUB);
    const halo = Math.min(HALO_SEC, Math.max(0, a - snap.a));
    const renderT0 = a - halo;
    const coreStart = Math.round(halo * ANALYSIS_SR);
    const coreFrames = Math.round((b - a) * ANALYSIS_SR / SUB) * SUB;
    const totalFrames = coreStart + coreFrames;
    const m = createMeasurer(channels, coreStart, coreFrames);

    const uni = proposal.kind === 'uniform' ? Math.pow(10, proposal.gainDB / 20) : 1;
    const pre = proposal.kind === 'limiter' ? Math.pow(10, proposal.preGainDB / 20) : 1;
    const env = proposal.kind === 'envelope' ? makeEnvelope(proposal.nodes, a, channels) : null;
    const lim = proposal.kind === 'limiter' ? makeLimiter({
      ceilingDBTP: proposal.ceilingDBTP, attackSec: proposal.attackSec,
      releaseSec: proposal.releaseSec, lookaheadSec: proposal.lookaheadSec, channels,
      recordGain: true,
    }) : null;
    const delay = lim ? lim.delaySamples : 0;

    // 输出覆盖输入位置 0..（连续）；统计核心按输入时间 [coreStart, +coreFrames)，
    // 末尾用 flush + 零填充把延迟段补齐，因此度量区间与原节目严格等长。
    let inProc = 0;
    const wave = opts.collectWave
      ? { npx: opts.collectWave | 0, min: new Float32Array(opts.collectWave | 0).fill(1), max: new Float32Array(opts.collectWave | 0).fill(-1) }
      : null;
    function collectWave(out, outStartInput) {
      const frames = out.length / channels;
      const per = coreFrames / wave.npx;
      for (let i = 0; i < frames; i++) {
        const inPos = outStartInput + i;
        if (inPos < coreStart || inPos >= coreStart + coreFrames) continue;
        const px = Math.min(wave.npx - 1, Math.floor((inPos - coreStart) / per));
        for (let c = 0; c < channels; c++) {
          const v = out[i * channels + c];
          if (v < wave.min[px]) wave.min[px] = v;
          if (v > wave.max[px]) wave.max[px] = v;
        }
      }
    }
    function feed(out) {
      const outStartInput = inProc - out.length / channels;
      m.feed(out);
      if (wave) collectWave(out, outStartInput);
    }

    const shouldCancel = opts.shouldCancel || (() => false);
    const isPaused = opts.isPaused || (() => false);
    const yieldControl = deps.yieldControl || (() => Promise.resolve());

    let done = 0;
    while (done < totalFrames) {
      if (shouldCancel()) return { status: 'canceled' };
      while (isPaused()) {
        if (shouldCancel()) return { status: 'canceled' };
        await sleep(opts.pausePollMs || 60);
      }
      const f1 = Math.min(totalFrames, done + chunkFrames);
      const t0 = renderT0 + done / ANALYSIS_SR;
      const t1 = renderT0 + f1 / ANALYSIS_SR;
      await deps.renderMix(snap, t0, t1, channels, (raw) => {
        const mix = new Float32Array(raw); // 临时缓冲：不写素材
        if (pre !== 1) for (let i = 0; i < mix.length; i++) mix[i] *= pre;
        if (env) env.process(mix, t0);
        if (uni !== 1) for (let i = 0; i < mix.length; i++) mix[i] *= uni;
        if (lim) {
          const o = lim.push(mix);
          inProc += mix.length / channels;
          if (o.length) feed(o);
        } else {
          inProc += mix.length / channels;
          feed(mix);
        }
      }, ANALYSIS_SR);
      done = f1;
      if (opts.onProgress) opts.onProgress(f1 / totalFrames);
      await yieldControl();
    }
    if (lim) {
      // flush 覆盖最后 look 个输入帧（其后为零），保证核心末端被统计
      const tail = lim.flush();
      if (tail.length) feed(tail);
    }
    m.finish();
    const seg = [{ segT: a, coreFrames, channels, e100: m.e100, tpMax: m.tpMax() }];
    const { metrics, evaluation } = metricsFromSegments(seg, preset);
    const conflicts = [];
    if (!evaluation.integPass) {
      conflicts.push({
        kind: 'integrated',
        gap: metrics.integrated === null ? null : metrics.integrated - preset.target,
        measured: metrics.integrated,
      });
    }
    if (!evaluation.tpPass) {
      conflicts.push({ kind: 'peak', over: metrics.truePeak === null ? null : metrics.truePeak - preset.maxTP, measured: metrics.truePeak });
    }
    return {
      status: 'done', proposal, metrics, evaluation, conflicts,
      feasible: conflicts.length === 0,
      limiterStats: lim ? lim.stats() : null,
      gainNodes: proposalGainNodes(proposal, a, b,
        lim ? { log: lim.gainLog, coreStartFrame: coreStart, sr: ANALYSIS_SR, scale: pre } : null),
      wave,
    };
  }

  /* ---------- 提案「烤轨」：整区间渲染+处理，产出连续交错 PCM（应用为新媒体用） ---------- */

  async function renderProcessed(snap, a, b, proposal, deps, opts) {
    opts = opts || {};
    const channels = opts.channels || snapChannels(snap);
    const chunkFrames = Math.max(SUB, Math.round((opts.chunkSec || DEFAULT_CHUNK_SEC) * ANALYSIS_SR / SUB) * SUB);
    const coreFrames = Math.round((b - a) * ANALYSIS_SR / SUB) * SUB;
    const uni = proposal.kind === 'uniform' ? Math.pow(10, proposal.gainDB / 20) : 1;
    const pre = proposal.kind === 'limiter' ? Math.pow(10, proposal.preGainDB / 20) : 1;
    const env = proposal.kind === 'envelope' ? makeEnvelope(proposal.nodes, a, channels) : null;
    const lim = proposal.kind === 'limiter' ? makeLimiter({
      ceilingDBTP: proposal.ceilingDBTP, attackSec: proposal.attackSec,
      releaseSec: proposal.releaseSec, lookaheadSec: proposal.lookaheadSec, channels,
    }) : null;
    const parts = [];
    let framesIn = 0;
    const shouldCancel = opts.shouldCancel || (() => false);
    const yieldControl = deps.yieldControl || (() => Promise.resolve());
    let done = 0;
    while (done < coreFrames) {
      if (shouldCancel()) return { status: 'canceled' };
      const f1 = Math.min(coreFrames, done + chunkFrames);
      await deps.renderMix(snap, a + done / ANALYSIS_SR, a + f1 / ANALYSIS_SR, channels, (raw) => {
        const mix = new Float32Array(raw);
        if (pre !== 1) for (let i = 0; i < mix.length; i++) mix[i] *= pre;
        if (env) env.process(mix, a + framesIn / ANALYSIS_SR);
        if (uni !== 1) for (let i = 0; i < mix.length; i++) mix[i] *= uni;
        framesIn += mix.length / channels;
        if (lim) { const o = lim.push(mix); if (o.length) parts.push(o); }
        else parts.push(mix);
      }, ANALYSIS_SR);
      done = f1;
      if (opts.onProgress) opts.onProgress(f1 / coreFrames);
      await yieldControl();
    }
    if (lim) { const tail = lim.flush(); if (tail.length) parts.push(tail); }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const pcm = new Float32Array(total);
    let o = 0; for (const p of parts) { pcm.set(p, o); o += p.length; }
    // 限制器延迟导致前导/尾部长度差：裁/补到精确 coreFrames
    const out = new Float32Array(coreFrames * channels);
    out.set(pcm.subarray(0, Math.min(pcm.length, out.length)), 0);
    return { status: 'done', pcm: out, sampleRate: ANALYSIS_SR, channels: channels, frames: coreFrames };
  }

  /* ---------- CRC32 缓存帧（与 wal-core 同算法） ---------- */

  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const SEG_MAGIC = 'LS1'; // 3 字节 + 1 保留零字节
  function encodeSegmentRecord(rec) {
    const payload = new TextEncoder().encode(JSON.stringify(rec));
    const buf = new Uint8Array(8 + payload.length);
    buf.set(new TextEncoder().encode(SEG_MAGIC), 0);
    new DataView(buf.buffer).setUint32(4, crc32(payload), true);
    buf.set(payload, 8);
    return buf;
  }
  function decodeSegmentRecord(bytes) {
    if (!bytes || bytes.length < 9) return { ok: false, reason: '响度缓存记录过短' };
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
    if (magic !== SEG_MAGIC) return { ok: false, reason: '响度缓存魔数错误' };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const want = dv.getUint32(4, true);
    const payload = bytes.subarray(8);
    if (crc32(payload) !== want) return { ok: false, reason: '响度缓存 CRC 校验失败' };
    try { return { ok: true, rec: JSON.parse(new TextDecoder().decode(payload)) }; }
    catch (e) { return { ok: false, reason: '响度缓存 JSON 解析失败' }; }
  }

  return {
    ANALYSIS_SR, ANALYSIS_CH, SUB_MS, SHORT_MS, LRA_MS, SUB, HALO_SEC,
    DEFAULT_SEGMENT_SEC, DEFAULT_CHUNK_SEC, PRESETS,
    kCoef48, kState, kStep,
    buildOversampler, tpState, tpProcess,
    createMeasurer, assembleMetrics, findViolations, evaluate, metricsFromSegments,
    hydrateSegment, stashSegment,
    planSegments, segmentFingerprint, clipFingerprint, bufUid,
    analyzeSegment,
    makeEnvelope, makeLimiter,
    planUniform, planEnvelope, planLimiter,
    proposalGainNodes, simplifyGainCurve,
    evaluateProposal, renderProcessed,
    crc32, encodeSegmentRecord, decodeSegmentRecord,
    meanSquaresToLUFS,
  };
});
