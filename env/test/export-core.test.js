'use strict';

/* export-core.js 的单元测试与渲染管线集成测试（Node 环境，无浏览器依赖） */

const assert = require('assert');
const core = require('../public/export-core.js');

const {
  snapshotFingerprint, buildChannelMap, prepSource, accumulate,
  buildWavHeader, encodeChunk, renderWav, bytesPerFrame, fmtBytes, friendlyError,
} = core;

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ok - ' + name);
  }).catch(err => {
    console.error('  FAIL - ' + name);
    console.error(err);
    process.exitCode = 1;
  });
}

/* 伪 AudioBuffer（结构与浏览器一致） */
function fakeBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels.length ? channels[0].length : 0,
    duration: channels.length ? channels[0].length / sampleRate : 0,
    getChannelData(i) { return channels[i]; },
  };
}
function sineBuf(freq, dur, sr, amp) {
  const n = Math.round(dur * sr);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * freq * i / sr) * (amp == null ? 1 : amp);
  return fakeBuffer([d], sr);
}
function constBuf(value, dur, sr, ch) {
  const n = Math.round(dur * sr);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(new Float32Array(n).fill(value));
  return fakeBuffer(chans, sr);
}
function clip(over) {
  return Object.assign({
    name: 'c', buffer: null, offset: 0, gain: 1, fadeIn: 0, fadeOut: 0, duration: 0,
  }, over);
}
function readWav(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  const dv = new DataView(buf.buffer);
  return { buf, dv, total };
}
function approx(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= (eps || 1e-6), `${msg || ''} expected ${b}, got ${a}`);
}

(async () => {

  /* ---------- 快照指纹：相同快照去重、不同快照分开 ---------- */

  await test('指纹：相同区间+相同快照+相同规格 ⇒ 相同指纹', () => {
    const b = sineBuf(440, 1, 8000);
    const mk = () => ({ a: 1, b: 3, clips: [clip({ buffer: b, offset: 0.5, gain: 0.8, fadeIn: 0.1, fadeOut: 0.2, duration: 1 })] });
    const spec = { sampleRate: 44100, channels: 2, bitDepth: '16' };
    assert.strictEqual(snapshotFingerprint(mk(), spec), snapshotFingerprint(mk(), spec));
  });

  await test('指纹：参数/区间/规格任一变化 ⇒ 不同指纹', () => {
    const b = sineBuf(440, 1, 8000);
    const base = { a: 1, b: 3, clips: [clip({ buffer: b, offset: 0.5, duration: 1 })] };
    const spec = { sampleRate: 44100, channels: 2, bitDepth: '16' };
    const fp = snapshotFingerprint(base, spec);
    const diff = (snap2, spec2) => assert.notStrictEqual(snapshotFingerprint(snap2, spec2 || spec), fp);
    diff({ a: 1, b: 3, clips: [clip({ buffer: b, offset: 0.6, duration: 1 })] });          // 位置变了
    diff({ a: 1, b: 3, clips: [clip({ buffer: b, offset: 0.5, gain: 0.9, duration: 1 })] }); // 增益变了
    diff({ a: 1, b: 3, clips: [clip({ buffer: b, offset: 0.5, fadeIn: 0.1, duration: 1 })] }); // 淡化变了
    diff({ a: 1, b: 4, clips: base.clips });                                               // 区间变了
    diff(base, { sampleRate: 48000, channels: 2, bitDepth: '16' });                        // 采样率变了
    diff(base, { sampleRate: 44100, channels: 1, bitDepth: '16' });                        // 声道变了
    diff(base, { sampleRate: 44100, channels: 2, bitDepth: '24' });                        // 位深变了
    diff({ a: 1, b: 3, clips: [clip({ buffer: sineBuf(440, 1, 8000), offset: 0.5, duration: 1 })] }); // 换了缓冲
  });

  await test('指纹：片段顺序不影响指纹', () => {
    const b1 = sineBuf(440, 1, 8000), b2 = sineBuf(550, 1, 8000);
    const c1 = clip({ buffer: b1, offset: 0, duration: 1 });
    const c2 = clip({ buffer: b2, offset: 2, duration: 1 });
    const spec = { sampleRate: 44100, channels: 2, bitDepth: '16' };
    // app 侧快照已按 offset 排序；指纹本身对数组顺序敏感，这里验证排序后一致
    const s1 = { a: 0, b: 3, clips: [c1, c2].sort((x, y) => x.offset - y.offset) };
    const s2 = { a: 0, b: 3, clips: [c2, c1].sort((x, y) => x.offset - y.offset) };
    assert.strictEqual(snapshotFingerprint(s1, spec), snapshotFingerprint(s2, spec));
  });

  /* ---------- 声道布局统一 ---------- */

  await test('声道映射：直通 / 单声道复制 / 立体声平均 / 多声道截取', () => {
    assert.deepStrictEqual(buildChannelMap(1, 1), [[[0, 1]]]);
    assert.deepStrictEqual(buildChannelMap(2, 2), [[[0, 1]], [[1, 1]]]);
    assert.deepStrictEqual(buildChannelMap(1, 2), [[[0, 1]], [[0, 1]]]);
    assert.deepStrictEqual(buildChannelMap(2, 1), [[[0, 0.5], [1, 0.5]]]);
    assert.deepStrictEqual(buildChannelMap(4, 2), [[[0, 1]], [[1, 1]]]);
    assert.strictEqual(buildChannelMap(0, 2), null);
  });

  await test('prepSource：无效数据与非法声道数报「无法转换」', () => {
    assert.throws(() => prepSource(clip({ name: 'x', buffer: fakeBuffer([], 8000), duration: 1 }), 2), /无法转换/);
    const detached = { get numberOfChannels() { throw new Error('detached'); } };
    assert.throws(() => prepSource(clip({ name: 'y', buffer: detached, duration: 1 }), 2), /无法转换/);
  });

  /* ---------- 混音累加：增益 / 淡化 / 重叠 / 重采样 / 声道 ---------- */

  function renderOne(src, frames, outSR, outCh, chunkT0) {
    const mix = new Float32Array(frames * outCh);
    accumulate(prepSource(src, outCh), mix, chunkT0 || 0, frames, outSR);
    return mix;
  }

  await test('混音：恒等映射下输出等于输入（同采样率）', () => {
    const buf = constBuf(0.5, 0.01, 8000, 1);
    const mix = renderOne(clip({ buffer: buf, offset: 0, duration: 0.01 }), 80, 8000, 1);
    for (let i = 0; i < 80; i++) approx(mix[i], 0.5, 1e-7, `frame ${i}`);
  });

  await test('混音：片段增益生效', () => {
    const buf = constBuf(0.5, 0.01, 8000, 1);
    const mix = renderOne(clip({ buffer: buf, offset: 0, gain: 0.4, duration: 0.01 }), 80, 8000, 1);
    approx(mix[40], 0.2, 1e-7);
  });

  await test('混音：偏移对齐到输出采样网格', () => {
    const buf = constBuf(1, 0.005, 8000, 1); // 40 个采样
    const mix = renderOne(clip({ buffer: buf, offset: 0.0025, duration: 0.005 }), 80, 8000, 1);
    for (let i = 0; i < 20; i++) assert.strictEqual(mix[i], 0);       // 偏移前是静音
    for (let i = 20; i < 60; i++) approx(mix[i], 1, 1e-7);            // 片段本体
    for (let i = 60; i < 80; i++) assert.strictEqual(mix[i], 0);      // 结束后是静音
  });

  await test('混音：重叠片段按各自增益相加', () => {
    const b1 = constBuf(0.5, 0.01, 8000, 1), b2 = constBuf(0.25, 0.01, 8000, 1);
    const s1 = prepSource(clip({ buffer: b1, offset: 0, duration: 0.01 }), 1);
    const s2 = prepSource(clip({ buffer: b2, offset: 0.0025, gain: 2, duration: 0.01 }), 1);
    const mix = new Float32Array(100);
    accumulate(s1, mix, 0, 100, 8000);
    accumulate(s2, mix, 0, 100, 8000);
    approx(mix[10], 0.5, 1e-7);        // 只有 s1
    approx(mix[40], 0.5 + 0.5, 1e-7);  // 重叠区：0.5 + 0.25*2
    approx(mix[70], 0.5 + 0.5, 1e-7);  // 仍是重叠区（s2 到帧 100 才结束）
    approx(mix[90], 0.5, 1e-7);        // 只有 s2（s1 在帧 80 结束）
  });

  await test('混音：淡入淡出包络（含 fi+fo 超时长压缩，与预听一致）', () => {
    const buf = constBuf(1, 0.01, 8000, 1); // 80 采样
    const c = clip({ buffer: buf, offset: 0, fadeIn: 0.005, fadeOut: 0.005, duration: 0.01 });
    const mix = renderOne(c, 80, 8000, 1);
    approx(mix[0], 0, 1e-7);
    approx(mix[20], 0.5, 1e-7);   // 淡入中点
    approx(mix[40], 1, 1e-7);     // 淡入终点 = 淡出起点（fi+fo=时长）
    approx(mix[41], 0.975, 1e-7); // 已进入淡出
    approx(mix[60], 0.5, 1e-7);   // 淡出中点
    // fi+fo > duration ⇒ 按比例压缩（0.006+0.006 > 0.01 ⇒ k=0.01/0.012）
    const c2 = clip({ buffer: buf, offset: 0, fadeIn: 0.006, fadeOut: 0.006, duration: 0.01 });
    const mix2 = renderOne(c2, 80, 8000, 1);
    approx(mix2[40], 1, 1e-2);    // 压缩后中点恰好到达满幅
  });

  await test('混音：采样率不一时线性插值重采样到输出规格', () => {
    // 源 4Hz 采样率：[0, 1, 0, -1]，输出 8Hz ⇒ 中间点应插值出 0.5 / -0.5
    const buf = fakeBuffer([new Float32Array([0, 1, 0, -1])], 4);
    const mix = renderOne(clip({ buffer: buf, offset: 0, duration: 1 }), 8, 8, 1);
    approx(mix[0], 0, 1e-7);
    approx(mix[1], 0.5, 1e-7);   // 插值点
    approx(mix[2], 1, 1e-7);
    approx(mix[5], -0.5, 1e-7);
    approx(mix[6], -1, 1e-7);
  });

  await test('混音：声道布局统一到输出规格（单声道→立体声、立体声→单声道）', () => {
    const mono = constBuf(0.5, 0.005, 8000, 1);
    const m2s = renderOne(clip({ buffer: mono, offset: 0, duration: 0.005 }), 40, 8000, 2);
    approx(m2s[6], 0.5, 1e-7); approx(m2s[7], 0.5, 1e-7);
    const stereo = fakeBuffer([new Float32Array(40).fill(1), new Float32Array(40).fill(-0.5)], 8000);
    const s2m = renderOne(clip({ buffer: stereo, offset: 0, duration: 0.005 }), 40, 8000, 1);
    approx(s2m[10], 0.25, 1e-7); // (1 + -0.5) / 2
  });

  /* ---------- WAV 编码 ---------- */

  await test('WAV 头：字段与尺寸正确（16bit 立体声）', () => {
    const h = buildWavHeader(1000, 2, 44100, '16');
    const dv = new DataView(h.buffer);
    assert.strictEqual(String.fromCharCode(h[0], h[1], h[2], h[3]), 'RIFF');
    assert.strictEqual(dv.getUint32(4, true), 1036);
    assert.strictEqual(String.fromCharCode(h[8], h[9], h[10], h[11]), 'WAVE');
    assert.strictEqual(dv.getUint16(20, true), 1);      // PCM
    assert.strictEqual(dv.getUint16(22, true), 2);
    assert.strictEqual(dv.getUint32(24, true), 44100);
    assert.strictEqual(dv.getUint32(28, true), 44100 * 4);
    assert.strictEqual(dv.getUint16(32, true), 4);
    assert.strictEqual(dv.getUint16(34, true), 16);
    assert.strictEqual(dv.getUint32(40, true), 1000);
  });

  await test('WAV 头：32f 使用 IEEE float 格式标记', () => {
    const h = buildWavHeader(400, 1, 48000, '32f');
    const dv = new DataView(h.buffer);
    assert.strictEqual(dv.getUint16(20, true), 3);
    assert.strictEqual(dv.getUint16(34, true), 32);
    assert.strictEqual(dv.getUint16(32, true), 4);
  });

  await test('编码：16bit 量化、截幅与负满幅', () => {
    const out = encodeChunk(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]), '16');
    const v = new Int16Array(out.buffer);
    assert.strictEqual(v[0], 0);
    assert.strictEqual(v[1], Math.round(0.5 * 0x7FFF));
    assert.strictEqual(v[2], -0x4000);
    assert.strictEqual(v[3], 0x7FFF);
    assert.strictEqual(v[4], -0x8000);
    assert.strictEqual(v[5], 0x7FFF);   // 截幅
    assert.strictEqual(v[6], -0x8000);  // 截幅
  });

  await test('编码：24bit 小端三字节', () => {
    const out = encodeChunk(new Float32Array([1, -1, 0.5]), '24');
    assert.deepStrictEqual([...out.slice(0, 3)], [0xFF, 0xFF, 0x7F]);   // 8388607
    assert.deepStrictEqual([...out.slice(3, 6)], [0x00, 0x00, 0x80]);   // -8388608
    assert.deepStrictEqual([...out.slice(6, 9)], [0x00, 0x00, 0x40]);   // round(0.5*0x7FFFFF)=0x400000
  });

  await test('编码：32f 直通不截幅', () => {
    const src = new Float32Array([0.25, -1.5, 2.5]);
    const out = encodeChunk(src, '32f');
    const v = new Float32Array(out.buffer, out.byteOffset, 3);
    assert.strictEqual(v[0], 0.25);
    assert.strictEqual(v[1], -1.5);
    assert.strictEqual(v[2], 2.5);
  });

  /* ---------- 渲染管线（集成） ---------- */

  const SPEC = { sampleRate: 8000, channels: 1, bitDepth: '16' };
  const run = (snap, spec, opts) => renderWav(snap, spec || SPEC, opts);

  await test('管线：起止与样本数严格对应选择区间', async () => {
    const buf = constBuf(0.5, 1, 8000, 1);
    const snap = { a: 0.25, b: 1.25, clips: [clip({ buffer: buf, offset: 0, duration: 1 })] };
    const r = await run(snap, SPEC, { chunkFrames: 333 }); // 故意不对齐块
    assert.strictEqual(r.canceled, false);
    assert.strictEqual(r.frames, 8000); // (1.25-0.25)*8000
    const { dv, total } = readWav(r.parts);
    assert.strictEqual(total, 44 + 8000 * 2);
    assert.strictEqual(dv.getUint32(40, true), 8000 * 2);
    // 区间 [0.25,1.25) 与片段 [0,1) 相交 ⇒ 前 0.75s 有声、后 0.25s 静音
    assert.strictEqual(dv.getInt16(44, true), Math.round(0.5 * 0x7FFF));
    assert.strictEqual(dv.getInt16(44 + 5999 * 2, true), Math.round(0.5 * 0x7FFF));
    assert.strictEqual(dv.getInt16(44 + 6000 * 2, true), 0);
    assert.strictEqual(dv.getInt16(44 + 7999 * 2, true), 0);
  });

  await test('管线：区间长度 × 采样率 = 文件样本数（含非整数帧舍入）', async () => {
    const snap = { a: 0, b: 0.1000625, clips: [] }; // ×8000 = 800.5 ⇒ round ⇒ 801 帧
    const r = await run(snap, SPEC, {});
    assert.strictEqual(r.frames, 801);
    const { total } = readWav(r.parts);
    assert.strictEqual(total, 44 + 801 * 2);
    const snap2 = { a: 0, b: 0.0999375, clips: [] }; // ×8000 = 799.5 ⇒ 800 帧
    const r2 = await run(snap2, SPEC, {});
    assert.strictEqual(r2.frames, 800);
  });

  await test('管线：静音区写零、重叠与淡化反映到文件', async () => {
    const loud = constBuf(0.4, 1, 8000, 1);
    const snap = {
      a: 0, b: 3,
      clips: [
        clip({ buffer: loud, offset: 0, duration: 1 }),                       // [0,1)
        clip({ buffer: loud, offset: 0.5, duration: 1, fadeOut: 0.5 }),       // [0.5,1.5) 带淡出
      ],
    };
    const r = await run(snap, SPEC, {});
    const { dv } = readWav(r.parts);
    const s16 = i => dv.getInt16(44 + i * 2, true) / 0x8000;
    approx(s16(2000), 0.4, 1e-3);            // 单片段
    approx(s16(5000), 0.8, 1e-3);            // 重叠相加（淡出尚未开始：fo 在 [1.0,1.5)）
    approx(s16(10000), 0.4 * ((1.5 - 1.25) / 0.5), 1e-3); // c1 已结束，c2 淡出进行中
    assert.strictEqual(s16(16000), 0);       // 静音区
  });

  await test('管线：进度单调不减且最终为 1', async () => {
    const buf = constBuf(0.1, 2, 8000, 1);
    const snap = { a: 0, b: 2, clips: [clip({ buffer: buf, offset: 0, duration: 2 })] };
    const ps = [];
    await run(snap, SPEC, { chunkFrames: 1000, onProgress: p => ps.push(p) });
    assert.ok(ps.length >= 2);
    for (let i = 1; i < ps.length; i++) assert.ok(ps[i] >= ps[i - 1], '进度回退了');
    assert.strictEqual(ps[ps.length - 1], 1);
  });

  await test('管线：取消后无 parts，不留半成品', async () => {
    const buf = constBuf(0.1, 10, 8000, 1);
    const snap = { a: 0, b: 10, clips: [clip({ buffer: buf, offset: 0, duration: 10 })] };
    let calls = 0;
    const r = await run(snap, SPEC, { chunkFrames: 8000, shouldCancel: () => ++calls > 3 });
    assert.strictEqual(r.canceled, true);
    assert.strictEqual(r.parts, undefined);
  });

  await test('管线：块间让出控制权（导出期间页面可交互）', async () => {
    const snap = { a: 0, b: 0.5, clips: [] };
    let yields = 0;
    const r = await run(snap, SPEC, { chunkFrames: 1000, yieldControl: () => { yields++; return Promise.resolve(); } });
    assert.strictEqual(r.canceled, false);
    assert.strictEqual(yields, 4); // 4000 帧 / 1000 = 4 块 ⇒ 让出 4 次
  });

  await test('管线：无法转换的片段导致明确失败', async () => {
    const bad = { numberOfChannels: 0, sampleRate: 8000, length: 100, getChannelData() { return new Float32Array(0); } };
    const snap = { a: 0, b: 1, clips: [clip({ name: '坏片段', buffer: bad, offset: 0, duration: 1 })] };
    await assert.rejects(() => run(snap, SPEC, {}), /无法转换/);
  });

  await test('管线：超过 WAV 4GB 上限给出明确结果', async () => {
    const snap = { a: 0, b: (0xFFFFFFFF / 2) + 1, clips: [] }; // 16bit 单声道 × 该时长 > 4GB
    await assert.rejects(() => run(snap, SPEC, {}), /4GB/);
  });

  await test('管线：无效区间给出明确结果', async () => {
    await assert.rejects(() => run({ a: 1, b: 1, clips: [] }, SPEC, {}), /区间无效/);
  });

  await test('管线：不同输出规格各自正确（立体声 24bit / 单声道 32f）', async () => {
    const buf = fakeBuffer([new Float32Array(8000).fill(0.5), new Float32Array(8000).fill(-0.25)], 8000);
    const snap = { a: 0, b: 1, clips: [clip({ buffer: buf, offset: 0, duration: 1 })] };
    const r24 = await run(snap, { sampleRate: 8000, channels: 2, bitDepth: '24' }, {});
    const w24 = readWav(r24.parts);
    assert.strictEqual(w24.total, 44 + 8000 * 2 * 3);
    assert.deepStrictEqual([...w24.buf.slice(44, 47)], [0x00, 0x00, 0x40]);  // L = 0.5
    assert.deepStrictEqual([...w24.buf.slice(47, 50)], [0x00, 0x00, 0xE0]);  // R = -0.25
    const r32 = await run(snap, { sampleRate: 8000, channels: 1, bitDepth: '32f' }, {});
    const w32 = readWav(r32.parts);
    assert.strictEqual(w32.total, 44 + 8000 * 4);
    approx(w32.dv.getFloat32(44, true), 0.125, 1e-7); // (0.5 + -0.25)/2
  });

  /* ---------- 错误信息归类 ---------- */

  await test('资源不足与未知错误都有明确文案', () => {
    assert.strictEqual(friendlyError(new RangeError('Invalid array length')), '浏览器资源不足，导出失败（可缩短区间或降低输出规格后重试）');
    const e = new Error('声道布局无法转换'); e.__exportMsg = true;
    assert.strictEqual(friendlyError(e), '声道布局无法转换');
    assert.ok(friendlyError(new Error('boom')).startsWith('导出失败'));
  });

  await test('fmtBytes / bytesPerFrame', () => {
    assert.strictEqual(fmtBytes(512), '512 B');
    assert.strictEqual(fmtBytes(2048), '2.0 KB');
    assert.strictEqual(fmtBytes(3 * 1024 * 1024), '3.0 MB');
    assert.strictEqual(bytesPerFrame({ channels: 2, bitDepth: '16' }), 4);
    assert.strictEqual(bytesPerFrame({ channels: 1, bitDepth: '24' }), 3);
    assert.strictEqual(bytesPerFrame({ channels: 2, bitDepth: '32f' }), 8);
  });

  console.log(passed + ' 项测试通过');
})().catch(err => { console.error(err); process.exit(1); });
