'use strict';

/* ================= 预写日志（WAL）核心：纯逻辑 + 可注入 KV =================
   持久化模型（三类键，全部存在同一个 KV 空间）：
     meta/manifest        清单：已确认提交的帧序列、快照锚点、保存期簿记
     wal/frame/<12位seq>  一帧 = 一条历史记录（JSON 文本或快照），CRC32C 校验
     wal/blob/<hash>      音频原始字节（去重，按内容哈希存一份）

   为什么帧一记录一键 + manifest 记「确认位」：
   - 浏览器 IndexedDB 的单次事务是原子的，但「写帧」和「更新清单」是两步，
     页面可能在两步之间关闭。恢复时以 manifest.committed 为准：已写帧但未确认
     ⇒ 视为未落盘；已确认但帧损坏/截断 ⇒ 保留最后一个完整位置并报告丢失的记录。
   - 快速连续操作与后台保存并发时，保存严格 FIFO：commit 的顺序就是 seq 顺序，
     恢复时按 seq 重放，顺序与页面关闭前完全一致。 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const MANIFEST_KEY = 'meta/manifest';
  const FRAME_PREFIX = 'wal/frame/';
  const SNAP_PREFIX = 'wal/snap/';   // 快照帧独立键空间，不与操作帧争 seq
  const BLOB_PREFIX = 'wal/blob/';
  const FRAME_DIGITS = 12;
  const WAL_VERSION = 1;

  /* 帧类型 */
  const T_OP = 1;        // 一次历史提交
  const T_SNAPSHOT = 2; // 压缩快照（其 anchorSeq 之前的帧只是重放优化，不删除语义节点）

  /* ---------- CRC32（IEEE 802.3，与 zlib 一致） ---------- */

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

  function textBytes(s) { return new TextEncoder().encode(s); }
  function bytesText(b) { return new TextDecoder().decode(b); }

  /* ---------- 帧编解码 ----------
     二进制布局：magic(2)="WL" | ver(1) | type(1) | seq(4 BE) | payloadLen(4 BE) | crc(4 BE) | payload
     一帧必须整体完整且 CRC 正确才算数 —— 日志写一半 / 最后一条损坏都能在边界处检出。 */

  const HEADER_LEN = 2 + 1 + 1 + 4 + 4 + 4;

  function encodeFrame(type, seq, payloadBytes) {
    const buf = new Uint8Array(HEADER_LEN + payloadBytes.length);
    const dv = new DataView(buf.buffer);
    buf[0] = 0x57; buf[1] = 0x4c; // "WL"
    buf[2] = WAL_VERSION; buf[3] = type;
    dv.setUint32(4, seq >>> 0, false);
    dv.setUint32(8, payloadBytes.length, false);
    buf.set(payloadBytes, HEADER_LEN);
    dv.setUint32(HEADER_LEN - 4, crc32(payloadBytes), false);
    return buf;
  }

  function decodeFrame(bytes) {
    if (bytes.length < HEADER_LEN) return { ok: false, reason: '帧长度小于帧头（写入中断）' };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] !== 0x57 || bytes[1] !== 0x4c) return { ok: false, reason: '帧头魔数错误' };
    if (bytes[2] !== WAL_VERSION) return { ok: false, reason: '不支持的日志版本 ' + bytes[2] };
    const type = bytes[3];
    const seq = dv.getUint32(4, false);
    const len = dv.getUint32(8, false);
    if (len !== bytes.length - HEADER_LEN) {
      return { ok: false, reason: `帧长度不匹配（头声明 ${len}，实际 ${bytes.length - HEADER_LEN}，写入中断）`, seq };
    }
    const payload = bytes.subarray(HEADER_LEN);
    const want = dv.getUint32(12, false);
    const got = crc32(payload);
    if (want !== got) return { ok: false, reason: `CRC 校验失败（期望 ${want}，实际 ${got}，记录损坏）`, seq };
    return { ok: true, type, seq, payload };
  }

  function frameKey(seq) { return FRAME_PREFIX + String(seq).padStart(FRAME_DIGITS, '0'); }
  function seqFromKey(k) { return parseInt(k.slice(FRAME_PREFIX.length), 10); }
  function blobKey(hash) { return BLOB_PREFIX + hash; }

  /* ---------- 内存 KV（Node 测试用；浏览器侧用 IndexedDB 实现同一接口） ---------- */

  function memKV() {
    const m = new Map();
    return {
      get(k) { return m.has(k) ? m.get(k) : null; },
      put(k, v) { m.set(k, v); },
      del(k) { m.delete(k); },
      keys(prefix) {
        const out = [];
        for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) out.push(k);
        return out.sort();
      },
      /* 可选：测试/浏览器实现批量原子写 */
      putMany(entries) { for (const [k, v] of entries) m.set(k, v); },
    };
  }

  /* ---------- 主对象 ---------- */

  /* kv 需实现 get/put/del/keys；clock 用于记录写入时间（便于诊断丢失）。 */
  function createWAL(kv, opts) {
    opts = opts || {};
    let manifest = null;
    let saveQueue = Promise.resolve();   // FIFO：所有写操作排队，顺序 = 提交顺序
    let pendingCount = 0;               // 已提交但尚未确认落盘的帧数（保存状态指示）
    const listeners = new Set();

    function emit() { for (const fn of listeners) { try { fn(status()); } catch (_) {} } }
    function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    function status() {
      return {
        pending: pendingCount,
        saving: pendingCount > 0,
        lastSeq: manifest ? manifest.committed : 0,
        snapshotSeq: manifest ? manifest.snapshotSeq : 0,
      };
    }

    async function readManifestRaw() {
      const raw = await kv.get(MANIFEST_KEY);
      if (!raw) return null;
      if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
        try { return JSON.parse(bytesText(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw)); }
        catch (e) { return { __corrupt: true, error: e.message }; }
      }
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch (e) { return { __corrupt: true, error: e.message }; }
    }

    /* 打开 / 恢复：按 seq 重放所有已确认帧；尾部损坏或空洞停在最后完整位置。 */
    async function open(handle) {
      handle = handle || {};
      const problems = [];
      let m = await readManifestRaw();
      if (m && m.__corrupt) {
        problems.push('清单（manifest）损坏：' + m.error + ' —— 改用帧扫描恢复最近完整状态');
        m = null;
      }
      let frames = [];
      const allKeys = await kv.keys(FRAME_PREFIX);
      const keys = allKeys.filter(k => {
        const n = seqFromKey(k); return Number.isFinite(n);
      }).sort();
      for (const k of keys) {
        const bytes = asBytes(await kv.get(k));
        const dec = decodeFrame(bytes);
        if (!dec.ok) {
          problems.push(`日志帧 ${seqFromKey(k)} 不可读：${dec.reason}`);
          break; // 之后的帧一律先不采信（可能跨过未确认段）
        }
        frames.push(dec);
      }
      if (!m) {
        // 清单丢了：只能信任「从 seq=1 连续、且帧体可解析为 JSON」的前缀
        m = { committed: 0, snapshotSeq: 0, epoch: 1 };
        let expect = 1;
        const good = [];
        for (const f of frames) {
          if (f.seq !== expect) { problems.push(`帧序列在 ${expect} 处断档（发现 seq=${f.seq}），其后记录未确认，已停在最后完整位置`); break; }
          try { JSON.parse(bytesText(f.payload)); }
          catch (e) { problems.push(`帧 ${f.seq} 内容无法解析（${e.message}），已停在最后完整位置`); break; }
          good.push(f); expect++;
        }
        frames = good;
        m.committed = good.length ? good[good.length - 1].seq : 0;
      } else {
        // 有清单：只采信 seq <= committed 且连续的帧；committed 之后的是「帧已写、未确认」
        frames = frames.filter(f => f.seq <= m.committed).sort((a, b) => a.seq - b.seq);
        const good = [];
        let expect = (m.snapshotSeq || 0) + 1;
        for (const f of frames) {
          if (f.seq < expect) continue;
          if (f.seq !== expect) {
            problems.push(`已确认帧在 ${expect} 处缺失（发现 seq=${f.seq}），恢复到最后完整位置 ${expect - 1}`);
            break;
          }
          good.push(f); expect++;
        }
        frames = good;
        const actualCommitted = good.length ? good[good.length - 1].seq : (m.snapshotSeq || 0);
        if (actualCommitted < m.committed) {
          problems.push(`清单确认到第 ${m.committed} 条，但完整日志只到第 ${actualCommitted} 条；第 ${actualCommitted + 1}–${m.committed} 条未保存成功，已保留最近完整状态`);
          m.committed = actualCommitted;
        }
      }

      // 读取快照帧（独立键），再重放其后的操作帧
      let snapshot = null;
      const ops = [];
      if (m.snapshotSeq) {
        const sb = await kv.get(SNAP_PREFIX + m.snapshotSeq);
        if (sb == null) {
          problems.push(`清单指向的第 ${m.snapshotSeq} 条快照丢失，将从头重放完整日志`);
        } else {
          const dec = decodeFrame(asBytes(sb));
          if (!dec.ok) {
            problems.push(`快照帧不可读：${dec.reason}，将从头重放完整日志`);
          } else {
            try { snapshot = { seq: m.snapshotSeq, data: JSON.parse(bytesText(dec.payload)) }; }
            catch (e) { problems.push(`快照帧 ${m.snapshotSeq} 解析失败：${e.message}（将忽略该快照）`); }
          }
        }
      }
      for (const f of frames) {
        if (f.type !== T_OP) continue;
        if (snapshot && f.seq <= snapshot.seq) continue; // 锚点及之前已包含在快照中
        try { ops.push({ seq: f.seq, data: JSON.parse(bytesText(f.payload)) }); }
        catch (e) { problems.push(`操作帧 ${f.seq} JSON 损坏：${e.message}`); }
      }
      manifest = m;
      emit();
      return {
        manifest: m, frames: ops, snapshot, problems,
        baseSeq: snapshot ? snapshot.seq : (m.snapshotSeq && snapshot ? m.snapshotSeq : 0),
      };
    }

    /* 追加一条操作记录。返回 Promise，resolve 即「已确认落盘、刷新后可恢复」。
       seq 在 FIFO 队列任务内按当前 committed+1 分配：即使前一帧写失败，
       后一帧仍得到连续序号，恢复时不会留下空洞。 */
    function append(record) {
      pendingCount++;
      emit();
      const job = async () => {
        const seq = (manifest ? manifest.committed : 0) + 1;
        try {
          const payload = textBytes(JSON.stringify(record));
          const frame = encodeFrame(T_OP, seq, payload);
          await kvPut(frameKey(seq), frame);
          // 帧落盘后再翻清单确认位 —— 两步之间崩溃 ⇒ 该帧恢复时不被采信
          const next = {
            committed: seq,
            snapshotSeq: manifest ? manifest.snapshotSeq : 0,
            epoch: manifest ? manifest.epoch : 1,
            at: Date.now(),
          };
          await kvPut(MANIFEST_KEY, textBytes(JSON.stringify(next)));
          manifest = next;
          return seq;
        } finally {
          pendingCount--;
          emit();
        }
      };
      const result = saveQueue.then(job, job);
      saveQueue = result.catch(() => {});
      return result;
    }

    /* 入队辅助：对外 Promise 保留成败，内部队列永不传播拒绝，后续任务不被拖垮 */
    function enqueue(jobFn) {
      const result = saveQueue.then(jobFn, jobFn);
      saveQueue = result.catch(() => {});
      return result;
    }

    /* 删除快照之前的操作帧（仅在快照确认后调用）。压缩只动存储层，历史节点不删。 */
    function cleanupOldFrames() {
      const before = manifest ? manifest.snapshotSeq : 0;
      if (!before) return Promise.resolve(0);
      return enqueue(async () => {
        let n = 0;
        for (const k of await kv.keys(FRAME_PREFIX)) {
          const s = seqFromKey(k);
          if (Number.isFinite(s) && s < before) { await kv.del(k); n++; }
        }
        return n;
      });
    }

    /* 写压缩快照（独立键，不占用操作帧 seq）。快照锚点 = 入队执行时已确认的最后一帧
       committed，从而不会把「还在队列里的帧」错误地并入快照。快照确认后，
       snapshotSeq 之前的操作帧可由 cleanupOldFrames 删除。 */
    function writeSnapshot(snapshotData) {
      const job = async () => {
        const seq = manifest ? manifest.committed : 0;
        const payload = textBytes(JSON.stringify(snapshotData));
        const frame = encodeFrame(T_SNAPSHOT, seq, payload);
        await kvPut(SNAP_PREFIX + seq, frame);
        const next = {
          committed: seq,
          snapshotSeq: seq,
          epoch: manifest ? manifest.epoch : 1,
          at: Date.now(),
        };
        await kvPut(MANIFEST_KEY, textBytes(JSON.stringify(next)));
        manifest = next;
        emit();
        return seq;
      };
      return enqueue(job);
    }

    /* ---------- 音频 Blob 去重存储（全部异步，与 IndexedDB 实现同接口） ---------- */

    async function hasBlob(hash) { return (await kv.get(blobKey(hash))) != null; }
    async function getBlob(hash) {
      const v = await kv.get(blobKey(hash));
      return v == null ? null : asBytes(v);
    }
    async function putBlob(hash, bytes) {
      if (await hasBlob(hash)) return false;
      return enqueue(() => kvPut(blobKey(hash), bytes).then(() => true));
    }
    async function delBlob(hash) { await kv.del(blobKey(hash)); }
    async function blobHashes() {
      const ks = await kv.keys(BLOB_PREFIX);
      return ks.map(k => k.slice(BLOB_PREFIX.length));
    }

    /* ---------- 响度分段缓存（独立键空间，不占操作帧 seq） ---------- */
    const LUFS_PREFIX = 'lufs/seg/';
    function segCacheKey(fp) { return LUFS_PREFIX + fp; }
    async function putSegment(fp, bytes) {
      await kvPut(segCacheKey(fp), bytes);
      return true;
    }
    async function getSegment(fp) {
      const v = await kv.get(segCacheKey(fp));
      return v == null ? null : asBytes(v);
    }
    async function hasSegment(fp) { return (await kv.get(segCacheKey(fp))) != null; }
    async function deleteSegment(fp) { await kv.del(segCacheKey(fp)); }
    /* 删除全部响度缓存段（任务整体失效时用） */
    async function clearSegments() {
      const ks = await kv.keys(LUFS_PREFIX);
      for (const k of ks) await kv.del(k);
      return ks.length;
    }

    async function kvPut(k, v) {
      try {
        if (kv.putMany && kv.putMany.length === 1) { /* putMany 可选批量；这里单键 */ }
        await kv.put(k, v);
      } catch (e) {
        if (isQuotaError(e)) { const q = new Error('存储空间不足（QuotaExceeded）：' + k); q.code = 'QUOTA'; q.cause = e; throw q; }
        throw e;
      }
    }

    function flush() { return saveQueue; }

    return {
      open, append, writeSnapshot, cleanupOldFrames, flush,
      hasBlob, getBlob, putBlob, delBlob, blobHashes,
      putSegment, getSegment, hasSegment, deleteSegment, clearSegments,
      status, on, _kv: kv,
    };
  }

  function asBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === 'string') return textBytes(v);
    if (v && v.buffer instanceof ArrayBuffer) return new Uint8Array(v.buffer);
    return new Uint8Array(0);
  }

  function isQuotaError(e) {
    return e && (e.name === 'QuotaExceededError' || e.code === 22 ||
      /quota|space|存储|空间/i.test(String(e.message || e.name || '')));
  }

  /* ---------- 简易内容哈希（FNV-1a 64 位，双 32 位拼接） ----------
     历史/去重只需要稳定且碰撞概率极低的指纹，不依赖浏览器 crypto.subtle（非安全上下文也可用）。 */

  function hashBytes(bytes) {
    let hi = 0xcbf29ce4, lo = 0x84222325 >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      lo ^= bytes[i];
      lo = Math.imul(lo, 0x01000193) >>> 0;
      hi ^= (lo >>> 24) & 0xff;
      hi = Math.imul(hi, 0x01000193) >>> 0;
    }
    let h = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
    return h.toString(36).padStart(13, '0');
  }

  return {
    createWAL, memKV, encodeFrame, decodeFrame, crc32, hashBytes,
    frameKey, blobKey, asBytes, isQuotaError,
    T_OP, T_SNAPSHOT, MANIFEST_KEY, FRAME_PREFIX, BLOB_PREFIX,
  };
});
