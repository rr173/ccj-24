'use strict';

/* ================= WAV 导出核心（纯计算，无 DOM） =================
   浏览器里通过 <script> 挂到 window；Node 里通过 module.exports 导出，便于单元测试。
   渲染管线：快照 → 逐块累加混音（块间可让出事件循环/响应取消）→ 逐块编码 → Blob 组装。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const IS_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  /* ---------- 错误 ---------- */

  function throwMsg(msg) { const e = new Error(msg); e.__exportMsg = true; throw e; }

  function friendlyError(err) {
    if (err && err.__exportMsg) return err.message;
    const msg = String((err && err.message) || err);
    if (err instanceof RangeError || /memory|allocation|array buffer|invalid array|out of memory/i.test(msg)) {
      return '浏览器资源不足，导出失败（可缩短区间或降低输出规格后重试）';
    }
    return '导出失败：' + msg;
  }

  /* ---------- 工具 ---------- */

  function bytesPerFrame(spec) {
    return spec.channels * (spec.bitDepth === '16' ? 2 : spec.bitDepth === '24' ? 3 : 4);
  }

  function fmtBytes(n) {
    if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + ' GB';
    if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
    if (n >= 1 << 10) return (n / (1 << 10)).toFixed(1) + ' KB';
    return n + ' B';
  }

  /* AudioBuffer → 会话内稳定 id（快照指纹用；同一缓冲对象 id 不变） */
  const bufferIds = new WeakMap();
  let bufferIdSeq = 1;
  function bufferUid(buf) {
    let id = bufferIds.get(buf);
    if (!id) { id = bufferIdSeq++; bufferIds.set(buf, id); }
    return id;
  }

  /* 快照 + 输出规格的指纹：相同区间、相同片段内容与参数、相同规格 ⇒ 相同指纹 */
  function snapshotFingerprint(snap, spec) {
    const num = v => +(+v).toFixed(6);
    const head = [num(snap.a), num(snap.b), spec.sampleRate, spec.channels, spec.bitDepth].join('|');
    const body = snap.clips.map(c => [
      bufferUid(c.buffer), num(c.offset), num(c.gain),
      num(c.fadeIn), num(c.fadeOut), num(c.duration),
    ].join(',')).join(';');
    return head + '#' + body;
  }

  /* ---------- 声道布局统一 ----------
     返回每个输出声道的 [输入声道, 权重] 列表；无法转换返回 null。 */
  function buildChannelMap(inCh, outCh) {
    if (!(inCh >= 1) || !(outCh >= 1)) return null;
    const map = [];
    if (inCh === outCh) {
      for (let c = 0; c < outCh; c++) map.push([[c, 1]]);
    } else if (outCh === 1) {
      const w = 1 / inCh, e = [];
      for (let c = 0; c < inCh; c++) e.push([c, w]);
      map.push(e);
    } else if (inCh === 1) {
      for (let c = 0; c < outCh; c++) map.push([[0, 1]]);
    } else {
      // 多声道 → 立体声等：取前 outCh 个声道，不够的补静音
      for (let oc = 0; oc < outCh; oc++) map.push(oc < inCh ? [[oc, 1]] : []);
    }
    return map;
  }

  /* 把快照里的一个片段预处理成可渲染源；数据无效/无法转换时抛出明确错误 */
  function prepSource(sc, outCh) {
    const buf = sc.buffer;
    let inCh = 0, inSR = 0, len = 0;
    try { inCh = buf.numberOfChannels; inSR = buf.sampleRate; len = buf.length; } catch (_) {}
    if (!inCh || !len || !(inSR > 0) || !isFinite(inSR)) {
      throwMsg(`片段「${sc.name}」的音频数据无效，无法转换`);
    }
    const map = buildChannelMap(inCh, outCh);
    if (!map) throwMsg(`片段「${sc.name}」的声道布局（${inCh} 声道）无法转换为 ${outCh} 声道`);
    const data = [];
    try { for (let c = 0; c < inCh; c++) data.push(buf.getChannelData(c)); }
    catch (_) { throwMsg(`片段「${sc.name}」的音频数据不可读，无法转换`); }
    // 淡化规则与预听一致：fi+fo 超过时长时按比例压缩
    let fi = Math.min(sc.fadeIn, sc.duration), fo = Math.min(sc.fadeOut, sc.duration);
    if (fi + fo > sc.duration) { const k = sc.duration / (fi + fo); fi *= k; fo *= k; }
    return {
      data, map, inSR, len,
      cs: sc.offset, ce: sc.offset + sc.duration,
      gain: sc.gain, fi, fo,
    };
  }

  /* 把一个源在时间轴区间 [chunkT0, chunkT0 + frames/outSR) 内的贡献累加进 mix。
     输出第 i 帧 ↔ 时间轴 t = chunkT0 + i/outSR（绝对坐标计算，无累积误差）；
     源采样位置 = (t − 片段起点) × 源采样率，线性插值统一到输出采样率。 */
  function accumulate(src, mix, chunkT0, frames, outSR) {
    const { data, map, inSR, len, cs, ce, gain, fi, fo } = src;
    const outCh = map.length;
    const fiEnd = cs + fi, foStart = ce - fo;
    // t ∈ [cs, ce) ⇒ i ∈ [(cs−chunkT0)·outSR, (ce−chunkT0)·outSR)
    const i0 = Math.max(0, Math.ceil((cs - chunkT0) * outSR - 1e-9));
    const i1 = Math.min(frames, Math.ceil((ce - chunkT0) * outSR - 1e-9));
    for (let i = i0; i < i1; i++) {
      const t = chunkT0 + i / outSR;
      let g = gain;
      if (fi > 1e-9 && t < fiEnd) g *= Math.max(0, (t - cs) / fi);
      if (fo > 1e-9 && t > foStart) g *= Math.max(0, (ce - t) / fo);
      if (g === 0) continue;
      const pos = (t - cs) * inSR;
      const idx = Math.floor(pos);
      if (idx < 0 || idx >= len) continue;
      const frac = pos - idx;
      const hasNext = idx + 1 < len;
      const base = i * outCh;
      for (let oc = 0; oc < outCh; oc++) {
        const entries = map[oc];
        let v = 0;
        for (let k = 0; k < entries.length; k++) {
          const d = data[entries[k][0]];
          const s0 = d[idx];
          const s1 = hasNext ? d[idx + 1] : s0;
          v += entries[k][1] * (s0 + (s1 - s0) * frac);
        }
        mix[base + oc] += v * g;
      }
    }
  }

  /* ---------- WAV 编码 ---------- */

  function buildWavHeader(dataBytes, channels, sampleRate, bitDepth) {
    const isFloat = bitDepth === '32f';
    const bits = isFloat ? 32 : parseInt(bitDepth, 10);
    const blockAlign = channels * bits / 8;
    const b = new ArrayBuffer(44);
    const v = new DataView(b);
    const wstr = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, isFloat ? 3 : 1, true);      // 1=PCM, 3=IEEE float
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * blockAlign, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, bits, true);
    wstr(36, 'data'); v.setUint32(40, dataBytes, true);
    return new Uint8Array(b);
  }

  /* 把一块交错浮点混音编码成 WAV 数据字节。整型格式截幅到满量程；32f 保留真实电平。 */
  function encodeChunk(mix, bitDepth) {
    const n = mix.length;
    if (bitDepth === '32f') return new Uint8Array(mix.buffer, mix.byteOffset, n * 4);
    if (bitDepth === '16') {
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        let v = mix[i];
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        out[i] = Math.round(v < 0 ? v * 0x8000 : v * 0x7FFF);
      }
      return new Uint8Array(out.buffer);
    }
    // 24-bit PCM，小端 3 字节
    const out = new Uint8Array(n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      let v = mix[i];
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      const s = Math.round(v < 0 ? v * 0x800000 : v * 0x7FFFFF);
      out[j] = s & 0xff; out[j + 1] = (s >> 8) & 0xff; out[j + 2] = (s >> 16) & 0xff;
    }
    return out;
  }

  /* ---------- 渲染管线 ----------
     snap: {a, b, clips:[…]}（提交时刻冻结的快照）
     spec: {sampleRate, channels, bitDepth}
     opts: chunkFrames / shouldCancel() / onProgress(p) / yieldControl()
     返回 {canceled:true} 或 {canceled:false, parts, frames}。
     取消时不返回任何 parts —— 不留可下载的半成品。 */
  async function renderWav(snap, spec, opts) {
    opts = opts || {};
    const chunkFrames = opts.chunkFrames || (1 << 16);
    const shouldCancel = opts.shouldCancel || (() => false);
    const onProgress = opts.onProgress || (() => {});
    const yieldControl = opts.yieldControl || (() => Promise.resolve());
    const outSR = spec.sampleRate, outCh = spec.channels;
    // 起止位置与样本数严格对应：N = round((b − a) × 输出采样率)
    const N = Math.round((snap.b - snap.a) * outSR);
    if (!(N > 0)) throwMsg('导出区间无效');
    if (!IS_LE) throwMsg('当前平台不支持 WAV 编码');
    const dataBytes = N * bytesPerFrame(spec);
    if (dataBytes > 0xFFFFFFFF - 36) throwMsg('预计文件超过 WAV 格式 4GB 上限');
    const srcs = snap.clips.map(sc => prepSource(sc, outCh));
    const parts = [buildWavHeader(dataBytes, outCh, outSR, spec.bitDepth)];
    let doneFrames = 0, progress = 0;
    while (doneFrames < N) {
      if (shouldCancel()) return { canceled: true, frames: N };
      const frames = Math.min(chunkFrames, N - doneFrames);
      const mix = new Float32Array(frames * outCh); // 静音区自然为 0
      const t0 = snap.a + doneFrames / outSR;
      const t1 = snap.a + (doneFrames + frames) / outSR;
      for (const s of srcs) {
        if (s.ce <= t0 || s.cs >= t1) continue;
        accumulate(s, mix, t0, frames, outSR); // 重叠片段在 mix 上按增益相加
      }
      parts.push(encodeChunk(mix, spec.bitDepth));
      doneFrames += frames;
      progress = Math.max(progress, doneFrames / N); // 进度只向前
      onProgress(progress);
      await yieldControl();
    }
    return { canceled: false, parts, frames: N };
  }

  /* 离线混音到任意 [t0,t1)，按块回调交错 PCM。响度分析共用这一条混音路径，
     因此分析与实际播放/导出反映同样的重叠、增益、淡化与重采样。
     onChunk 可以返回 Promise（响度分析借此在块边界暂停/取消）；这里必须 await。 */
  async function renderMix(snap, t0, t1, outCh, onChunk, outSR, opts) {
    opts = opts || {};
    const sr = outSR || 48000;
    const N = Math.round((t1 - t0) * sr);
    if (!(N > 0)) throwMsg('渲染区间无效');
    const srcs = snap.clips
      .filter(c => c.offset < t1 && c.offset + c.duration > t0)
      .map(c => prepSource(c, outCh));
    const chunkFrames = opts.chunkFrames || (1 << 15);
    let done = 0;
    while (done < N) {
      if (opts.shouldCancel && opts.shouldCancel()) return { canceled: true, frames: N };
      const frames = Math.min(chunkFrames, N - done);
      const mix = new Float32Array(frames * outCh);
      const ct0 = t0 + done / sr;
      for (const s of srcs) {
        if (s.ce <= ct0 || s.cs >= ct0 + frames / sr) continue;
        accumulate(s, mix, ct0, frames, sr);
      }
      await onChunk(mix);
      done += frames;
      if (opts.yieldControl) await opts.yieldControl();
    }
    return { canceled: false, frames: N };
  }

  return {
    IS_LE, throwMsg, friendlyError,
    bytesPerFrame, fmtBytes,
    bufferUid, snapshotFingerprint,
    buildChannelMap, prepSource, accumulate,
    buildWavHeader, encodeChunk, renderWav, renderMix,
  };
});
