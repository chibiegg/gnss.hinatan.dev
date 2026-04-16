'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const SYS_COLOR = {
  GPS:     '#3de87a',
  GLONASS: '#2dd4e8',
  Galileo: '#c060f0',
  BeiDou:  '#f0c040',
  QZSS:    '#ff5ab7',
  SBAS:    '#f09040',
};

const SYS_NAME = {
  GPS:     'GPS',
  GLONASS: 'GLONASS',
  Galileo: 'Galileo',
  BeiDou:  'BeiDou',
  QZSS:    'QZSS',
  SBAS:    'SBAS',
};

const SYS_ABBREV = {
  GPS:     'G',
  GLONASS: 'R',
  Galileo: 'E',
  BeiDou:  'C',
  QZSS:    'J',
  SBAS:    'S',
};

const SYS_ORDER = ['GPS', 'GLONASS', 'Galileo', 'BeiDou', 'QZSS', 'SBAS'];

const FIX_INFO = {
  '0,1': { label: 'No Fix',    cls: 'bad'  },
  '1,1': { label: 'No Fix',    cls: 'bad'  },
  '1,2': { label: '2D Fix',    cls: 'warn' },
  '1,3': { label: '3D Fix',    cls: 'good' },
  '2,3': { label: 'DGPS Fix',  cls: 'good' },
  '4,3': { label: 'RTK Fix',   cls: 'good' },
  '5,3': { label: 'Float RTK', cls: 'warn' },
};

// ── GPS State ─────────────────────────────────────────────────────────────────

const gps = {
  utc_time: null, utc_date: null,
  latitude: null, lat_dir: 'N',
  longitude: null, lon_dir: 'E',
  altitude: null, geoid_sep: null,
  fix_quality: 0, fix_mode: 1, rmc_status: 'V',
  speed_kmh: null, speed_knots: null, course: null,
  pdop: null, hdop: null, vdop: null,
  cpu_usage: null, cpu_speed_mhz: null, cpu_last_update: 0,
  sbas_status: null, sbas_track: null,
  sbas_sat_id: null, sbas_elev: null, sbas_azim: null, sbas_sig: null,
  sbas_last_update: 0,
  num_sats_used: 0, sats_used_prns: [],
  satellites: {},
  raw_log: [],
  last_update: Date.now(),
};

// gsv_buf accumulates multi-page GSV sequences (keyed by talker).
// No stale-removal logic here — expiry is handled by lastSeen timestamp.
const gsv_buf = {};

// ── NMEA Parser ───────────────────────────────────────────────────────────────

function checksumOk(sentence) {
  const star = sentence.indexOf('*');
  if (star < 0) return true;
  const data = sentence.slice(1, star);
  const cs   = sentence.slice(star + 1, star + 3).toUpperCase();
  let calc = 0;
  for (const c of data) calc ^= c.charCodeAt(0);
  return calc.toString(16).toUpperCase().padStart(2, '0') === cs;
}

function parseLatLon(val, dir) {
  if (!val) return null;
  const dot = val.indexOf('.');
  const degDigits = dot - 2;
  const deg  = parseFloat(val.slice(0, degDigits));
  const mins = parseFloat(val.slice(degDigits));
  let result = deg + mins / 60.0;
  if (dir === 'S' || dir === 'W') result = -result;
  return isNaN(result) ? null : result;
}

function parseTime(t) {
  if (!t || t.length < 6) return null;
  return `${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`;
}

function parseDate(d) {
  if (!d || d.length < 6) return null;
  let yr = parseInt(d.slice(4, 6));
  yr += yr < 80 ? 2000 : 1900;
  return `${yr}-${d.slice(2,4)}-${d.slice(0,2)}`;
}

function systemFromTalker(talker, prn) {
  // 明示的なタリアを優先する。ただし GP は SBAS（PRN 33-64）の例外あり。
  // GA/GL/GB/GQ はそのまま星座に対応するため PRN 範囲に関わらずタリア優先。
  // GN（マルチコンステレーション）や不明なタリアは正規化済み PRN 範囲で判定する。
  if (talker === 'GA') return 'Galileo';
  if (talker === 'GL') return 'GLONASS';
  if (talker === 'GB' || talker === 'BD') return 'BeiDou';
  if (talker === 'GQ') return 'QZSS';
  if (talker === 'GP') {
    // GPGSV に SBAS（PRN 33-64）が混在することがあるため範囲判定を残す
    if (prn >= 33 && prn <= 64) return 'SBAS';
    return 'GPS';
  }

  // GN またはタリア不明の場合は正規化済み PRN 範囲で判定。
  if (prn >= 401 && prn <= 463) return 'BeiDou'; // 正規化済み BeiDou
  if (prn >= 301 && prn <= 336) return 'Galileo'; // 正規化済み Galileo
  if (prn >= 193 && prn <= 202) return 'QZSS';   // Extended or normalized Strict
  if (prn >= 183 && prn <= 192) return 'QZSS';   // older Extended range
  if (prn >= 141 && prn <= 172) return 'BeiDou';  // GN文での旧来BeiDou範囲
  if (prn >= 65  && prn <= 92)  return 'GLONASS';
  if (prn >= 33  && prn <= 64)  return 'SBAS';
  if (prn >= 1   && prn <= 32)  return 'GPS';
  return 'GPS';
}

// QZSS の Strict PRN（1〜10）を Extended PRN（193〜202）に正規化する。
// Extended モード（PRN>=100）の場合はそのまま返す。
// これにより GPS PRN との衝突を防ぎ、Strict/Extended 両方で一意なキーが確保される。
function normalizeQzssPrn(prn) {
  return (prn >= 1 && prn < 100) ? prn + 192 : prn;
}

// Galileo の GAGSV 内 PRN（1〜36）を内部キー用に正規化する（301〜336）。
// これにより GPS PRN（1〜32）との衝突を防ぐ。
// すでに 300 以上（正規化済みまたは受信機が拡張形式）はそのまま返す。
function normalizeGalileoPrn(prn) {
  return (prn >= 1 && prn <= 36) ? prn + 300 : prn;
}

// BeiDou の GBGSV 内 PRN（1〜63）を内部キー用に正規化する（401〜463）。
// これにより GPS（1〜32）・Galileo正規化後（301〜336）・QZSS（183〜202）との衝突を防ぐ。
// すでに 400 以上はそのまま返す。
function normalizeBeidouPrn(prn) {
  return (prn >= 1 && prn <= 63) ? prn + 400 : prn;
}

const handlers = {
  GGA(p) {
    if (p.length < 10) return;
    gps.utc_time      = parseTime(p[1]);
    gps.latitude      = parseLatLon(p[2], p[3]);
    gps.lat_dir       = p[3] || 'N';
    gps.longitude     = parseLatLon(p[4], p[5]);
    gps.lon_dir       = p[5] || 'E';
    gps.fix_quality   = p[6] ? parseInt(p[6]) : 0;
    gps.num_sats_used = p[7] ? parseInt(p[7]) : 0;
    gps.hdop          = p[8] ? parseFloat(p[8]) : null;
    gps.altitude      = p[9] ? parseFloat(p[9]) : null;
    if (p[11]) gps.geoid_sep = parseFloat(p[11]);
    gps.last_update = Date.now();
  },
  RMC(p) {
    if (p.length < 10) return;
    gps.utc_time   = parseTime(p[1]);
    gps.rmc_status = p[2];
    gps.latitude   = parseLatLon(p[3], p[4]);
    gps.lat_dir    = p[4] || 'N';
    gps.longitude  = parseLatLon(p[5], p[6]);
    gps.lon_dir    = p[6] || 'E';
    if (p[7]) { gps.speed_knots = parseFloat(p[7]); gps.speed_kmh = gps.speed_knots * 1.852; }
    gps.course   = p[8] ? parseFloat(p[8]) : null;
    gps.utc_date = parseDate(p[9]);
    gps.last_update = Date.now();
  },
  VTG(p) {
    if (p.length < 8) return;
    if (p[1]) gps.course      = parseFloat(p[1]);
    if (p[5]) gps.speed_knots = parseFloat(p[5]);
    if (p[7]) gps.speed_kmh   = parseFloat(p[7]);
  },
  GSA(p) {
    if (p.length < 18) return;
    gps.fix_mode = p[2] ? parseInt(p[2]) : 1;
    // NMEA 4.1+ の末尾システムID (p[18]) を読む。
    // 5=QZSS の場合は Strict PRN（1-10）を Extended（193-202）へ正規化する。
    const sysId = p[18] ? parseInt(p[18]) : 0;
    const now = Date.now();
    for (let i = 3; i < 15 && i < p.length; i++) {
      if (p[i]) {
        let n = parseInt(p[i]);
        if (!isNaN(n)) {
          if (sysId === 5) n = normalizeQzssPrn(n);    // QZSS Strict→Extended
          if (sysId === 3) n = normalizeGalileoPrn(n); // Galileo PRN→301-336
          if (sysId === 4) n = normalizeBeidouPrn(n);  // BeiDou PRN→401-463
          if (gps.satellites[n]) {
            gps.satellites[n].usedAt   = now;
            gps.satellites[n].lastSeen = now;
          }
        }
      }
    }
    if (p[15]) gps.pdop = parseFloat(p[15]);
    if (p[16]) gps.hdop = parseFloat(p[16]);
    if (p[17]) gps.vdop = parseFloat(p[17]);
  },
  GSV(p, talker) {
    if (p.length < 4) return;
    const total = parseInt(p[1]);
    const num   = parseInt(p[2]);
    if (!gsv_buf[talker]) gsv_buf[talker] = {};
    let i = 4;
    while (i + 3 < p.length) {
      let prn = p[i] ? parseInt(p[i]) : null;
      if (prn !== null && !isNaN(prn)) {
        // QZSS Strict モード (PRN 1-10) → Extended (193-202) へ正規化
        if (talker === 'GQ') prn = normalizeQzssPrn(prn);
        // Galileo (PRN 1-36) → 内部キー (301-336) へ正規化（GPS PRN との衝突防止）
        if (talker === 'GA') prn = normalizeGalileoPrn(prn);
        // BeiDou (PRN 1-63) → 内部キー (401-463) へ正規化（GPS・Galileo との衝突防止）
        if (talker === 'GB' || talker === 'BD') prn = normalizeBeidouPrn(prn);
        const el  = p[i+1] ? parseFloat(p[i+1]) : 0;
        const az  = p[i+2] ? parseFloat(p[i+2]) : 0;
        const snr = p[i+3] ? parseFloat(p[i+3]) : null;
        gsv_buf[talker][prn] = { prn, elevation: el, azimuth: az, snr,
          system: systemFromTalker(talker, prn) };
      }
      i += 4;
    }
    if (num === total) {
      // Sequence complete: merge into satellites, preserving usedAt.
      // No deletion here — stale entries expire via lastSeen in cleanupSatellites().
      const now = Date.now();
      for (const [prn, sat] of Object.entries(gsv_buf[talker])) {
        const prev = gps.satellites[prn];
        gps.satellites[prn] = { ...sat, lastSeen: now, usedAt: prev ? prev.usedAt : null };
      }
      gsv_buf[talker] = {};
    }
  },

  // $PSTMCPU,<CPU_Usage>,-1,<CPU_Speed>*CS
  // Note: In this viewer parser, "PSTMCPU" becomes talker="PS", mtype="TMCPU".
  TMCPU(p) {
    if (p.length < 4) return;
    const usage = p[1] ? parseFloat(p[1]) : null;
    const speed = p[3] ? parseInt(p[3], 10) : null;
    gps.cpu_usage = Number.isFinite(usage) ? usage : null;
    gps.cpu_speed_mhz = Number.isFinite(speed) ? speed : null;
    gps.cpu_last_update = Date.now();
  },

  // $PSTMSBAS,<Status>,<SatTrk>,<SatID>,<Elev>,<Azim>,<Sig>*CS
  // Note: In this viewer parser, "PSTMSBAS" becomes talker="PS", mtype="TMSBAS".
  TMSBAS(p) {
    if (p.length < 7) return;
    const status = p[1] !== '' ? parseInt(p[1], 10) : null;
    const track  = p[2] !== '' ? parseInt(p[2], 10) : null;
    const satId  = p[3] !== '' ? parseInt(p[3], 10) : null;
    const elev   = p[4] !== '' ? parseFloat(p[4]) : null;
    const azim   = p[5] !== '' ? parseFloat(p[5]) : null;
    const sig    = p[6] !== '' ? parseFloat(p[6]) : null;

    gps.sbas_status = Number.isFinite(status) ? status : null;
    gps.sbas_track  = Number.isFinite(track)  ? track  : null;
    gps.sbas_sat_id = Number.isFinite(satId)  ? satId  : null;
    gps.sbas_elev   = Number.isFinite(elev)   ? elev   : null;
    gps.sbas_azim   = Number.isFinite(azim)   ? azim   : null;
    gps.sbas_sig    = Number.isFinite(sig)    ? sig    : null;
    gps.sbas_last_update = Date.now();

    // Also reflect into satellites/sky view (some receivers don't emit SBAS in GSV reliably).
    if (gps.sbas_sat_id !== null && gps.sbas_elev !== null && gps.sbas_azim !== null) {
      const prn = gps.sbas_sat_id;
      const now = gps.sbas_last_update;
      const prev = gps.satellites[prn];
      gps.satellites[prn] = {
        prn,
        elevation: gps.sbas_elev,
        azimuth: gps.sbas_azim,
        snr: gps.sbas_sig,
        system: 'SBAS',
        lastSeen: now,
        usedAt: (gps.sbas_track === 2) ? now : (prev ? prev.usedAt : null),
      };
    }
  },
};

function feedNMEA(raw) {
  const line = raw.trim();
  if (!line.startsWith('$')) return;
  if (!checksumOk(line)) return;

  gps.raw_log.push(line.slice(0, 120));
  if (gps.raw_log.length > 800) gps.raw_log.shift();
  rawVersion++;

  try {
    let body = line.slice(1);
    const star = body.lastIndexOf('*');
    if (star >= 0) body = body.slice(0, star);
    const parts  = body.split(',');
    const sid    = parts[0];
    if (sid.length < 5) return;
    const talker = sid.slice(0, 2);
    const mtype  = sid.slice(2);
    const h = handlers[mtype];
    if (h) h(parts, talker);
  } catch (_) {}
}

// ── Satellite Cleanup ─────────────────────────────────────────────────────────

// GSV は低レートで送られることがある（MAX-M10M 実測で約6秒間隔）ため
// 削除タイムアウトは余裕を持って長めにする。
// used フラグは GSA が毎秒来るので短くても問題ない。
const SAT_STALE_MS      = 15000;  // 衛星エントリを削除するまでの時間 (ms)
const SAT_USED_STALE_MS =  3000;  // used フラグを落とすまでの時間 (ms)

function cleanupSatellites() {
  const now = Date.now();
  for (const prn of Object.keys(gps.satellites)) {
    const sat = gps.satellites[prn];
    if (now - sat.lastSeen > SAT_STALE_MS) {
      delete gps.satellites[prn];
    } else {
      sat.used = sat.usedAt !== null && (now - sat.usedAt < SAT_USED_STALE_MS);
    }
  }
}

// ── Shared Serial Session (single read loop) ─────────────────────────────────

const session = new SerialSession();
session.onLine((line) => feedNMEA(line));

// ── Demo Simulator ────────────────────────────────────────────────────────────

const DEMO_SATS = [
  { prn:  1, el: 52, az: 170, snrBase: 42, system: 'GPS'     },
  { prn:  3, el: 23, az:  90, snrBase: 35, system: 'GPS'     },
  { prn:  7, el: 67, az: 255, snrBase: 40, system: 'GPS'     },
  { prn:  9, el: 14, az: 330, snrBase: 22, system: 'GPS'     },
  { prn: 14, el: 55, az: 195, snrBase: 38, system: 'GPS'     },
  { prn: 17, el: 34, az:  65, snrBase: 33, system: 'GPS'     },
  { prn: 19, el: 78, az:  22, snrBase: 44, system: 'GPS'     },
  { prn: 22, el: 44, az: 200, snrBase: 31, system: 'GPS'     },
  { prn: 28, el:  8, az: 160, snrBase: 15, system: 'GPS'     },
  { prn: 30, el: 30, az: 300, snrBase: 36, system: 'GPS'     },
  { prn: 65, el: 50, az: 105, snrBase: 37, system: 'GLONASS' },
  { prn: 70, el: 28, az: 245, snrBase: 29, system: 'GLONASS' },
];
const DEMO_USED = [1, 3, 7, 14, 17, 19, 22, 30, 65, 70];

let demoTick   = 0;
let demoTimer  = null;
let demoActive = false;

function demoCS(s) {
  let v = 0;
  for (const c of s) v ^= c.charCodeAt(0);
  return `$${s}*${v.toString(16).toUpperCase().padStart(2,'0')}\r\n`;
}

function demoStep() {
  const t = demoTick++;
  const h  = Math.floor((12 + t / 3600)) % 24;
  const m  = Math.floor(t / 60) % 60;
  const s  = t % 60;
  const ts = `${h.toString().padStart(2,'0')}${m.toString().padStart(2,'0')}${s.toString().padStart(2,'0')}.00`;
  const ds = '070326';

  const lat = 35.6895 + Math.sin(t * 0.013) * 0.0008;
  const lon = 139.6917 + Math.cos(t * 0.013) * 0.0008;
  const alt = 42.3 + Math.sin(t * 0.07) * 1.2;
  const spd = Math.max(0.0, 0.3 + Math.sin(t * 0.05) * 0.2);
  const crs = ((124.0 + Math.sin(t * 0.02) * 8) + 360) % 360;

  const latDeg = Math.floor(lat);
  const latMin = ((lat - latDeg) * 60).toFixed(5).padStart(8, '0');
  const latDm  = `${latDeg.toString().padStart(2,'0')}${latMin}`;
  const lonDeg = Math.floor(lon);
  const lonMin = ((lon - lonDeg) * 60).toFixed(5).padStart(8, '0');
  const lonDm  = `${lonDeg.toString().padStart(3,'0')}${lonMin}`;

  const usedStr = DEMO_USED.map(String).join(',') + ',,'.repeat(12 - DEMO_USED.length);

  const lines = [
    demoCS(`GPGGA,${ts},${latDm},N,${lonDm},E,1,${DEMO_USED.length.toString().padStart(2,'0')},0.9,${alt.toFixed(1)},M,38.2,M,,`),
    demoCS(`GPRMC,${ts},A,${latDm},N,${lonDm},E,${spd.toFixed(2)},${crs.toFixed(1)},${ds},,,A`),
    demoCS(`GPGSA,A,3,${usedStr},1.4,0.9,1.1`),
  ];

  // GPS GSV
  const gpsSats = DEMO_SATS.filter(s => s.system === 'GPS')
    .map(s => ({ ...s, snr: Math.max(0, Math.round(s.snrBase + (Math.random() * 6 - 3))) }));
  const gpsPages = Math.ceil(gpsSats.length / 4);
  for (let pg = 0; pg < gpsPages; pg++) {
    const grp = gpsSats.slice(pg * 4, (pg + 1) * 4);
    const ss  = grp.map(x => `,${x.prn.toString().padStart(2,'0')},${x.el.toString().padStart(2,'0')},${x.az.toString().padStart(3,'0')},${x.snr.toString().padStart(2,'0')}`).join('');
    lines.push(demoCS(`GPGSV,${gpsPages},${pg+1},${gpsSats.length.toString().padStart(2,'0')}${ss}`));
  }

  // GLONASS GSV
  const glSats = DEMO_SATS.filter(s => s.system === 'GLONASS')
    .map(s => ({ ...s, snr: Math.max(0, Math.round(s.snrBase + (Math.random() * 6 - 3))) }));
  const glSS = glSats.map(x => `,${x.prn.toString().padStart(2,'0')},${x.el.toString().padStart(2,'0')},${x.az.toString().padStart(3,'0')},${x.snr.toString().padStart(2,'0')}`).join('');
  lines.push(demoCS(`GLGSV,1,1,${glSats.length.toString().padStart(2,'0')}${glSS}`));

  for (const l of lines) session.ingestText(l);
}

function startDemo() {
  if (demoActive) return;
  demoActive = true;
  demoTick   = 0;
  document.getElementById('btn-demo').classList.add('active');
  document.getElementById('btn-demo').textContent = 'Stop Demo';
  setConnState('demo', 'Demo');
  const tick = () => { if (!demoActive) return; demoStep(); demoTimer = setTimeout(tick, 1000); };
  tick();
}

function stopDemo() {
  if (!demoActive) return;
  demoActive = false;
  if (demoTimer) clearTimeout(demoTimer);
  document.getElementById('btn-demo').classList.remove('active');
  document.getElementById('btn-demo').textContent = 'Demo';
  if (!session.connected) setConnState('off', 'Offline');
}

// ── Web Serial API (Shared Session) ─────────────────────────────────────────

function setConnState(state, label) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  dot.className = 'conn-dot' + (state !== 'off' ? ' ' + state : '');
  lbl.textContent = label;
}

async function connectSerial() {
  const baud = parseInt(document.getElementById('baud-sel').value);
  try {
    await session.connect(baud);
    localStorage.setItem('gnss_baud', baud);
    document.getElementById('btn-connect').textContent = 'Disconnect';
    document.getElementById('btn-connect').classList.add('active');
    document.getElementById('baud-sel').disabled = true;
    setConnState('connected', `${baud} bps`);
  } catch (e) {
    console.warn('Serial error:', e);
  }
}

async function disconnectSerial() {
  await session.disconnect();
  document.getElementById('btn-connect').textContent = 'Connect';
  document.getElementById('btn-connect').classList.remove('active');
  document.getElementById('baud-sel').disabled = false;
  if (!demoActive) setConnState('off', 'Offline');
}

session.onState(({ connected }) => {
  if (!connected) {
    document.getElementById('btn-connect').textContent = 'Connect';
    document.getElementById('btn-connect').classList.remove('active');
    document.getElementById('baud-sel').disabled = false;
    if (!demoActive) setConnState('off', 'Offline');
  }
});

// ── Teseo Tool (extracted) ───────────────────────────────────────────────────

initTeseoTool({ session });

// ── u-blox M10 Tool ──────────────────────────────────────────────────────────

initUbloxM10Tool({ session });

// ── Sky View Canvas ───────────────────────────────────────────────────────────

const canvas = document.getElementById('sky-canvas');
const ctx    = canvas.getContext('2d');
let dpr = 1;

function resizeSky() {
  const wrap = document.getElementById('sky-canvas-wrap');
  const legH = document.getElementById('sky-legend').offsetHeight;
  const avail = Math.min(wrap.clientWidth, wrap.clientHeight) - 16;
  const dim = Math.max(120, avail);
  dpr = window.devicePixelRatio || 1;
  canvas.width  = dim * dpr;
  canvas.height = dim * dpr;
  canvas.style.width  = dim + 'px';
  canvas.style.height = dim + 'px';
  ctx.scale(dpr, dpr);
}

// ── Satellite Trails ─────────────────────────────────────────────────────────
const SAT_TRAIL_MAX = 120; // 120 × 500ms = 60 seconds
const satTrails = {};
let satTrailsVisible = false;

function updateSatTrails() {
  const active = new Set();
  for (const sat of Object.values(gps.satellites)) {
    if (sat.elevation == null || sat.azimuth == null) continue;
    const key = sat.prn;
    active.add(key);
    if (!satTrails[key]) satTrails[key] = [];
    const trail = satTrails[key];
    const last = trail[trail.length - 1];
    if (!last || Math.abs(last.az - sat.azimuth) > 0.05 || Math.abs(last.el - sat.elevation) > 0.05) {
      trail.push({ az: sat.azimuth, el: sat.elevation, system: sat.system });
      if (trail.length > SAT_TRAIL_MAX) trail.shift();
    }
  }
  for (const key of Object.keys(satTrails)) {
    if (!active.has(Number(key))) delete satTrails[key];
  }
}

function drawSky() {
  const W = canvas.width  / dpr;
  const H = canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2;
  const R  = Math.min(cx, cy) - 20;

  // Background gradient
  const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R + 12);
  bgGrad.addColorStop(0,   '#061428');
  bgGrad.addColorStop(0.6, '#04080e');
  bgGrad.addColorStop(1,   '#020406');
  ctx.fillStyle = bgGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, R + 12, 0, Math.PI * 2);
  ctx.fill();

  // Outer glow ring
  ctx.beginPath();
  ctx.arc(cx, cy, R + 1, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(45,212,232,0.25)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Azimuth spokes (every 45°)
  for (let a = 0; a < 360; a += 45) {
    const rad = (a - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(rad), cy + R * Math.sin(rad));
    ctx.strokeStyle = 'rgba(33,48,61,0.6)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // Elevation rings: 0° (horizon), 30°, 60°
  const rings = [
    { el: 0,  color: 'rgba(45,212,232,0.25)', dash: [],     lw: 1.2 },
    { el: 30, color: 'rgba(33,48,61,0.9)',    dash: [4, 4], lw: 0.8 },
    { el: 60, color: 'rgba(33,48,61,0.9)',    dash: [4, 4], lw: 0.8 },
  ];
  for (const { el, color, dash, lw } of rings) {
    const rr = R * (90 - el) / 90;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = lw;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
    if (el > 0) {
      ctx.fillStyle = 'rgba(90,112,128,0.7)';
      ctx.font = `${Math.max(8, R * 0.08)}px monospace`;
      ctx.textAlign = 'left';
      ctx.fillText(`${el}°`, cx + 2, cy - rr + 10);
    }
  }

  // Cardinal labels
  const labelR = R + 10;
  const fs = Math.max(9, R * 0.09);
  ctx.fillStyle = '#64748b';
  ctx.font = `bold ${fs}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', cx,          cy - labelR);
  ctx.fillText('S', cx,          cy + labelR);
  ctx.fillText('E', cx + labelR, cy);
  ctx.fillText('W', cx - labelR, cy);
  ctx.textBaseline = 'alphabetic';

  // Satellite trails
  if (satTrailsVisible) {
    for (const [prn, trail] of Object.entries(satTrails)) {
      if (trail.length < 2) continue;
      const color = SYS_COLOR[trail[trail.length - 1].system] || '#c8d6e0';
      ctx.save();
      ctx.strokeStyle = color + '55';
      ctx.lineWidth = 1;
      ctx.beginPath();
      trail.forEach((pt, i) => {
        const azRad = (pt.az - 90) * Math.PI / 180;
        const dist  = (90 - pt.el) / 90;
        const x = cx + dist * R * Math.cos(azRad);
        const y = cy + dist * R * Math.sin(azRad);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.restore();
    }
  }

  // Satellites
  const sats = Object.values(gps.satellites)
    .sort((a, b) => (a.snr || 0) - (b.snr || 0)); // draw weakest first

  for (const sat of sats) {
    const azRad = (sat.azimuth - 90) * Math.PI / 180;
    const dist  = (90 - sat.elevation) / 90;
    const sx = cx + dist * R * Math.cos(azRad);
    const sy = cy + dist * R * Math.sin(azRad);

    const color = SYS_COLOR[sat.system] || '#c8d6e0';
    const snr   = sat.snr || 0;

    ctx.save();

    if (sat.used) {
      // Glow aura
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, snr >= 35 ? 14 : 10);
      glow.addColorStop(0, color + '80');
      glow.addColorStop(1, color + '00');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, snr >= 35 ? 14 : 10, 0, Math.PI * 2);
      ctx.fill();

      // Marker
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur  = snr >= 35 ? 10 : 6;
      if (snr >= 35) {
        // Star
        ctx.beginPath();
        starPath(ctx, sx, sy, 5, 5.5, 2.5);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Hollow circle
      ctx.strokeStyle = sat.snr !== null ? color : '#21303d';
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = sat.snr !== null ? 0.6 : 0.25;
      ctx.beginPath();
      ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // PRN label
    if (sat.snr !== null) {
      const abbr  = SYS_ABBREV[sat.system] || '?';
      const label = `${abbr}${sat.prn % 100}`;
      ctx.save();
      ctx.font      = `${Math.max(8, R * 0.08)}px monospace`;
      ctx.fillStyle = color;
      ctx.globalAlpha  = 0.75;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, sx, sy - 7);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
    }
  }
}

function starPath(ctx, cx, cy, spikes, outerR, innerR) {
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.beginPath();
  ctx.moveTo(cx + outerR * Math.cos(rot), cy + outerR * Math.sin(rot));
  for (let i = 0; i < spikes; i++) {
    rot += step;
    ctx.lineTo(cx + innerR * Math.cos(rot), cy + innerR * Math.sin(rot));
    rot += step;
    ctx.lineTo(cx + outerR * Math.cos(rot), cy + outerR * Math.sin(rot));
  }
  ctx.closePath();
}

// ── Legend ────────────────────────────────────────────────────────────────────

function updateLegend() {
  const sats    = Object.values(gps.satellites);
  const present = [...new Set(sats.map(s => s.system))]
    .sort((a, b) => SYS_ORDER.indexOf(a) - SYS_ORDER.indexOf(b));
  const leg = document.getElementById('sky-legend');
  leg.innerHTML = present.map(sys => {
    const total = sats.filter(s => s.system === sys).length;
    const used  = sats.filter(s => s.system === sys && s.used).length;
    const c = SYS_COLOR[sys] || '#c8d6e0';
    return `<div class="leg-item">
      <div class="leg-dot" style="background:${c};box-shadow:0 0 4px ${c}80"></div>
      <span style="color:${c}">${SYS_NAME[sys]} <span style="color:#5a7080">${used}/${total}</span></span>
    </div>`;
  }).join('');

  // Symbol hint
  const hint = document.createElement('div');
  hint.style.cssText = 'margin-left:auto;font-size:10px;color:#3d5060;white-space:nowrap;';
  hint.textContent = '\u2605=used  \u25CF=tracked';
  leg.appendChild(hint);
}

// ── Satellite Table ───────────────────────────────────────────────────────────

function updateSatTable() {
  const tbody = document.getElementById('sat-tbody');
  const sats = Object.values(gps.satellites)
    .sort((a, b) => { if (a.used !== b.used) return b.used ? 1 : -1; return (b.snr || 0) - (a.snr || 0); });

  tbody.innerHTML = sats.map(sat => {
    const color    = SYS_COLOR[sat.system] || '#c8d6e0';
    const snrTxt   = sat.snr !== null ? sat.snr.toFixed(0) : '--';
    const snrPct   = sat.snr !== null ? Math.min(100, sat.snr / 50 * 100).toFixed(1) : '0';
    const barClass = sat.snr >= 35 ? 'sig-hi' : sat.snr >= 20 ? 'sig-md' : 'sig-lo';
    const snrColor = sat.snr >= 35 ? '#3de87a' : sat.snr >= 20 ? '#f0c040' : '#f04840';
    const opacity  = sat.used ? '1' : '0.45';
    const usedMark = sat.used
      ? (sat.snr >= 35
          ? `<span style="color:#f0c040;font-size:12px">\u2605</span>`
          : `<span style="color:#f0c040;font-size:12px">\u25cf</span>`)
      : '';

    return `<tr style="opacity:${opacity}">
      <td class="td-used">${usedMark}</td>
      <td class="td-sys" style="color:${color}">${SYS_NAME[sat.system] || sat.system}</td>
      <td class="td-num">${sat.prn}</td>
      <td class="td-num">${sat.elevation.toFixed(0)}&deg;</td>
      <td class="td-num">${sat.azimuth.toFixed(0)}&deg;</td>
      <td class="td-snr" style="color:${snrColor}">${snrTxt}</td>
      <td class="sig-wrap">
        <div class="sig-bg">
          <div class="sig-fill ${barClass}" style="width:${snrPct}%"></div>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Status / Data Bars ────────────────────────────────────────────────────────

function fmtCoord(val, posD, negD, w) {
  if (val === null || val === undefined) return '---';
  const dir = val >= 0 ? posD : negD;
  const abs = Math.abs(val);
  const deg = Math.floor(abs);
  const min = ((abs - deg) * 60).toFixed(4);
  return `${deg.toString().padStart(w,'0')}\u00b0${min.toString().padStart(7,'0')}'${dir}`;
}

function updateStatus() {
  // Time
  const timeEl = document.getElementById('st-time');
  const dateEl = document.getElementById('st-date');
  timeEl.textContent = gps.utc_time ? `${gps.utc_time} UTC` : '--:--:-- UTC';
  dateEl.textContent = gps.utc_date ? gps.utc_date : '';

  // Fix
  const fixEl  = document.getElementById('st-fix');
  const key    = `${gps.fix_quality},${gps.fix_mode}`;
  let fi = FIX_INFO[key] || { label: 'Unknown', cls: 'warn' };
  if (gps.rmc_status === 'V' && gps.fix_quality === 0) fi = { label: 'No Fix', cls: 'bad' };
  fixEl.textContent = fi.label;
  fixEl.className   = `stat-val ${fi.cls}`;

  // Sats
  const total = Object.keys(gps.satellites).length;
  document.getElementById('st-sats').textContent = `${gps.num_sats_used} / ${total}`;

  // RMC status
  const rmcEl = document.getElementById('st-rmc');
  rmcEl.textContent = gps.rmc_status === 'A' ? 'Active' : 'Void';
  rmcEl.style.color = gps.rmc_status === 'A' ? 'var(--green)' : 'var(--dim)';

  // Stale
  const stale = (Date.now() - gps.last_update) > 5000;
  document.getElementById('stale-badge').style.display = stale ? 'inline' : 'none';
}

function updateData() {
  const posClass = gps.fix_mode >= 2 ? 'data-val pos' : 'data-val';
  const latEl = document.getElementById('d-lat');
  const lonEl = document.getElementById('d-lon');
  const altEl = document.getElementById('d-alt');
  latEl.textContent = fmtCoord(gps.latitude,  'N', 'S', 2);
  lonEl.textContent = fmtCoord(gps.longitude, 'E', 'W', 3);
  altEl.textContent = gps.altitude !== null ? `${gps.altitude.toFixed(1)} m` : '---';
  latEl.className = lonEl.className = altEl.className = posClass;

  document.getElementById('d-hdop').textContent  = gps.hdop  !== null ? gps.hdop.toFixed(1)  : '--';
  document.getElementById('d-speed').textContent = gps.speed_kmh !== null ? `${gps.speed_kmh.toFixed(1)} km/h` : '--.- km/h';
  document.getElementById('d-course').textContent = gps.course !== null ? `${gps.course.toFixed(1)}\u00b0` : '--.-\u00b0';
  document.getElementById('d-pdop').textContent  = gps.pdop  !== null ? gps.pdop.toFixed(1)  : '--';
  document.getElementById('d-vdop').textContent  = gps.vdop  !== null ? gps.vdop.toFixed(1)  : '--';

  const cpuFresh = gps.cpu_last_update && (Date.now() - gps.cpu_last_update) < 5000;
  document.getElementById('d-cpu').textContent = (cpuFresh && gps.cpu_usage !== null)
    ? `${gps.cpu_usage.toFixed(2)}%`
    : '--.--%';
  document.getElementById('d-cpuclk').textContent = (cpuFresh && gps.cpu_speed_mhz !== null)
    ? `${gps.cpu_speed_mhz} MHz`
    : '--- MHz';

  const sbasFresh = gps.sbas_last_update && (Date.now() - gps.sbas_last_update) < 5000;
  const sbasEl = document.getElementById('d-sbas');
  if (!sbasEl) return;
  if (!sbasFresh || gps.sbas_status === null) {
    sbasEl.textContent = '--';
  } else {
    const statusTxt = gps.sbas_status === 1 ? 'Used' : 'Not used';
    const trackTxt = (gps.sbas_track === 2) ? 'Decoded (Diff ON)'
      : (gps.sbas_track === 1) ? 'Decoding'
        : (gps.sbas_track === 0) ? 'Not tracked'
          : '--';
    const idTxt = (gps.sbas_sat_id !== null) ? `Sat ${gps.sbas_sat_id}` : 'Sat --';
    const sigTxt = (gps.sbas_sig !== null) ? `CN0 ${gps.sbas_sig.toFixed(0)} dB` : 'CN0 -- dB';
    sbasEl.textContent = `${statusTxt} | ${trackTxt} | ${idTxt} | ${sigTxt}`;
  }
}

// ── Raw NMEA Log ──────────────────────────────────────────────────────────────

let rawVersion = 0;
let lastRawVersion = -1;
let lastRawHeight = -1;

function updateRaw() {
  const scr = document.getElementById('raw-scroll');
  const curH = scr ? scr.clientHeight : -1;
  if (rawVersion === lastRawVersion && curH === lastRawHeight) return;
  lastRawVersion = rawVersion;
  lastRawHeight = curH;

  const el = document.getElementById('raw-log');
  if (!el) return;

  // Render enough lines to fill the available height.
  // (Also keeps a minimum so small panels still show some context.)
  let want = 40;
  if (scr) {
    const lhStr = getComputedStyle(scr).lineHeight;
    const lh = Number.parseFloat(lhStr);
    const lineH = Number.isFinite(lh) && lh > 0 ? lh : 18;
    want = Math.max(40, Math.ceil((scr.clientHeight || 0) / lineH) + 6);
  }

  const lines = gps.raw_log.slice(-want);
  el.innerHTML = lines.map(line => {
    // Proprietary: $P<MANUF(3)><TYPE>,...
    const p = line.match(/^\$P([A-Z]{3})([A-Z0-9]+)(,.*?)(\*[0-9A-Fa-f]{2})?$/);
    if (p) {
      const manuf = p[1];
      const ptype = p[2];
      const body = esc(p[3]);
      const cs   = p[4] ? `<span class="n-star">*</span><span class="n-cs">${esc(p[4].slice(1))}</span>` : '';

      // ST: $PSTM... should be shown in blue, and PSTMCPU highlights "CPU".
      const isSt = manuf === 'STM';
      const headCls = isSt ? 'n-st' : 'n-talker';
      const typeCls = isSt ? 'n-st-type' : 'n-type';
      const typeHtml = (isSt && ptype === 'CPU')
        ? `<span class="${typeCls}"><span class="n-cpu">CPU</span></span>`
        : `<span class="${typeCls}">${esc(ptype)}</span>`;

      return `<div class="nmea-line"><span class="n-dollar">$</span><span class="${headCls}">P${esc(manuf)}</span>${typeHtml}<span class="n-body">${body}</span>${cs}</div>`;
    }

    // Standard sentences: $TTXXX,... (XXX can be longer for proprietary-ish extensions)
    const m = line.match(/^\$([A-Z]{2})([A-Z0-9]{2,6})(,.*?)(\*[0-9A-Fa-f]{2})?$/);
    if (m) {
      const body = esc(m[3]);
      const cs   = m[4] ? `<span class="n-star">*</span><span class="n-cs">${esc(m[4].slice(1))}</span>` : '';

      const talker = m[1];
      const isQzss = talker.startsWith('Q');
      const talkerCls = isQzss ? 'n-qz' : 'n-talker';
      const typeCls = isQzss ? 'n-qz-type' : 'n-type';

      return `<div class="nmea-line"><span class="n-dollar">$</span><span class="${talkerCls}">${esc(talker)}</span><span class="${typeCls}">${esc(m[2])}</span><span class="n-body">${body}</span>${cs}</div>`;
    }

    return `<div class="nmea-line n-info">${esc(line)}</div>`;
  }).join('');

  if (scr) scr.scrollTop = scr.scrollHeight;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('Clipboard copy failed');
}

// ── Render Loop ───────────────────────────────────────────────────────────────

// ── DOP Graph ────────────────────────────────────────────────────────────────

const DOP_MAX_SAMPLES = 180;  // 180 × 500ms = 90 seconds
const dopHistory = { hdop: [], pdop: [], vdop: [] };
let dopPanelVisible = false;

function pushDopHistory() {
  dopHistory.hdop.push(gps.hdop);
  dopHistory.pdop.push(gps.pdop);
  dopHistory.vdop.push(gps.vdop);
  if (dopHistory.hdop.length > DOP_MAX_SAMPLES) {
    dopHistory.hdop.shift();
    dopHistory.pdop.shift();
    dopHistory.vdop.shift();
  }
}

function drawDopGraph() {
  if (!dopPanelVisible) return;
  const canvas = document.getElementById('dop-canvas');
  if (!canvas) return;
  const wrap = document.getElementById('dop-canvas-wrap');
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (w === 0 || h === 0) return;
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  const n = dopHistory.hdop.length;
  if (n < 2) return;

  // Determine Y scale
  const allVals = [...dopHistory.hdop, ...dopHistory.pdop, ...dopHistory.vdop]
    .filter(v => v !== null);
  const maxVal = Math.max(5, ...allVals) * 1.1;

  // Draw grid lines at 1, 2, 3, 5
  [1, 2, 3, 5].forEach(v => {
    if (v > maxVal) return;
    const y = h - (v / maxVal) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '9px monospace';
    ctx.fillText(v, 2, y - 2);
  });

  // Draw a series
  function drawSeries(data, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    data.forEach((v, i) => {
      if (v === null) { started = false; return; }
      const x = w - (n - 1 - i) * (w / (DOP_MAX_SAMPLES - 1));
      const y = h - (v / maxVal) * h;
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  drawSeries(dopHistory.pdop, '#c060f0');
  drawSeries(dopHistory.vdop, '#f09040');
  drawSeries(dopHistory.hdop, '#2dd4e8');
}

function toggleDopPanel() {
  dopPanelVisible = !dopPanelVisible;
  document.getElementById('dop-panel').classList.toggle('visible', dopPanelVisible);
  document.getElementById('btn-dop').classList.toggle('active', dopPanelVisible);
  localStorage.setItem('gnss_dop_visible', dopPanelVisible ? '1' : '0');
}

function render() {
  cleanupSatellites();
  updateStatus();
  updateData();
  resizeSky();
  drawSky();
  updateLegend();
  updateSatTable();
  updateRaw();
  updateSatTrails();
  pushDopHistory();
  drawDopGraph();
}

// ── Buttons ───────────────────────────────────────────────────────────────────

document.getElementById('btn-connect').addEventListener('click', async () => {
  if (session.connected) {
    await disconnectSerial();
  } else {
    stopDemo();
    connectSerial();
  }
});

document.getElementById('btn-demo').addEventListener('click', () => {
  if (demoActive) stopDemo(); else startDemo();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  Object.assign(gps, {
    utc_time: null, utc_date: null,
    latitude: null, longitude: null, altitude: null, geoid_sep: null,
    fix_quality: 0, fix_mode: 1, rmc_status: 'V',
    speed_kmh: null, speed_knots: null, course: null,
    pdop: null, hdop: null, vdop: null,
    num_sats_used: 0,
    satellites: {}, raw_log: [],
    last_update: Date.now(),
  });
  for (const k of Object.keys(gsv_buf)) delete gsv_buf[k];
  rawVersion++;
});

document.getElementById('btn-raw-copy').addEventListener('click', async () => {
  const btn = document.getElementById('btn-raw-copy');
  const lines = Array.isArray(gps.raw_log) ? gps.raw_log : [];
  const text = lines.join('\n');
  if (!text) return;

  const prev = btn.textContent;
  btn.textContent = 'Copying...';
  try {
    await copyTextToClipboard(text + '\n');
    btn.textContent = 'Copied';
  } catch (_) {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = prev; }, 1200);
});

// ── Map Panel Width Resizer ──────────────────────────────────────────────────

(function initMapResizer() {
  const mapPanel = document.getElementById('map-panel');
  const handle   = document.getElementById('map-resizer');
  if (!mapPanel || !handle) return;

  const MIN_W = 200;

  let startX = 0;
  let startW = 0;
  let active = false;

  function clampWidth(w) {
    const maxW = Math.max(MIN_W, Math.floor(window.innerWidth * 0.75));
    return Math.min(maxW, Math.max(MIN_W, Math.floor(w)));
  }

  function onMove(e) {
    if (!active) return;
    // Handle is on the left edge; dragging left widens the panel.
    const dx = e.clientX - startX;
    const nextW = clampWidth(startW - dx);
    mapPanel.style.width = `${nextW}px`;
    if (typeof leafletMap !== 'undefined' && leafletMap) leafletMap.invalidateSize();
  }

  function stop(e) {
    if (!active) return;
    active = false;
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup',   stop);
    window.removeEventListener('pointercancel', stop);
    document.body.classList.remove('map-resizing');
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    active  = true;
    startX  = e.clientX;
    startW  = mapPanel.getBoundingClientRect().width;
    document.body.classList.add('map-resizing');
    handle.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove',   onMove);
    window.addEventListener('pointerup',     stop);
    window.addEventListener('pointercancel', stop);
    e.preventDefault();
  });
})();

// ── Raw NMEA Panel Resizer ───────────────────────────────────────────────────

(function initRawResizer() {
  const rawPanel = document.getElementById('raw-panel');
  const handle = document.getElementById('raw-resizer');
  if (!rawPanel || !handle) return;

  const MIN_H = 80;

  let startY = 0;
  let startH = 0;
  let active = false;

  function clampHeight(h) {
    const maxH = Math.max(MIN_H, Math.floor(window.innerHeight * 0.65));
    return Math.min(maxH, Math.max(MIN_H, Math.floor(h)));
  }

  function onMove(e) {
    if (!active) return;
    const dy = e.clientY - startY;
    // Dragging up increases the panel height.
    const nextH = clampHeight(startH - dy);
    rawPanel.style.height = `${nextH}px`;
  }

  function stop(e) {
    if (!active) return;
    active = false;
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    document.body.classList.remove('raw-resizing');
  }

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    active = true;
    startY = e.clientY;
    startH = rawPanel.getBoundingClientRect().height;
    document.body.classList.add('raw-resizing');
    handle.setPointerCapture(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    e.preventDefault();
  });
})();

// ── Init ──────────────────────────────────────────────────────────────────────

if (!('serial' in navigator)) {
  document.getElementById('no-serial-warn').style.display = 'block';
  document.getElementById('btn-connect').disabled = true;
}

window.addEventListener('resize', resizeSky);
setTimeout(resizeSky, 100);

// (Teseo implementation moved to teseo-tool.js)

'use strict';
// ── Map ───────────────────────────────────────────────────────────────────────

let leafletMap    = null;
let gpsMarker     = null;
let trackPolyline = null;
let trackPoints   = [];
let mapFollow     = true;
let mapVisible    = false;
let mapInitialized = false;
let currentTileLayer = null;
let currentLayerKey  = 'dark';
let sbasLayerGroup  = null;
let sbasVisible     = false;
let accuracyCircle  = null;

const TRACK_MAX = 2000;

// SBAS service area approximate coverage polygons [lat, lng]
const SBAS_AREAS = [
  {
    name: 'WAAS',
    desc: 'North America (PRN 131/133/135/138)',
    color: '#4090ff',
    coords: [[72,-170],[72,-52],[12,-52],[12,-170]],
  },
  {
    name: 'EGNOS',
    desc: 'Europe / North Africa (PRN 120/123/126/136)',
    color: '#40e080',
    coords: [[76,-32],[76,46],[8,46],[8,-32]],
  },
  {
    name: 'MSAS',
    desc: 'Japan / West Pacific (PRN 129/137)',
    color: '#f09040',
    coords: [[60,100],[60,175],[10,175],[10,100]],
  },
  {
    name: 'GAGAN',
    desc: 'India (PRN 127/128)',
    color: '#e040e0',
    coords: [[40,55],[40,100],[0,100],[0,55]],
  },
  {
    name: 'SDCM',
    desc: 'Russia (PRN 125/140/141)',
    color: '#e0e040',
    coords: [[76,18],[76,180],[44,180],[44,18]],
  },
];

const TILE_LAYERS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    },
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    options: {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    },
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: {
      attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
      maxZoom: 19,
    },
  },
};

function switchTileLayer(key) {
  if (!leafletMap || !TILE_LAYERS[key]) return;
  if (currentTileLayer) leafletMap.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(TILE_LAYERS[key].url, TILE_LAYERS[key].options).addTo(leafletMap);
  if (trackPolyline) trackPolyline.bringToFront();
  currentLayerKey = key;
  localStorage.setItem('gnss_map_layer', key);
  document.querySelectorAll('.map-layer-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layer === key);
  });
}

function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  leafletMap = L.map('map-container', { zoomControl: true, attributionControl: true })
    .setView([35.6895, 139.6917], 15);

  // Default tile layer (restore saved preference)
  const savedLayer = localStorage.getItem('gnss_map_layer');
  const initialLayer = (savedLayer && TILE_LAYERS[savedLayer]) ? savedLayer : 'dark';
  currentTileLayer = L.tileLayer(TILE_LAYERS[initialLayer].url, TILE_LAYERS[initialLayer].options).addTo(leafletMap);
  currentLayerKey = initialLayer;
  document.querySelectorAll('.map-layer-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layer === initialLayer);
  });

  // Custom pulsing marker
  const markerIcon = L.divIcon({
    className: '',
    html: '<div class="gps-marker-outer"><div class="gps-marker-inner"></div></div>',
    iconSize:   [18, 18],
    iconAnchor: [9, 9],
  });
  gpsMarker = L.marker([35.6895, 139.6917], { icon: markerIcon, zIndexOffset: 1000 });

  // Track polyline
  trackPolyline = L.polyline([], {
    color: '#2dd4e8',
    weight: 2,
    opacity: 0.7,
    smoothFactor: 1,
  }).addTo(leafletMap);

  // Accuracy circle (HDOP-based estimated horizontal error)
  accuracyCircle = L.circle([35.6895, 139.6917], {
    radius:      0,
    color:       '#2dd4e8',
    fillColor:   '#2dd4e8',
    fillOpacity: 0.08,
    weight:      1,
    opacity:     0.5,
  });

  // Disable follow when user drags the map
  leafletMap.on('dragstart', () => {
    mapFollow = false;
    document.getElementById('btn-follow').classList.remove('active');
  });

  // SBAS service area layer group (hidden by default)
  sbasLayerGroup = L.layerGroup();
  SBAS_AREAS.forEach(area => {
    const poly = L.polygon(area.coords, {
      color:       area.color,
      fillColor:   area.color,
      fillOpacity: 0.08,
      weight:      1.5,
      opacity:     0.6,
      dashArray:   '4 4',
    });
    poly.bindTooltip(`<b>${area.name}</b><br><span style="font-size:11px">${area.desc}</span>`, {
      sticky: true,
    });
    sbasLayerGroup.addLayer(poly);
  });

  // マップコンテナのサイズ変化（rawパネルリサイズ・ウィンドウリサイズなど）を
  // 検知して Leaflet に通知する。これがないと地図が正しく再描画されない。
  new ResizeObserver(() => leafletMap.invalidateSize()).observe(
    document.getElementById('map-container')
  );
}

function updateMap() {
  if (!mapVisible || !mapInitialized) return;
  if (gps.latitude === null || gps.longitude === null) return;

  const latlng = [gps.latitude, gps.longitude];

  // Move marker
  if (!leafletMap.hasLayer(gpsMarker)) gpsMarker.addTo(leafletMap);
  gpsMarker.setLatLng(latlng);

  // Accuracy circle: radius = HDOP × 5 m (L1 single-frequency estimate)
  if (accuracyCircle && gps.hdop !== null && gps.hdop > 0) {
    const radius = gps.hdop * 5;
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(radius);
    accuracyCircle.setTooltipContent(`HDOP ${gps.hdop.toFixed(1)} — 推定誤差 ±${radius.toFixed(0)} m`);
    if (!leafletMap.hasLayer(accuracyCircle)) {
      accuracyCircle.addTo(leafletMap).bindTooltip('', { permanent: false, sticky: true });
    }
  } else if (accuracyCircle && leafletMap.hasLayer(accuracyCircle)) {
    accuracyCircle.remove();
  }

  // Append to track
  trackPoints.push(latlng);
  if (trackPoints.length > TRACK_MAX) trackPoints.shift();
  trackPolyline.setLatLngs(trackPoints);

  // Auto-follow
  if (mapFollow) leafletMap.panTo(latlng, { animate: true, duration: 0.4 });
}

function toggleMap() {
  mapVisible = !mapVisible;
  const panel = document.getElementById('map-panel');
  const btn   = document.getElementById('btn-map');
  if (mapVisible) {
    panel.classList.add('visible');
    btn.classList.add('active');
    // Initialize lazily on first open, then fix size
    if (!mapInitialized) {
      initMap();
    }
    requestAnimationFrame(() => {
      leafletMap.invalidateSize();
      if (gps.latitude !== null) {
        leafletMap.setView([gps.latitude, gps.longitude], leafletMap.getZoom());
      }
    });
  } else {
    panel.classList.remove('visible');
    btn.classList.remove('active');
  }
  localStorage.setItem('gnss_map_visible', mapVisible ? '1' : '0');
}

document.getElementById('btn-map').addEventListener('click', toggleMap);
document.getElementById('btn-dop').addEventListener('click', toggleDopPanel);
document.getElementById('btn-sat-trails').addEventListener('click', () => {
  satTrailsVisible = !satTrailsVisible;
  document.getElementById('btn-sat-trails').classList.toggle('active', satTrailsVisible);
});

document.getElementById('btn-follow').addEventListener('click', () => {
  mapFollow = !mapFollow;
  document.getElementById('btn-follow').classList.toggle('active', mapFollow);
});

document.getElementById('btn-recenter').addEventListener('click', () => {
  if (leafletMap && gps.latitude !== null) {
    leafletMap.setView([gps.latitude, gps.longitude], leafletMap.getZoom(), { animate: true });
  }
});

document.getElementById('btn-clear-track').addEventListener('click', () => {
  trackPoints = [];
  if (trackPolyline) trackPolyline.setLatLngs([]);
});

document.querySelectorAll('.map-layer-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!mapInitialized) return;
    switchTileLayer(btn.dataset.layer);
  });
});

document.getElementById('btn-sbas-overlay').addEventListener('click', () => {
  if (!mapInitialized) return;
  sbasVisible = !sbasVisible;
  if (sbasVisible) {
    sbasLayerGroup.addTo(leafletMap);
  } else {
    sbasLayerGroup.remove();
  }
  document.getElementById('btn-sbas-overlay').classList.toggle('active', sbasVisible);
});

// Restore saved baud rate
(function() {
  const savedBaud = localStorage.getItem('gnss_baud') || '9600';
  const sel = document.getElementById('baud-sel');
  if ([...sel.options].some(o => o.value === savedBaud)) sel.value = savedBaud;
})();

// Restore panel visibility
if (localStorage.getItem('gnss_map_visible') === '1') toggleMap();
if (localStorage.getItem('gnss_dop_visible') === '1') toggleDopPanel();

// Start unified render loop (Leaflet is now loaded)
setInterval(function() { render(); updateMap(); }, 500);

'use strict';
// ── NMEA Recorder UI ─────────────────────────────────────────────────────────

(function() {

  // ── State ──────────────────────────────────────────────────────────────────

  let recState       = 'idle';   // idle | recording | stopped
  let currentSession = null;     // session object while recording
  let lineBuffer     = [];       // lines accumulated in the current 1-sec window
  let recLockRelease = null;     // Web Locks API のロック解放関数
  let bufChunkStart  = Date.now();
  let flushTimer     = null;
  let elapsedTimer   = null;
  let chunkCount     = 0;
  let lineCount      = 0;

  // Session map state
  let recMap         = null;
  let recTrack       = null;
  let recMapSession  = null;   // sessionId currently shown on map
  let recPoints      = [];     // current session's coordinate points

  // ── Hook into NMEA feed ────────────────────────────────────────────────────

  // Intercept each raw NMEA line before it reaches the main feedNMEA.
  // We wrap session.onLine to also push into lineBuffer when recording.
  session.onLine((line) => {
    if (recState === 'recording') {
      lineBuffer.push(line.trim());
    }
  });

  // ── Flush logic ───────────────────────────────────────────────────────────

  /** Flush the current lineBuffer to IndexedDB as a single chunk. */
  async function flushBuffer() {
    if (!currentSession || !lineBuffer.length) {
      lineBuffer    = [];
      bufChunkStart = Date.now();
      return;
    }
    const lines = lineBuffer.slice();
    lineBuffer   = [];
    const endNow = Date.now();
    try {
      await NMEARecorder.saveChunk(currentSession.sessionId, lines, bufChunkStart, endNow);
      chunkCount++;
      lineCount += lines.length;
    } catch (e) {
      console.warn('[Recorder] saveChunk error:', e);
    }
    bufChunkStart = endNow;
    updateRecStats();
  }

  /** Start the 1-second periodic flush timer. */
  function startFlushTimer() {
    bufChunkStart = Date.now();
    flushTimer = setInterval(flushBuffer, 1000);
  }

  /** Stop the timer and flush remaining buffer. */
  async function stopFlushTimer() {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    await flushBuffer();
  }

  // ── Recording controls ─────────────────────────────────────────────────────

  async function startRecording() {
    if (recState === 'recording') return;
    lineBuffer     = [];
    chunkCount     = 0;
    lineCount      = 0;
    currentSession = await NMEARecorder.createSession();
    recState = 'recording';

    // セッションIDに紐づいたロックを取得し、タブが生きている間保持する。
    // 他タブの recoverInterruptedSessions がこのロックを確認して
    // INTERRUPTED への誤マークを防ぐ。
    if (navigator.locks) {
      const lockName = 'gnss_rec_' + currentSession.sessionId;
      new Promise(resolve => {
        recLockRelease = resolve;
        navigator.locks.request(lockName, () => new Promise(r => { recLockRelease = r; }));
      }).catch(() => {});
    }

    startFlushTimer();
    setRecUI('recording');
    document.getElementById('rec-indicator').classList.add('visible');
    startElapsedTimer();
  }

  async function stopRecording() {
    if (recState !== 'recording') return;
    recState = 'stopped';
    await stopFlushTimer();
    await NMEARecorder.stopSession(currentSession.sessionId);

    // ロックを解放
    if (recLockRelease) { recLockRelease(); recLockRelease = null; }

    stopElapsedTimer();
    document.getElementById('rec-indicator').classList.remove('visible');
    setRecUI('stopped');
    currentSession = null;
    // Refresh session list if sessions tab is open
    if (document.getElementById('rec-tab-sessions').classList.contains('active')) {
      await refreshSessionList();
    }
  }

  // ── Elapsed timer ─────────────────────────────────────────────────────────

  function startElapsedTimer() {
    const startMs = Date.now();
    elapsedTimer = setInterval(() => {
      const s = Math.floor((Date.now() - startMs) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      const el = document.getElementById('rec-session-elapsed');
      if (el) el.textContent = `${mm}:${ss}`;
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  // ── UI state management ───────────────────────────────────────────────────

  function setRecUI(state) {
    const dot      = document.getElementById('rec-dot');
    const lbl      = document.getElementById('rec-status-label');
    const info     = document.getElementById('rec-session-info');
    const stats    = document.getElementById('rec-stats-row');
    const btnStart = document.getElementById('btn-rec-start');
    const btnStop  = document.getElementById('btn-rec-stop');
    const toggle   = document.getElementById('btn-rec-toggle');

    // Reset all state classes
    dot.className = 'rec-status-dot ' + state;
    lbl.className = 'rec-status-label ' + state;

    if (state === 'recording') {
      lbl.textContent  = 'RECORDING';
      btnStart.style.display = 'none';
      btnStop.style.display  = '';
      info.style.display  = 'flex';
      stats.style.display = 'flex';
      if (currentSession) {
        document.getElementById('rec-session-name').textContent  = currentSession.displayName;
        document.getElementById('rec-session-start').textContent = new Date(currentSession.startedAt).toLocaleTimeString('ja-JP');
      }
      toggle.innerHTML = '&#9632; STOP';
      toggle.classList.add('recording');
    } else if (state === 'stopped') {
      lbl.textContent  = 'STOPPED';
      btnStart.style.display = '';
      btnStop.style.display  = 'none';
      info.style.display  = 'none';
      stats.style.display = 'none';
      toggle.innerHTML = '&#9679; REC';
      toggle.classList.remove('recording');
    } else {
      lbl.textContent  = 'IDLE';
      btnStart.style.display = '';
      btnStop.style.display  = 'none';
      info.style.display  = 'none';
      stats.style.display = 'none';
      toggle.innerHTML = '&#9679; REC';
      toggle.classList.remove('recording');
    }
  }

  function updateRecStats() {
    const elC = document.getElementById('rec-stat-chunks');
    const elL = document.getElementById('rec-stat-lines');
    const elB = document.getElementById('rec-stat-buf');
    if (elC) elC.textContent = chunkCount;
    if (elL) elL.textContent = lineCount;
    if (elB) elB.textContent = lineBuffer.length;
  }

  // Periodically refresh buffer count while recording
  setInterval(() => {
    if (recState === 'recording') updateRecStats();
  }, 500);

  // ── Session list ──────────────────────────────────────────────────────────

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  async function refreshSessionList() {
    const tbody   = document.getElementById('rec-session-tbody');
    const sessions = await NMEARecorder.listSessions();

    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--dim);padding:20px">記録がありません</td></tr>';
      return;
    }

    tbody.innerHTML = sessions.map(s => {
      const badgeCls = s.status === 'recording'   ? 'recording'
                     : s.status === 'interrupted' ? 'interrupted'
                     : 'stopped';
      const badge = s.status === 'interrupted'
        ? `<button class="rec-status-badge interrupted" data-action="close" data-sid="${esc(s.sessionId)}" title="クリックしてクローズ" style="cursor:pointer;font:inherit;border:none;padding:2px 6px">INTERRUPTED</button>`
        : `<span class="rec-status-badge ${badgeCls}">${s.status.toUpperCase()}</span>`;
      return `<tr data-sid="${esc(s.sessionId)}">
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis">${esc(s.displayName)}</td>
        <td>${fmtDate(s.startedAt)}</td>
        <td>${fmtDate(s.endedAt)}</td>
        <td>${badge}</td>
        <td style="text-align:right;color:var(--dim)">${s.totalLines.toLocaleString()}</td>
        <td style="text-align:right;color:var(--dim)">${fmtSize(s.totalBytes)}</td>
        <td style="white-space:nowrap">
          <button class="rec-action-btn dl"  data-action="dl"  data-sid="${esc(s.sessionId)}">DL</button>
          <button class="rec-action-btn map" data-action="map" data-sid="${esc(s.sessionId)}">Map</button>
          <button class="rec-action-btn del" data-action="del" data-sid="${esc(s.sessionId)}">Del</button>
        </td>
      </tr>`;
    }).join('');

    // Row / button click handlers
    tbody.querySelectorAll('tr[data-sid]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;  // handled below
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('active'));
        tr.classList.add('active');
      });
    });

    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sid    = btn.dataset.sid;
        const action = btn.dataset.action;
        const sessions2 = await NMEARecorder.listSessions();
        const session   = sessions2.find(s => s.sessionId === sid);
        if (!session) return;

        if (action === 'dl') {
          btn.textContent = '...';
          btn.disabled = true;
          try { await NMEARecorder.downloadSession(session); }
          finally { btn.textContent = 'DL'; btn.disabled = false; }

        } else if (action === 'map') {
          await showSessionOnMap(session);

        } else if (action === 'close') {
          if (!confirm(`「${session.displayName}」のセッションの記録をクローズしますか？`)) return;
          await NMEARecorder.stopSession(sid);
          await refreshSessionList();

        } else if (action === 'del') {
          if (!confirm(`「${session.displayName}」を削除しますか？\n(チャンク含む全データが削除されます)`)) return;
          await NMEARecorder.deleteSession(sid);
          if (recMapSession === sid) hideSessionMap();
          await refreshSessionList();
        }
      });
    });
  }

  // ── Session map ───────────────────────────────────────────────────────────

  /** NMEA時刻文字列 "HHMMSS.ss" → "HH:MM:SS UTC" */
  function fmtNmeaTime(t) {
    if (!t || t.length < 6) return t || '—';
    return `${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)} UTC`;
  }

  /** クリック位置に最も近い点を返す (lat/lon 二乗距離) */
  function nearestPoint(pts, latlng) {
    let best = null, bestD = Infinity;
    for (const p of pts) {
      const d = (p.lat - latlng.lat) ** 2 + (p.lon - latlng.lng) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** 十進度を度分秒文字列に変換 */
  function fmtDMS(deg, posDir, negDir) {
    const dir = deg >= 0 ? posDir : negDir;
    const abs = Math.abs(deg);
    const d   = Math.floor(abs);
    const mf  = (abs - d) * 60;
    const m   = Math.floor(mf);
    const s   = ((mf - m) * 60).toFixed(2);
    return `${d}°${String(m).padStart(2,'0')}'${s.padStart(5,'0')}"${dir}`;
  }

  const REC_TILE_LAYERS = {
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      options: { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19 },
    },
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      options: { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 19 },
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { attribution: '&copy; Esri', maxZoom: 19 },
    },
  };

  let recCurrentTileLayer = null;
  let recCurrentLayerKey  = 'dark';

  /** recMap のタイルレイヤーを切り替える */
  function switchRecLayer(key) {
    if (!recMap || !REC_TILE_LAYERS[key]) return;
    if (recCurrentTileLayer) recMap.removeLayer(recCurrentTileLayer);
    recCurrentTileLayer = L.tileLayer(REC_TILE_LAYERS[key].url, REC_TILE_LAYERS[key].options).addTo(recMap);
    if (recTrack) recTrack.bringToFront();
    recCurrentLayerKey = key;
    document.querySelectorAll('.rec-layer-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.reclayer === key);
    });
  }

  // レイヤーボタンのクリック
  document.querySelectorAll('.rec-layer-btn').forEach(btn => {
    btn.addEventListener('click', () => switchRecLayer(btn.dataset.reclayer));
  });

  function ensureRecMap() {
    if (recMap) return;
    recMap = L.map('rec-session-map', { zoomControl: true, attributionControl: true })
               .setView([35.6895, 139.6917], 13);
    recCurrentTileLayer = L.tileLayer(REC_TILE_LAYERS.dark.url, REC_TILE_LAYERS.dark.options).addTo(recMap);

    recTrack = L.polyline([], { color: '#3de87a', weight: 3, opacity: 0.85 }).addTo(recMap);

    // クリックで最近傍点の情報をポップアップ表示
    recTrack.on('click', (e) => {
      const p = nearestPoint(recPoints, e.latlng);
      if (!p) return;
      L.popup({ maxWidth: 260 })
        .setLatLng([p.lat, p.lon])
        .setContent(`
          <div class="rec-popup">
            <div class="rec-popup-row">
              <span class="rec-popup-key">Time</span>
              <span class="rec-popup-val">${fmtNmeaTime(p.time)}</span>
            </div>
            <div class="rec-popup-row">
              <span class="rec-popup-key">Lat</span>
              <span class="rec-popup-val">${fmtDMS(p.lat, 'N', 'S')}</span>
            </div>
            <div class="rec-popup-row">
              <span class="rec-popup-key">Lon</span>
              <span class="rec-popup-val">${fmtDMS(p.lon, 'E', 'W')}</span>
            </div>
            <div class="rec-popup-row" style="margin-top:2px;border-top:1px solid var(--border);padding-top:4px">
              <span class="rec-popup-key">Decimal</span>
              <span class="rec-popup-val" style="color:var(--dim)">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span>
            </div>
          </div>`)
        .openOn(recMap);
      L.DomEvent.stopPropagation(e);
    });
  }

  async function showSessionOnMap(session) {
    const wrap   = document.getElementById('rec-session-map-wrap');
    const detail = document.getElementById('rec-session-detail');
    const empty  = document.getElementById('rec-map-empty');

    wrap.classList.add('visible');
    detail.style.display = 'block';
    document.getElementById('rec-detail-name').textContent = session.displayName;

    ensureRecMap();
    recMap.invalidateSize();

    const points = await NMEARecorder.getSessionPoints(session.sessionId);
    document.getElementById('rec-detail-pts').textContent = points.length;

    recTrack.setLatLngs([]);
    recPoints     = points;
    recMapSession = session.sessionId;
    recMap.closePopup();

    if (!points.length) {
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';

    const latlngs = points.map(p => [p.lat, p.lon]);
    recTrack.setLatLngs(latlngs);

    // Add start/end markers
    if (latlngs.length > 0) {
      const startIcon = L.divIcon({
        className: '',
        html: '<div style="width:10px;height:10px;background:#3de87a;border-radius:50%;box-shadow:0 0 6px #3de87a"></div>',
        iconSize: [10, 10], iconAnchor: [5, 5],
      });
      L.marker(latlngs[0], { icon: startIcon }).addTo(recMap).bindTooltip('Start', { permanent: false });
    }

    recMap.fitBounds(recTrack.getBounds(), { padding: [20, 20] });
  }

  function hideSessionMap() {
    document.getElementById('rec-session-map-wrap').classList.remove('visible');
    document.getElementById('rec-session-detail').style.display = 'none';
    recMapSession = null;
    recPoints     = [];
    if (recMap) recMap.closePopup();
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  document.querySelectorAll('.rec-tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.rec-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.rec-tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tab = document.getElementById('rec-tab-' + btn.dataset.rectab);
      if (tab) tab.classList.add('active');
      if (btn.dataset.rectab === 'sessions') {
        await refreshSessionList();
        // Fix map size after becoming visible
        if (recMap) setTimeout(() => recMap.invalidateSize(), 100);
      }
    });
  });

  // ── Overlay open/close ────────────────────────────────────────────────────

  function openRecorder() {
    document.getElementById('recorder-overlay').classList.add('visible');
    document.getElementById('recorder-overlay').setAttribute('aria-hidden', 'false');
  }

  function closeRecorder() {
    document.getElementById('recorder-overlay').classList.remove('visible');
    document.getElementById('recorder-overlay').setAttribute('aria-hidden', 'true');
  }

  // Sessions button: open modal directly to sessions tab
  document.getElementById('btn-rec').addEventListener('click', () => {
    document.querySelectorAll('.rec-tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.rec-tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelector('.rec-tab-btn[data-rectab="sessions"]').classList.add('active');
    document.getElementById('rec-tab-sessions').classList.add('active');
    refreshSessionList();
    openRecorder();
  });
  document.getElementById('rec-btn-close').addEventListener('click', closeRecorder);
  document.getElementById('rec-backdrop').addEventListener('click', closeRecorder);

  // ── REC toggle button (main screen) ──────────────────────────────────────

  document.getElementById('btn-rec-toggle').addEventListener('click', async () => {
    if (recState === 'recording') {
      await stopRecording();
    } else {
      await startRecording();
    }
  });

  // ── Record buttons (inside modal) ─────────────────────────────────────────

  document.getElementById('btn-rec-start').addEventListener('click', startRecording);
  document.getElementById('btn-rec-stop').addEventListener('click', async () => {
    await stopRecording();
  });

  // ── On load: recover interrupted sessions ─────────────────────────────────

  NMEARecorder.openDB().then(async () => {
    const n = await NMEARecorder.recoverInterruptedSessions();
    if (n > 0) {
      document.getElementById('rec-notice-interrupted').style.display = 'block';
    }
  }).catch(e => console.warn('[Recorder] DB init error:', e));

  // ── Keyboard: Escape closes overlay ──────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('recorder-overlay').classList.contains('visible')) {
        closeRecorder();
      }
    }
  });

  // ── beforeunload: flush remaining buffer ─────────────────────────────────
  // (best-effort; 1-sec timer already handles most cases)
  window.addEventListener('beforeunload', () => {
    if (recState === 'recording' && lineBuffer.length && currentSession) {
      // Synchronous IndexedDB is not possible here; the timer should have
      // already flushed within the last second. Mark session interrupted.
      // The next page load will recover it via recoverInterruptedSessions().
    }
  });

  // ── Session map resizer ───────────────────────────────────────────────────

  (function initRecMapResizer() {
    const wrap   = document.getElementById('rec-session-map-wrap');
    const handle = document.getElementById('rec-map-resizer');
    const MIN_H  = 120;
    const MAX_H  = () => Math.floor(window.innerHeight * 0.75);

    let active = false;
    let startY = 0;
    let startH = 0;

    function clamp(h) {
      return Math.min(MAX_H(), Math.max(MIN_H, Math.floor(h)));
    }

    function onMove(e) {
      if (!active) return;
      // ハンドルはマップ上端にある。上にドラッグ → dy < 0 → 高さを増やす
      const nextH = clamp(startH - (e.clientY - startY));
      wrap.style.height = `${nextH}px`;
      if (recMap) recMap.invalidateSize();
    }

    function onStop(e) {
      if (!active) return;
      active = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup',   onStop);
      window.removeEventListener('pointercancel', onStop);
      document.body.classList.remove('rec-map-resizing');
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      active  = true;
      startY  = e.clientY;
      startH  = wrap.getBoundingClientRect().height;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('rec-map-resizing');
      window.addEventListener('pointermove',   onMove);
      window.addEventListener('pointerup',     onStop);
      window.addEventListener('pointercancel', onStop);
      e.preventDefault();
    });
  })();

  // ── Settings Dropdown ─────────────────────────────────────────────────────
  (function() {
    const btnSettings = document.getElementById('btn-settings');
    const settingsMenu = document.getElementById('settings-menu');
    if (!btnSettings || !settingsMenu) return;

    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsMenu.classList.toggle('open');
    });

    settingsMenu.addEventListener('click', () => {
      settingsMenu.classList.remove('open');
    });

    document.addEventListener('click', () => {
      settingsMenu.classList.remove('open');
    });
  })();

})();
