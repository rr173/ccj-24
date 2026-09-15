'use strict';

/* ================= IndexedDB KV 适配器 =================
   给 wal-core 提供 get/put/del/keys 接口。所有读写走显式事务：
   单键写入天然原子；帧 + 清单的两步原子性由 WAL 的「确认位」协议保证。
   IndexedDB 不可用（隐私模式/被禁用）时降级到内存 KV：本次会话可用，
   但明确标记为「不会在刷新后保留」，绝不假装持久化成功。 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {

  function idbKV(dbName, storeName) {
    dbName = dbName || 'audio-timeline';
    storeName = storeName || 'kv';
    let dbp = null;

    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB 不可用'));
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('打开 IndexedDB 失败'));
      });
      return dbp;
    }

    function tx(mode) {
      return open().then(db => db.transaction(storeName, mode).objectStore(storeName));
    }

    function promRequest(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB 请求失败'));
      });
    }

    return {
      persistent: true,
      async get(k) {
        const store = await tx('readonly');
        return promRequest(store.get(k));
      },
      async put(k, v) {
        const store = await tx('readwrite');
        await promRequest(store.put(v, k));
      },
      async del(k) {
        const store = await tx('readwrite');
        await promRequest(store.delete(k));
      },
      async keys(prefix) {
        const store = await tx('readonly');
        const all = await promRequest(store.getAllKeys());
        let ks = all.map(k => String(k));
        if (prefix) ks = ks.filter(k => k.startsWith(prefix));
        ks.sort();
        return ks;
      },
    };
  }

  /* 异步内存 KV（与 idbKV 同接口，Promise 化；用于降级与 Node 快速测试） */
  function memAsyncKV() {
    const m = new Map();
    return {
      persistent: false,
      get(k) { return Promise.resolve(m.has(k) ? m.get(k) : null); },
      put(k, v) { m.set(k, v); return Promise.resolve(); },
      del(k) { m.delete(k); return Promise.resolve(); },
      keys(prefix) {
        const out = [];
        for (const k of m.keys()) if (!prefix || k.startsWith(prefix)) out.push(k);
        return Promise.resolve(out.sort());
      },
    };
  }

  /* 自动选择：优先 IndexedDB，失败则降级内存并报告 */
  async function createDefaultKV(dbName) {
    try {
      const kv = idbKV(dbName);
      await kv.get('__probe__');
      return { kv, degraded: false };
    } catch (e) {
      return { kv: memAsyncKV(), degraded: true, reason: String(e.message || e) };
    }
  }

  return { idbKV, memAsyncKV, createDefaultKV };
});
