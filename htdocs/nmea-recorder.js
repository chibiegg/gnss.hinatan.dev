'use strict';
// nmea-recorder.js — IndexedDB-backed NMEA session recorder
// DB: gnss_recorder v1
// Stores:
//   sessions  — keyPath: sessionId, index: startedAt, status
//   chunks    — keyPath: chunkId,   index: sessionId, [sessionId, startedAt]

(function (global) {

  const DB_NAME    = 'gnss_recorder';
  const DB_VERSION = 1;

  let _db = null;

  /** Open (or reuse) the IndexedDB database. */
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('sessions')) {
          const ss = db.createObjectStore('sessions', { keyPath: 'sessionId' });
          ss.createIndex('startedAt', 'startedAt', { unique: false });
          ss.createIndex('status',    'status',    { unique: false });
        }
        if (!db.objectStoreNames.contains('chunks')) {
          const cs = db.createObjectStore('chunks', { keyPath: 'chunkId' });
          cs.createIndex('sessionId',           'sessionId',            { unique: false });
          cs.createIndex('sessionId_startedAt', ['sessionId','startedAt'], { unique: false });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /** Wrap an IDBRequest in a Promise. */
  function req2p(r) {
    return new Promise((res, rej) => {
      r.onsuccess = (e) => res(e.target.result);
      r.onerror   = (e) => rej(e.target.error);
    });
  }

  /** Wait for a transaction to complete. */
  function tx2p(tx) {
    return new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror    = (e) => rej(e.target.error);
    });
  }

  /** Generate a short random ID. */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  /** Create a new recording session. Returns the session object. */
  async function createSession(displayName) {
    const db  = await openDB();
    const now = Date.now();
    const session = {
      sessionId:   uid(),
      startedAt:   now,
      endedAt:     null,
      status:      'recording',   // recording | stopped | interrupted
      totalChunks: 0,
      totalLines:  0,
      totalBytes:  0,
      displayName: displayName || new Date(now).toLocaleString('ja-JP'),
      createdAt:   now,
      updatedAt:   now,
    };
    const tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(session);
    await tx2p(tx);
    return session;
  }

  /** Merge fields into an existing session. */
  async function updateSession(sessionId, fields) {
    const db = await openDB();
    const tx = db.transaction('sessions', 'readwrite');
    const st = tx.objectStore('sessions');
    const s  = await req2p(st.get(sessionId));
    if (!s) { await tx2p(tx); return null; }
    Object.assign(s, fields, { updatedAt: Date.now() });
    st.put(s);
    await tx2p(tx);
    return s;
  }

  /** Mark a session as stopped, using the last chunk's endedAt (or startedAt if no chunks). */
  async function stopSession(sessionId) {
    const db = await openDB();

    // Find the last chunk's endedAt via the sessionId_startedAt index (reverse cursor)
    const lastChunkEndedAt = await new Promise((res, rej) => {
      const tx  = db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks')
                    .index('sessionId_startedAt')
                    .openCursor(
                      IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]),
                      'prev'
                    );
      req.onsuccess = (e) => {
        const c = e.target.result;
        res(c ? c.value.endedAt : null);
      };
      req.onerror = (e) => rej(e.target.error);
    });

    const tx = db.transaction('sessions', 'readwrite');
    const st = tx.objectStore('sessions');
    const s  = await req2p(st.get(sessionId));
    if (!s) { await tx2p(tx); return null; }
    s.status    = 'stopped';
    s.endedAt   = lastChunkEndedAt ?? s.startedAt;
    s.updatedAt = Date.now();
    st.put(s);
    await tx2p(tx);
    return s;
  }

  /** Return all sessions sorted newest-first. */
  async function listSessions() {
    const db  = await openDB();
    const tx  = db.transaction('sessions', 'readonly');
    const all = await req2p(tx.objectStore('sessions').getAll());
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Delete a session and all of its chunks atomically. */
  async function deleteSession(sessionId) {
    const db = await openDB();

    // Collect chunk IDs first (read-only cursor)
    const chunkIds = await new Promise((res, rej) => {
      const ids = [];
      const tx  = db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks').index('sessionId')
                    .openKeyCursor(IDBKeyRange.only(sessionId));
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { ids.push(c.primaryKey); c.continue(); }
        else res(ids);
      };
      req.onerror = (e) => rej(e.target.error);
    });

    // Delete session + chunks in one transaction
    const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
    const cs = tx.objectStore('chunks');
    for (const id of chunkIds) cs.delete(id);
    tx.objectStore('sessions').delete(sessionId);
    await tx2p(tx);
  }

  // ─── Chunks ─────────────────────────────────────────────────────────────────

  /**
   * Save a 1-second chunk.
   * rawLines  : string[] — raw NMEA lines received during this interval
   * startedAt : number  — chunk start epoch ms
   * endedAt   : number  — chunk end epoch ms
   */
  async function saveChunk(sessionId, rawLines, startedAt, endedAt) {
    if (!rawLines.length) return;
    const db    = await openDB();
    const raw   = rawLines.join('\n');
    const bytes = new TextEncoder().encode(raw).byteLength;

    const chunk = {
      chunkId:   uid(),
      sessionId,
      startedAt,
      endedAt,
      lineCount: rawLines.length,
      rawLines,
      bytes,
      points: extractPoints(rawLines),  // [{lat, lon, time}]
    };

    const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
    tx.objectStore('chunks').put(chunk);

    // Increment session counters
    const sst = tx.objectStore('sessions');
    const s   = await req2p(sst.get(sessionId));
    if (s) {
      s.totalChunks++;
      s.totalLines += rawLines.length;
      s.totalBytes += bytes;
      s.updatedAt   = Date.now();
      sst.put(s);
    }
    await tx2p(tx);
  }

  /** Return all chunks of a session in chronological order. */
  async function getChunks(sessionId) {
    const db     = await openDB();
    const chunks = [];
    await new Promise((res, rej) => {
      const tx  = db.transaction('chunks', 'readonly');
      const req = tx.objectStore('chunks')
                    .index('sessionId_startedAt')
                    .openCursor(IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]));
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { chunks.push(c.value); c.continue(); } else res();
      };
      req.onerror = (e) => rej(e.target.error);
    });
    return chunks;
  }

  // ─── Minimal coordinate extraction ─────────────────────────────────────────

  function _parseLL(val, dir) {
    if (!val) return null;
    const dot = val.indexOf('.');
    if (dot < 2) return null;
    const deg = parseFloat(val.slice(0, dot - 2));
    const min = parseFloat(val.slice(dot - 2));
    let v = deg + min / 60;
    if (dir === 'S' || dir === 'W') v = -v;
    return isNaN(v) ? null : v;
  }

  /** Extract [{lat, lon, time}] from raw NMEA lines (GGA/RMC only). */
  function extractPoints(lines) {
    const pts = [];
    for (const line of lines) {
      try {
        if (!line.startsWith('$')) continue;
        const star = line.lastIndexOf('*');
        const body = line.slice(1, star < 0 ? undefined : star);
        const p    = body.split(',');
        const mt   = p[0].slice(2);
        if (mt === 'GGA' && p.length >= 10) {
          const lat = _parseLL(p[2], p[3]);
          const lon = _parseLL(p[4], p[5]);
          if (lat !== null && lon !== null) pts.push({ lat, lon, time: p[1] });
        } else if (mt === 'RMC' && p.length >= 10 && p[2] === 'A') {
          const lat = _parseLL(p[3], p[4]);
          const lon = _parseLL(p[5], p[6]);
          if (lat !== null && lon !== null) pts.push({ lat, lon, time: p[1] });
        }
      } catch (_) {}
    }
    return pts;
  }

  // ─── Interrupted-session recovery ──────────────────────────────────────────

  /**
   * Called on page load. Any session still in 'recording' state was not closed
   * cleanly — mark it 'interrupted'. Returns the number of sessions recovered.
   *
   * Web Locks API が利用可能な場合、他タブが同じセッションのロックを保持して
   * いれば「録音継続中」と判断してスキップする。
   */
  async function recoverInterruptedSessions() {
    // 現在ロックを保持しているセッション名のセットを取得
    let heldLockNames = new Set();
    if (navigator.locks) {
      try {
        const state = await navigator.locks.query();
        heldLockNames = new Set(state.held.map(l => l.name));
      } catch (_) {}
    }

    const db  = await openDB();
    const tx  = db.transaction('sessions', 'readwrite');
    const st  = tx.objectStore('sessions');
    const all = await req2p(st.getAll());
    let   n   = 0;
    for (const s of all) {
      if (s.status === 'recording') {
        // 他タブがこのセッションのロックを保持中なら録音継続中 → スキップ
        if (heldLockNames.has('gnss_rec_' + s.sessionId)) continue;
        s.status    = 'interrupted';
        s.updatedAt = Date.now();
        st.put(s);
        n++;
      }
    }
    await tx2p(tx);
    return n;
  }

  // ─── Download helpers ───────────────────────────────────────────────────────

  /** Concatenate all raw NMEA lines in a session (CRLF line endings). */
  async function buildRawNMEA(sessionId) {
    const chunks = await getChunks(sessionId);
    return chunks.flatMap(c => c.rawLines).join('\r\n') + '\r\n';
  }

  /** Trigger a browser file download. */
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /** Download a session as a .nmea text file. */
  async function downloadSession(session) {
    const text = await buildRawNMEA(session.sessionId);
    const d    = new Date(session.startedAt);
    const ts   = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
      '_',
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
    ].join('');
    downloadText(`gnss_${ts}.nmea`, text);
  }

  /** Return all coordinate points in a session (from chunk.points). */
  async function getSessionPoints(sessionId) {
    const chunks = await getChunks(sessionId);
    return chunks.flatMap(c => c.points || []);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  global.NMEARecorder = {
    openDB,
    createSession,
    updateSession,
    stopSession,
    listSessions,
    deleteSession,
    saveChunk,
    getChunks,
    extractPoints,
    buildRawNMEA,
    downloadSession,
    getSessionPoints,
    recoverInterruptedSessions,
  };

})(window);
