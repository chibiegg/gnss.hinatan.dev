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
  // Prefer explicit PRN ranges so mixed talkers still map correctly.
  if (prn >= 183 && prn <= 197) return 'QZSS';
  if (prn >= 141 && prn <= 172) return 'BeiDou';
  if (prn >= 301 && prn <= 330) return 'Galileo';
  if (prn >= 65  && prn <= 92)  return 'GLONASS';
  if (prn >= 33  && prn <= 51)  return 'SBAS';
  if (prn >= 1   && prn <= 32)  return 'GPS';

  const map = { GP:'GPS', GL:'GLONASS', GA:'Galileo', GB:'BeiDou', BD:'BeiDou', GQ:'QZSS' };
  if (map[talker]) return map[talker];
  if (talker === 'GN') {
    if (prn >= 1   && prn <= 32)  return 'GPS';
    if (prn >= 33  && prn <= 51)  return 'SBAS';
    if (prn >= 65  && prn <= 92)  return 'GLONASS';
    if (prn >= 141 && prn <= 172) return 'BeiDou';
    if (prn >= 183 && prn <= 197) return 'QZSS';
    if (prn >= 301 && prn <= 330) return 'Galileo';
  }
  return 'GPS';
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
    // Stamp each listed PRN with the current time. Multiple GSA sentences
    // (one per constellation) all accumulate into the same satellites map.
    // The "used" flag is derived from usedAt freshness in cleanupSatellites().
    const now = Date.now();
    for (let i = 3; i < 15 && i < p.length; i++) {
      if (p[i]) {
        const n = parseInt(p[i]);
        if (!isNaN(n) && gps.satellites[n]) gps.satellites[n].usedAt = now;
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
      const prn = p[i] ? parseInt(p[i]) : null;
      if (prn !== null && !isNaN(prn)) {
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
};

function feedNMEA(raw) {
  const line = raw.trim();
  if (!line.startsWith('$')) return;
  if (!checksumOk(line)) return;

  gps.raw_log.push(line.slice(0, 120));
  if (gps.raw_log.length > 30) gps.raw_log.shift();
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

const SAT_STALE_MS = 1500;

function cleanupSatellites() {
  const now = Date.now();
  for (const prn of Object.keys(gps.satellites)) {
    const sat = gps.satellites[prn];
    if (now - sat.lastSeen > SAT_STALE_MS) {
      delete gps.satellites[prn];
    } else {
      sat.used = sat.usedAt !== null && (now - sat.usedAt < SAT_STALE_MS);
    }
  }
}

// ── Line Buffer ───────────────────────────────────────────────────────────────

let lineBuf = '';
function receiveData(chunk) {
  lineBuf += chunk;
  const lines = lineBuf.split('\n');
  lineBuf = lines.pop();
  for (const l of lines) feedNMEA(l);
}

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

  for (const l of lines) receiveData(l);
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
  if (!serialActive) setConnState('off', 'Offline');
}

// ── Web Serial API ────────────────────────────────────────────────────────────

let serialPort   = null;
let serialReader = null;
let serialActive = false;

function setConnState(state, label) {
  const dot = document.getElementById('conn-dot');
  const lbl = document.getElementById('conn-label');
  dot.className = 'conn-dot' + (state !== 'off' ? ' ' + state : '');
  lbl.textContent = label;
}

async function connectSerial() {
  const baud = parseInt(document.getElementById('baud-sel').value);
  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: baud });
    serialActive = true;
    document.getElementById('btn-connect').textContent = 'Disconnect';
    document.getElementById('btn-connect').classList.add('active');
    setConnState('connected', `${baud} bps`);

    const dec = new TextDecoderStream();
    const pipe = serialPort.readable.pipeTo(dec.writable);
    serialReader = dec.readable.getReader();

    while (serialActive) {
      const { value, done } = await serialReader.read();
      if (done) break;
      if (value) receiveData(value);
    }
  } catch (e) {
    console.warn('Serial error:', e);
  } finally {
    await disconnectSerial();
  }
}

async function disconnectSerial() {
  serialActive = false;
  if (serialReader) { try { await serialReader.cancel(); } catch {} serialReader = null; }
  if (serialPort)   { try { await serialPort.close();    } catch {} serialPort   = null; }
  document.getElementById('btn-connect').textContent = 'Connect';
  document.getElementById('btn-connect').classList.remove('active');
  if (!demoActive) setConnState('off', 'Offline');
}

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
}

// ── Raw NMEA Log ──────────────────────────────────────────────────────────────

let rawVersion = 0;
let lastRawVersion = -1;

function updateRaw() {
  if (rawVersion === lastRawVersion) return;
  lastRawVersion = rawVersion;

  const lines = gps.raw_log.slice(-14);
  const el = document.getElementById('raw-log');
  el.innerHTML = lines.map(line => {
    const m = line.match(/^\$([A-Z]{2})([A-Z]{2,3})(,.*?)(\*[0-9A-Fa-f]{2})?$/);
    if (m) {
      const body = esc(m[3]);
      const cs   = m[4] ? `<span class="n-star">*</span><span class="n-cs">${esc(m[4].slice(1))}</span>` : '';
      return `<div class="nmea-line"><span class="n-dollar">$</span><span class="n-talker">${esc(m[1])}</span><span class="n-type">${esc(m[2])}</span><span class="n-body">${body}</span>${cs}</div>`;
    }
    return `<div class="nmea-line n-info">${esc(line)}</div>`;
  }).join('');

  const scr = document.getElementById('raw-scroll');
  scr.scrollTop = scr.scrollHeight;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Render Loop ───────────────────────────────────────────────────────────────

function render() {
  cleanupSatellites();
  updateStatus();
  updateData();
  resizeSky();
  drawSky();
  updateLegend();
  updateSatTable();
  updateRaw();
}

// ── Buttons ───────────────────────────────────────────────────────────────────

document.getElementById('btn-connect').addEventListener('click', async () => {
  if (serialActive) {
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

// ── Init ──────────────────────────────────────────────────────────────────────

if (!('serial' in navigator)) {
  document.getElementById('no-serial-warn').style.display = 'block';
  document.getElementById('btn-connect').disabled = true;
}

window.addEventListener('resize', resizeSky);
setTimeout(resizeSky, 100);

// ── Map ───────────────────────────────────────────────────────────────────────

let leafletMap    = null;
let gpsMarker     = null;
let trackPolyline = null;
let trackPoints   = [];
let mapFollow     = true;
let mapVisible    = false;
let mapInitialized = false;

const TRACK_MAX = 2000;

function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;

  leafletMap = L.map('map-container', { zoomControl: true, attributionControl: true })
    .setView([35.6895, 139.6917], 15);

  // CartoDB dark matter tiles
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(leafletMap);

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
}

function updateMap() {
  if (!mapVisible || !mapInitialized) return;
  if (gps.latitude === null || gps.longitude === null) return;

  const latlng = [gps.latitude, gps.longitude];

  // Move marker
  if (!leafletMap.hasLayer(gpsMarker)) gpsMarker.addTo(leafletMap);
  gpsMarker.setLatLng(latlng);

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
}

document.getElementById('btn-map').addEventListener('click', toggleMap);

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

// Start unified render loop (Leaflet is now loaded)
setInterval(function() { render(); updateMap(); }, 500);
