'use strict';

// Shared Web Serial session (single connection + single read loop).
// Exposed as a global for use by classic <script> pages.

(function initSerialSession(global) {
  class SerialSession {
    constructor() {
      this._port = null;
      this._reader = null;
      this._writer = null;
      this._active = false;
      this._buf = '';
      this._lineListeners = new Set();
      this._stateListeners = new Set();
      this._byteListeners = new Set();
      this._textDecoder = new TextDecoder();
      this._textEncoder = new TextEncoder();
    }

    get connected() {
      return !!this._port && this._active;
    }

    onLine(cb) {
      this._lineListeners.add(cb);
      return () => this._lineListeners.delete(cb);
    }

    onState(cb) {
      this._stateListeners.add(cb);
      return () => this._stateListeners.delete(cb);
    }

    onBytes(cb) {
      this._byteListeners.add(cb);
      return () => this._byteListeners.delete(cb);
    }

    _emitState() {
      for (const cb of this._stateListeners) {
        try {
          cb({ connected: this.connected });
        } catch {
          // ignore listener errors
        }
      }
    }

    ingestText(chunk) {
      this._buf += chunk;
      const lines = this._buf.split('\n');
      this._buf = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.replace(/\r/g, '').trim();
        if (!line) continue;
        for (const cb of this._lineListeners) {
          try {
            cb(line);
          } catch {
            // ignore listener errors
          }
        }
      }
    }

    async connect(baudRate) {
      if (!('serial' in navigator)) throw new Error('Web Serial API not available');
      if (this.connected) return;

      this._port = await navigator.serial.requestPort();
      await this._port.open({ baudRate });
      this._writer = this._port.writable.getWriter();
      this._active = true;
      this._emitState();

      this._readLoop().catch(() => {});
    }

    async _readLoop() {
      if (!this._port || !this._port.readable) return;
      while (this._active && this._port && this._port.readable) {
        this._reader = this._port.readable.getReader();
        try {
          while (this._active) {
            const { value, done } = await this._reader.read();
            if (done) break;
            if (value) {
              for (const cb of this._byteListeners) {
                try { cb(value); } catch { /* ignore */ }
              }
              this.ingestText(this._textDecoder.decode(value, { stream: true }));
            }
          }
        } finally {
          try {
            this._reader.releaseLock();
          } catch {
            // ignore
          }
          this._reader = null;
        }
      }
    }

    async disconnect() {
      this._active = false;

      try {
        if (this._reader) await this._reader.cancel();
      } catch {
        // ignore
      }

      try {
        if (this._writer) this._writer.releaseLock();
      } catch {
        // ignore
      }

      this._reader = null;
      this._writer = null;

      try {
        if (this._port) await this._port.close();
      } catch {
        // ignore
      }

      this._port = null;
      this._emitState();
    }

    checksum(sentence) {
      let cs = 0;
      for (const ch of sentence) cs ^= ch.charCodeAt(0);
      return cs.toString(16).toUpperCase().padStart(2, '0');
    }

    async sendSentenceBody(sentence) {
      if (!this._writer) throw new Error('Not connected');
      const cs = this.checksum(sentence);
      const msg = `$${sentence}*${cs}\r\n`;
      await this._writer.write(this._textEncoder.encode(msg));
    }

    async sendBytes(bytes) {
      if (!this._writer) throw new Error('Not connected');
      await this._writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }
  }

  global.SerialSession = SerialSession;
})(window);
