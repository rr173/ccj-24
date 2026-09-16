'use strict';
/* midi-midi.js — MIDI 输入身份层
 *
 * 重认规则（严禁串台）：
 *   端口主键 = 平台提供的稳定 id（Chrome 上同一设备同一 USB 口通常恒定）。
 *   指纹 fp = hash(id | name | manufacturer)，给绑定表做人类可核对的展示。
 *   拔线 → 记录保留并标记 offline，绝不删除；重新插入只有 id 完全一致才重新上线。
 *   「同型号第二台」拥有不同 id，永远不会接管第一台的绑定。
 *   若同 id 设备的名称/厂牌对不上（异常情况），保持离线并标记 identityMismatch。
 *
 * 另内置虚拟设备，走与真实设备完全相同的派发路径。 */
(function (global) {
  const MConsole = global.MConsole;
  const { Emitter, shortHash, uid, now } = MConsole.util;

  const VC1_MODEL = { name: 'FauxFab VC-1', manufacturer: 'FauxFab Music' };

  function MidiHub() {
    Emitter.call(this);
    this.access = null;
    this.ports = new Map();       // id -> port record
    this.supported = !!(global.navigator && navigator.requestMIDIAccess);
    this.permission = 'unsupported';
  }
  MidiHub.prototype = Object.create(Emitter.prototype);

  MidiHub.prototype.init = async function () {
    if (!this.supported) { this.permission = 'unsupported'; return false; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.permission = 'granted';
      this._scanReal();
      this.access.onstatechange = () => this._scanReal();
      this.emit('ready');
      return true;
    } catch (e) {
      this.permission = 'denied';
      this.emit('permission-error', e);
      return false;
    }
  };

  MidiHub.prototype._scanReal = function () {
    const seen = new Set();
    if (this.access) {
      this.access.inputs.forEach(input => {
        seen.add(input.id);
        const id = 'r:' + input.id;
        const existing = this.ports.get(id);
        if (!existing) {
          const rec = this._makeRecord(id, input.name || 'MIDI 输入', input.manufacturer || '', false, input);
          this.ports.set(id, rec);
        } else {
          existing.online = true;
          existing._input = input;
          existing.lastSeen = now();
          // 身份核对：名字/厂牌漂移 → 不重认
          if (existing.name !== (input.name || '') || existing.manufacturer !== (input.manufacturer || '')) {
            existing.identityMismatch = true;
          } else {
            existing.identityMismatch = false;
          }
          this._hook(input, existing);
        }
      });
    }
    // 消失的真实端口 → 离线（保留记录）
    for (const [id, rec] of this.ports) {
      if (!rec.virtual && !seen.has(rec._rawId)) {
        if (rec.online) {
          rec.online = false;
          rec.lastLost = now();
          this.emit('port-lost', rec);
        }
      }
    }
    this.emit('ports-changed');
  };

  MidiHub.prototype._makeRecord = function (id, name, manufacturer, virtual, input) {
    const rec = {
      id, name, manufacturer, virtual: !!virtual,
      fp: shortHash(id + '|' + name + '|' + manufacturer, 6),
      online: true, identityMismatch: false,
      msgCount: 0, lastSeen: now(), lastLagMs: 0,
      _input: input || null,
      _rawId: input ? input.id : id,
    };
    if (input) this._hook(input, rec);
    this.emit('port-found', rec);
    return rec;
  };

  MidiHub.prototype._hook = function (input, rec) {
    if (input._mconsoleHooked) return;
    input._mconsoleHooked = true;
    input.onmidimessage = (e) => this._onMessage(rec, e);
  };

  MidiHub.prototype._onMessage = function (rec, e) {
    const d = e.data;
    if (!d || d.length < 2) return;
    const status = d[0] & 0xf0;
    if (status !== 0xb0) return;              // 仅 CC
    const ch = d[0] & 0x0f;
    const cc = d[1];
    if (cc >= 120) return;                    // 通道模式消息忽略
    const value = d[2];
    const t = (typeof e.receivedTime === 'number') ? e.receivedTime : now();
    this._dispatch(rec, ch, cc, value, t);
  };

  MidiHub.prototype._dispatch = function (rec, ch, cc, value, perfTime) {
    rec.msgCount++;
    rec.lastSeen = now();
    rec.lastLagMs = Math.max(0, now() - perfTime);
    this.emit('cc', {
      portId: rec.id, portName: rec.name, fp: rec.fp,
      ch, cc, value, perfTime,
    });
  };

  /** 虚拟设备走同一入口 */
  MidiHub.prototype.addVirtual = function (twinIndex) {
    const suffix = twinIndex ? ' #' + (twinIndex + 1) : '';
    const id = 'v:' + uid('dev');
    const rec = {
      id,
      name: VC1_MODEL.name + suffix,
      manufacturer: VC1_MODEL.manufacturer,
      virtual: true, fp: shortHash(id + '|' + VC1_MODEL.name + suffix + '|' + VC1_MODEL.manufacturer, 6),
      online: true, identityMismatch: false, msgCount: 0,
      lastSeen: now(), lastLagMs: 0,
      _input: null, _rawId: id,
      model: 'VC1',
    };
    this.ports.set(id, rec);
    this.emit('port-found', rec);
    this.emit('ports-changed');
    return rec;
  };

  MidiHub.prototype.removeVirtual = function (id) {
    const rec = this.ports.get(id);
    if (!rec || !rec.virtual) return;
    rec.online = false;
    rec.lastLost = now();
    this.emit('port-lost', rec);
    this.emit('ports-changed');
  };
  /** 模拟重新插回：同一个 id 才上线（验证重认） */
  MidiHub.prototype.replugVirtual = function (id) {
    const rec = this.ports.get(id);
    if (!rec) return;
    rec.online = true;
    rec.lastSeen = now();
    this.emit('port-found', rec);
    this.emit('ports-changed');
  };
  MidiHub.prototype.sendVirtualCC = function (id, ch, cc, value) {
    const rec = this.ports.get(id);
    if (!rec || !rec.online) return;
    this._dispatch(rec, ch, cc, clamp7(value), now());
  };

  function clamp7(v) { return Math.max(0, Math.min(127, Math.round(v))); }

  MidiHub.prototype.listPorts = function () {
    return Array.from(this.ports.values());
  };
  MidiHub.prototype.getPort = function (id) { return this.ports.get(id) || null; };
  MidiHub.prototype.isOnline = function (id) {
    const p = this.ports.get(id);
    return !!(p && p.online && !p.identityMismatch);
  };

  MConsole.MidiHub = MidiHub;
  MConsole.VC1_MODEL = VC1_MODEL;
})(typeof window !== 'undefined' ? window : globalThis);
