'use strict';

// u-blox M10 (SPG 5.20) configuration tool
// Uses UBX binary protocol over Web Serial API
// Reference: UBXDOC-304424225-20128

(function initUbloxM10Factory(global) {

  // ── UBX Protocol Utilities ────────────────────────────────────────────────

  function buildUbxPacket(cls, id, payload) {
    const len = payload.length;
    const pkt = new Uint8Array(6 + len + 2);
    pkt[0] = 0xB5; pkt[1] = 0x62;
    pkt[2] = cls;  pkt[3] = id;
    pkt[4] = len & 0xFF; pkt[5] = (len >> 8) & 0xFF;
    pkt.set(payload, 6);
    let a = 0, b = 0;
    for (let i = 2; i < 6 + len; i++) { a = (a + pkt[i]) & 0xFF; b = (b + a) & 0xFF; }
    pkt[6 + len] = a; pkt[6 + len + 1] = b;
    return pkt;
  }

  function cfgKeyValueSize(key) {
    switch ((key >>> 28) & 0xF) {
      case 0x1: return 1;
      case 0x2: return 1;
      case 0x3: return 2;
      case 0x4: return 4;
      case 0x5: return 8;
      default:  return 0;
    }
  }

  function encodeKey(key) {
    return [(key) & 0xFF, (key >> 8) & 0xFF, (key >> 16) & 0xFF, (key >> 24) & 0xFF];
  }

  function encodeValue(key, value) {
    const size = cfgKeyValueSize(key);
    const v = value >>> 0;
    if (size === 1) return [v & 0xFF];
    if (size === 2) return [v & 0xFF, (v >> 8) & 0xFF];
    if (size === 4) return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];
    return [];
  }

  function decodeValue(buf, offset, key) {
    const size = cfgKeyValueSize(key);
    if (size === 1) return buf[offset];
    if (size === 2) return buf[offset] | (buf[offset + 1] << 8);
    if (size === 4) return (buf[offset] | (buf[offset+1] << 8) | (buf[offset+2] << 16) | (buf[offset+3] << 24)) >>> 0;
    return 0;
  }

  function buildValGet(keys) {
    const payload = [0x00, 0x00, 0x00, 0x00]; // version=0, layer=RAM, pos=0
    for (const k of keys) payload.push(...encodeKey(k));
    return buildUbxPacket(0x06, 0x8B, new Uint8Array(payload));
  }

  function buildValSet(kvPairs, layers) {
    const payload = [0x00, layers, 0x00, 0x00];
    for (const [key, value] of kvPairs) {
      payload.push(...encodeKey(key));
      payload.push(...encodeValue(key, value));
    }
    return buildUbxPacket(0x06, 0x8A, new Uint8Array(payload));
  }

  function buildMonVer()    { return buildUbxPacket(0x0A, 0x04, new Uint8Array(0)); }
  function buildSoftReset() { return buildUbxPacket(0x06, 0x04, new Uint8Array([0x00, 0x00, 0x01, 0x00])); }

  // ── UBX Packet Parser ─────────────────────────────────────────────────────

  function createUbxParser(onPacket) {
    const S = { IDLE:0, SYNC2:1, CLASS:2, ID:3, LL:4, LH:5, PAYLOAD:6, CKA:7, CKB:8 };
    let state = S.IDLE, cls = 0, id = 0, len = 0, pi = 0;
    let payload = null, ckA = 0, ckB = 0;

    return function feed(bytes) {
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        switch (state) {
          case S.IDLE:    if (b === 0xB5) state = S.SYNC2; break;
          case S.SYNC2:   state = (b === 0x62) ? S.CLASS : (b === 0xB5 ? S.SYNC2 : S.IDLE); break;
          case S.CLASS:   cls = b; ckA = (b) & 0xFF; ckB = ckA; state = S.ID; break;
          case S.ID:      id  = b; ckA = (ckA+b)&0xFF; ckB=(ckB+ckA)&0xFF; state = S.LL; break;
          case S.LL:      len = b; ckA = (ckA+b)&0xFF; ckB=(ckB+ckA)&0xFF; state = S.LH; break;
          case S.LH:
            len |= (b<<8); ckA=(ckA+b)&0xFF; ckB=(ckB+ckA)&0xFF;
            payload = new Uint8Array(len); pi = 0;
            state = len > 0 ? S.PAYLOAD : S.CKA;
            break;
          case S.PAYLOAD:
            payload[pi++] = b; ckA=(ckA+b)&0xFF; ckB=(ckB+ckA)&0xFF;
            if (pi >= len) state = S.CKA;
            break;
          case S.CKA: state = (b === ckA) ? S.CKB : S.IDLE; break;
          case S.CKB:
            state = S.IDLE;
            if (b === ckB) try { onPacket(cls, id, payload); } catch { /* ignore */ }
            break;
        }
      }
    };
  }

  // ── Configuration Key Definitions (u-blox M10 SPG 5.20) ──────────────────

  const CFG_KEY = {
    // GNSS system-level enable (L = 1 byte bool)
    SIGNAL_GPS_ENA:         0x1031001F,
    SIGNAL_SBAS_ENA:        0x10310020,
    SIGNAL_GAL_ENA:         0x10310021,
    SIGNAL_BDS_ENA:         0x10310022,
    SIGNAL_QZSS_ENA:        0x10310024,
    SIGNAL_GLO_ENA:         0x10310025,

    // GNSS individual signal enable (L = 1 byte bool)
    SIGNAL_GPS_L1CA_ENA:    0x10310001,
    SIGNAL_SBAS_L1CA_ENA:   0x10310005,
    SIGNAL_GAL_E1_ENA:      0x10310007,
    SIGNAL_BDS_B1I_ENA:     0x1031000D,
    SIGNAL_BDS_B1C_ENA:     0x1031000F,
    SIGNAL_QZSS_L1CA_ENA:   0x10310012,
    SIGNAL_QZSS_L1S_ENA:    0x10310014,
    SIGNAL_GLO_L1_ENA:      0x10310018,

    // Navigation rate (U2 = 2 byte)
    RATE_MEAS:              0x30210001,  // Measurement period (ms)
    RATE_NAV:               0x30210002,  // Nav solution ratio

    // UART1
    UART1_BAUDRATE:         0x40520001,  // U4

    // UART1 input protocols (L)
    UART1INPROT_UBX:        0x10730001,
    UART1INPROT_NMEA:       0x10730002,
    // UART1INPROT_RTCM3X は M10 (非RTK) では未サポート

    // UART1 output protocols (L)
    UART1OUTPROT_UBX:       0x10740001,
    UART1OUTPROT_NMEA:      0x10740002,

    // NMEA output on UART1 (U1 = rate, 0=off)
    MSGOUT_GGA_UART1:       0x209100BB,
    MSGOUT_GLL_UART1:       0x209100CA,
    MSGOUT_GSA_UART1:       0x209100C0,
    MSGOUT_GSV_UART1:       0x209100C4,
    MSGOUT_RMC_UART1:       0x209100AC,
    MSGOUT_VTG_UART1:       0x209100B0,
    MSGOUT_GNS_UART1:       0x209100B5,
    MSGOUT_ZDA_UART1:       0x209100D8,

    // NMEA protocol settings
    NMEA_PROTVER:           0x20930001,  // E1: 0x21=2.1, 0x23=2.3, 0x40=4.0, 0x41=4.10
    NMEA_MAXSVS:            0x20930002,  // U1: max SVs per talker ID (0=unlimited)
    NMEA_COMPAT:            0x10930003,  // L: compatibility mode
    NMEA_CONSIDER:          0x10930004,  // L: consider mode
    NMEA_LIMIT82:           0x10930005,  // L: limit to 82 chars
    NMEA_HIGHPREC:          0x10930006,  // L: high precision mode
    NMEA_SVNUMBERING:       0x20930007,  // E1: 0=Strict, 1=Extended
    NMEA_FILT_GPS:          0x10930011,  // L: filter GPS from NMEA
    NMEA_FILT_SBAS:         0x10930012,  // L: filter SBAS
    NMEA_FILT_GAL:          0x10930013,  // L: filter Galileo
    // NMEA_FILT_BDS (0x10930014) は M10 SPG 5.20 で未サポート
    NMEA_FILT_QZSS:         0x10930015,  // L: filter QZSS
    NMEA_FILT_GLO:          0x10930016,  // L: filter GLONASS
    // NMEA_OUT_INVFIX (0x10930020) は M10 SPG 5.20 で未サポート
    NMEA_OUT_MSKFIX:        0x10930021,  // L: output masked fix sentences

    // SBAS settings (L)
    SBAS_USE_TESTMODE:      0x10360002,
    SBAS_USE_RANGING:       0x10360003,
    SBAS_USE_DIFFCORR:      0x10360004,
    SBAS_USE_INTEGRITY:     0x10360005,

    // Navigation filter (CFG-NAVSPG)
    NAVSPG_FIXMODE:         0x20110011,  // E1: 1=2DOnly, 2=3DOnly, 3=Auto
    NAVSPG_INIFIX3D:        0x10110013,  // L
    NAVSPG_UTCSTANDARD:     0x2011001C,  // E1: 0=Auto, 1=GPS, 2=GLONASS, 3=BeiDou, 4=Galileo
    NAVSPG_DYNMODEL:        0x20110021,  // E1: 0=Portable,2=Stationary,3=Pedestrian,4=Automotive,...

    // Timepulse TP1
    TP_TP1_ENA:             0x10050007,  // L
    TP_SYNC_GNSS_TP1:       0x10050008,  // L
    TP_USE_LOCKED_TP1:      0x10050009,  // L
    TP_ALIGN_TO_TOW_TP1:    0x1005000A,  // L
    TP_POL_TP1:             0x1005000B,  // L: 0=falling edge, 1=rising edge
    TP_TIMEGRID_TP1:        0x2005000C,  // E1: 0=UTC, 1=GPS, 2=GLONASS, 3=BeiDou, 4=Galileo
    TP_PERIOD_TP1:          0x40050002,  // U4: period μs (no fix)
    TP_PERIOD_LOCK_TP1:     0x40050003,  // U4: period μs (locked)
    TP_LEN_TP1:             0x40050004,  // U4: pulse length μs (no fix)
    TP_LEN_LOCK_TP1:        0x40050005,  // U4: pulse length μs (locked)
  };

  // ── Data Tables ───────────────────────────────────────────────────────────

  const GNSS_SYSTEMS = [
    { name: 'GPS',     key: CFG_KEY.SIGNAL_GPS_ENA,  sigKey: CFG_KEY.SIGNAL_GPS_L1CA_ENA,  sigLabel: 'L1C/A' },
    { name: 'GLONASS', key: CFG_KEY.SIGNAL_GLO_ENA,  sigKey: CFG_KEY.SIGNAL_GLO_L1_ENA,   sigLabel: 'L1OF' },
    { name: 'Galileo', key: CFG_KEY.SIGNAL_GAL_ENA,  sigKey: CFG_KEY.SIGNAL_GAL_E1_ENA,   sigLabel: 'E1' },
    { name: 'BeiDou',  key: CFG_KEY.SIGNAL_BDS_ENA,  sigKey: CFG_KEY.SIGNAL_BDS_B1I_ENA,  sigLabel: 'B1I' },
    { name: 'QZSS',    key: CFG_KEY.SIGNAL_QZSS_ENA, sigKey: CFG_KEY.SIGNAL_QZSS_L1CA_ENA,sigLabel: 'L1C/A' },
    { name: 'SBAS',    key: CFG_KEY.SIGNAL_SBAS_ENA, sigKey: CFG_KEY.SIGNAL_SBAS_L1CA_ENA,sigLabel: 'L1C/A' },
  ];

  const BDS_EXTRA = [
    { sigKey: CFG_KEY.SIGNAL_BDS_B1C_ENA, sigLabel: 'B1C' },
  ];
  const QZSS_EXTRA = [
    { sigKey: CFG_KEY.SIGNAL_QZSS_L1S_ENA, sigLabel: 'L1S (SLAS)' },
  ];

  const NMEA_MESSAGES = [
    { name: '$GxGGA', key: CFG_KEY.MSGOUT_GGA_UART1, desc: '現在位置（緯度経度・高度・Fix情報）' },
    { name: '$GxRMC', key: CFG_KEY.MSGOUT_RMC_UART1, desc: '推奨最小航法データ（位置・速度・日時）' },
    { name: '$GxGSA', key: CFG_KEY.MSGOUT_GSA_UART1, desc: '使用衛星とDOP値' },
    { name: '$GxGSV', key: CFG_KEY.MSGOUT_GSV_UART1, desc: '可視衛星情報（PRN・SNR）' },
    { name: '$GxVTG', key: CFG_KEY.MSGOUT_VTG_UART1, desc: '対地速度・進行方向' },
    { name: '$GxGLL', key: CFG_KEY.MSGOUT_GLL_UART1, desc: '緯度経度と時刻' },
    { name: '$GxGNS', key: CFG_KEY.MSGOUT_GNS_UART1, desc: 'GNSS Fix Data（複数コンステレーション対応）' },
    { name: '$GPZDA', key: CFG_KEY.MSGOUT_ZDA_UART1, desc: 'UTC日付時刻' },
  ];

  const NMEA_PROTVER_OPTIONS = [
    { value: 0x21, label: 'NMEA 2.1' },
    { value: 0x23, label: 'NMEA 2.3' },
    { value: 0x40, label: 'NMEA 4.0' },
    { value: 0x41, label: 'NMEA 4.10' },
  ];

  const DYNMODEL_OPTIONS = [
    { value: 0, label: '0 — Portable（汎用・デフォルト）' },
    { value: 2, label: '2 — Stationary（固定設置）' },
    { value: 3, label: '3 — Pedestrian（歩行者）' },
    { value: 4, label: '4 — Automotive（車載）' },
    { value: 5, label: '5 — Sea（船舶）' },
    { value: 6, label: '6 — Airborne <1g（航空・低機動）' },
    { value: 7, label: '7 — Airborne <2g（航空・中機動）' },
    { value: 8, label: '8 — Airborne <4g（航空・高機動）' },
    { value: 9, label: '9 — Wrist（腕時計型）' },
  ];

  const FIXMODE_OPTIONS = [
    { value: 1, label: '2D Only — 常に2D測位（高度固定）' },
    { value: 2, label: '3D Only — 常に3D測位（衛星4個以上必要）' },
    { value: 3, label: 'Auto — 自動切替 2D/3D（デフォルト）' },
  ];

  const UTCSTANDARD_OPTIONS = [
    { value: 0, label: '0 — Auto（自動選択）' },
    { value: 1, label: '1 — GPS / USNO' },
    { value: 2, label: '2 — GLONASS / SU' },
    { value: 3, label: '3 — BeiDou / NTSC' },
    { value: 4, label: '4 — Galileo / EU' },
  ];

  const TP_TIMEGRID_OPTIONS = [
    { value: 0, label: 'UTC' },
    { value: 1, label: 'GPS' },
    { value: 2, label: 'GLONASS' },
    { value: 3, label: 'BeiDou' },
    { value: 4, label: 'Galileo' },
  ];

  const MEAS_RATES_MS  = [100, 200, 250, 500, 1000, 2000, 5000, 10000];
  const NAV_RATES      = [1, 2, 4, 5, 10];
  const BAUDRATE_LIST  = [4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  // All keys to read from device
  function allConfigKeys() {
    return [
      ...GNSS_SYSTEMS.map(s => s.key),
      ...GNSS_SYSTEMS.map(s => s.sigKey),
      CFG_KEY.SIGNAL_BDS_B1C_ENA, CFG_KEY.SIGNAL_QZSS_L1S_ENA,
      CFG_KEY.RATE_MEAS, CFG_KEY.RATE_NAV,
      CFG_KEY.UART1_BAUDRATE,
      CFG_KEY.UART1INPROT_UBX, CFG_KEY.UART1INPROT_NMEA,
      CFG_KEY.UART1OUTPROT_UBX, CFG_KEY.UART1OUTPROT_NMEA,
      ...NMEA_MESSAGES.map(m => m.key),
      CFG_KEY.NMEA_PROTVER, CFG_KEY.NMEA_MAXSVS, CFG_KEY.NMEA_COMPAT,
      CFG_KEY.NMEA_CONSIDER, CFG_KEY.NMEA_LIMIT82, CFG_KEY.NMEA_HIGHPREC,
      CFG_KEY.NMEA_SVNUMBERING, CFG_KEY.NMEA_FILT_GPS, CFG_KEY.NMEA_FILT_SBAS,
      CFG_KEY.NMEA_FILT_GAL, CFG_KEY.NMEA_FILT_QZSS,
      CFG_KEY.NMEA_FILT_GLO, CFG_KEY.NMEA_OUT_MSKFIX,
      CFG_KEY.SBAS_USE_TESTMODE, CFG_KEY.SBAS_USE_RANGING,
      CFG_KEY.SBAS_USE_DIFFCORR, CFG_KEY.SBAS_USE_INTEGRITY,
      CFG_KEY.NAVSPG_FIXMODE, CFG_KEY.NAVSPG_INIFIX3D,
      CFG_KEY.NAVSPG_UTCSTANDARD, CFG_KEY.NAVSPG_DYNMODEL,
      CFG_KEY.TP_TP1_ENA, CFG_KEY.TP_SYNC_GNSS_TP1, CFG_KEY.TP_USE_LOCKED_TP1,
      CFG_KEY.TP_ALIGN_TO_TOW_TP1, CFG_KEY.TP_POL_TP1, CFG_KEY.TP_TIMEGRID_TP1,
      CFG_KEY.TP_PERIOD_TP1, CFG_KEY.TP_PERIOD_LOCK_TP1,
      CFG_KEY.TP_LEN_TP1, CFG_KEY.TP_LEN_LOCK_TP1,
    ];
  }

  // ── Tool Factory ──────────────────────────────────────────────────────────

  function initUbloxM10ToolInternal({ session, scope, openButton = null, closeButton = null, backdrop = null }) {
    const overlay = scope;

    function qs(...sels) {
      for (const s of sels) { const el = overlay.querySelector(s); if (el) return el; }
      return null;
    }

    // ── State ──────────────────────────────────────────────────────────────

    const m10Config      = {};
    const m10Pending     = new Map();
    const m10Unsupported = new Set(); // Read/Write で NACK だったキー（そのFWで未対応）
    const ubxQueue       = [];
    let   fwVersion      = 'Unknown';
    let   hasFlash       = null;  // null=未確認, true=Flash有, false=Flash無(BBRのみ)

    // Defaults
    for (const s of GNSS_SYSTEMS) { m10Config[s.key] = 1; m10Config[s.sigKey] = 1; }
    m10Config[CFG_KEY.SIGNAL_BDS_B1C_ENA]   = 1;
    m10Config[CFG_KEY.SIGNAL_QZSS_L1S_ENA]  = 1;
    m10Config[CFG_KEY.RATE_MEAS]             = 1000;
    m10Config[CFG_KEY.RATE_NAV]              = 1;
    m10Config[CFG_KEY.UART1_BAUDRATE]        = 9600;
    m10Config[CFG_KEY.UART1INPROT_UBX]       = 1;
    m10Config[CFG_KEY.UART1INPROT_NMEA]      = 1;
    m10Config[CFG_KEY.UART1OUTPROT_UBX]      = 1;
    m10Config[CFG_KEY.UART1OUTPROT_NMEA]     = 1;
    for (const m of NMEA_MESSAGES) m10Config[m.key] = 0;
    m10Config[CFG_KEY.NMEA_PROTVER]          = 0x41;
    m10Config[CFG_KEY.NMEA_MAXSVS]           = 0;
    m10Config[CFG_KEY.NMEA_COMPAT]           = 0;
    m10Config[CFG_KEY.NMEA_CONSIDER]         = 0;
    m10Config[CFG_KEY.NMEA_LIMIT82]          = 0;
    m10Config[CFG_KEY.NMEA_HIGHPREC]         = 0;
    m10Config[CFG_KEY.NMEA_SVNUMBERING]      = 0;
    m10Config[CFG_KEY.NMEA_FILT_GPS]         = 0;
    m10Config[CFG_KEY.NMEA_FILT_SBAS]        = 0;
    m10Config[CFG_KEY.NMEA_FILT_GAL]         = 0;
    m10Config[CFG_KEY.NMEA_FILT_QZSS]        = 0;
    m10Config[CFG_KEY.NMEA_FILT_GLO]         = 0;
    m10Config[CFG_KEY.NMEA_OUT_MSKFIX]       = 0;
    m10Config[CFG_KEY.SBAS_USE_TESTMODE]     = 0;
    m10Config[CFG_KEY.SBAS_USE_RANGING]      = 1;
    m10Config[CFG_KEY.SBAS_USE_DIFFCORR]     = 1;
    m10Config[CFG_KEY.SBAS_USE_INTEGRITY]    = 1;
    m10Config[CFG_KEY.NAVSPG_FIXMODE]        = 3;
    m10Config[CFG_KEY.NAVSPG_INIFIX3D]       = 0;
    m10Config[CFG_KEY.NAVSPG_UTCSTANDARD]    = 0;
    m10Config[CFG_KEY.NAVSPG_DYNMODEL]       = 0;
    m10Config[CFG_KEY.TP_TP1_ENA]            = 0;
    m10Config[CFG_KEY.TP_SYNC_GNSS_TP1]      = 1;
    m10Config[CFG_KEY.TP_USE_LOCKED_TP1]     = 1;
    m10Config[CFG_KEY.TP_ALIGN_TO_TOW_TP1]   = 1;
    m10Config[CFG_KEY.TP_POL_TP1]            = 1;
    m10Config[CFG_KEY.TP_TIMEGRID_TP1]       = 1;
    m10Config[CFG_KEY.TP_PERIOD_TP1]         = 1000000;
    m10Config[CFG_KEY.TP_PERIOD_LOCK_TP1]    = 1000000;
    m10Config[CFG_KEY.TP_LEN_TP1]            = 100000;
    m10Config[CFG_KEY.TP_LEN_LOCK_TP1]       = 100000;

    // ── UI Refs ───────────────────────────────────────────────────────────

    const ui = {
      btnRead:      qs('#m10-btn-read'),
      btnWrite:     qs('#m10-btn-write'),
      btnSaveFlash:   qs('#m10-btn-save-flash'),
      btnSaveBbr:     qs('#m10-btn-save-bbr'),
      wrapSaveFlash:  qs('#m10-wrap-save-flash'),
      wrapSaveBbr:    qs('#m10-wrap-save-bbr'),
      btnReset:     qs('#m10-btn-reset'),
      btnExport:  qs('#m10-btn-export'),
      btnImport:  qs('#m10-btn-import'),
      importFile: qs('#m10-import-file'),
      stConn:     qs('#m10-st-conn'),
      stFw:       qs('#m10-st-fw'),
      stPending:  qs('#m10-st-pending'),
      stStatus:   qs('#m10-st-status'),
      log:        qs('#m10-log'),
      gnssGrid:   qs('#m10-gnss-grid'),
      sbasGrid:   qs('#m10-sbas-grid'),
      nmeaGrid:   qs('#m10-nmea-grid'),
      nmeaProto:  qs('#m10-nmea-proto'),
      rateMeas:   qs('#m10-cfg-rate-meas'),
      rateNav:    qs('#m10-cfg-rate-nav'),
      cfgBaud:    qs('#m10-cfg-baud'),
      inpGrid:    qs('#m10-inprot-grid'),
      outpGrid:   qs('#m10-outprot-grid'),
      navGrid:    qs('#m10-nav-grid'),
      tpGrid:     qs('#m10-tp-grid'),
    };

    // ── Logging ───────────────────────────────────────────────────────────

    function nowStamp() {
      const d = new Date();
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    }

    function appendLog(line, kind = '') {
      if (!ui.log) return;
      const row = document.createElement('div');
      row.className = `log-line${kind ? ` ${kind}` : ''}`;
      row.textContent = line;
      ui.log.appendChild(row);
      while (ui.log.childElementCount > 600) ui.log.removeChild(ui.log.firstElementChild);
      ui.log.scrollTop = ui.log.scrollHeight;
    }

    const logCmd  = (s) => appendLog(`${nowStamp()} >> ${s}`, 'cmd');
    const logResp = (s) => appendLog(`${nowStamp()} << ${s}`, 'resp');
    const logWarn = (s) => appendLog(`${nowStamp()} !! ${s}`, 'warn');
    const logInfo = (s) => appendLog(`${nowStamp()}    ${s}`);

    function setStatus(text, kind = '') {
      if (!ui.stStatus) return;
      ui.stStatus.textContent = text;
      ui.stStatus.className = `status-val ${kind}`.trim();
    }

    function syncConnState() {
      const ok = session.connected;
      if (ui.stConn) {
        ui.stConn.textContent = ok ? 'CONNECTED' : 'DISCONNECTED';
        ui.stConn.className = `status-val ${ok ? 'good' : 'bad'}`;
      }
      [ui.btnRead, ui.btnWrite, ui.btnReset].forEach(b => { if (b) b.disabled = !ok; });
      updateSaveButtons();
    }

    // Save Flash / Save BBR ボタンの有効・無効を型番と接続状態に応じて更新する
    // disabled ボタンは title ツールチップが表示されないため、ラッパー span に移動する
    function updateSaveButtons() {
      const ok = session.connected;

      const setBtn = (btn, wrap, enabled, reason) => {
        if (!btn) return;
        btn.disabled = !enabled;
        // 無効時: ラッパーに title を設定して cursor:not-allowed にする
        // 有効時: ラッパーの title を消す（ボタン自身は title 不要）
        if (wrap) {
          wrap.title = enabled ? '' : reason;
          wrap.classList.toggle('is-disabled', !enabled);
        }
      };

      const flashEnabled = ok && hasFlash !== false;
      const flashReason  = !ok          ? '接続していません'
        : hasFlash === false             ? 'このモジュールはFlashを搭載していません (MAX-M10M 等)。Save BBR を使用してください'
                                         : '';
      setBtn(ui.btnSaveFlash, ui.wrapSaveFlash, flashEnabled, flashReason);

      const bbrReason = !ok ? '接続していません' : '';
      setBtn(ui.btnSaveBbr, ui.wrapSaveBbr, ok, bbrReason);
    }

    function updatePending() {
      if (!ui.stPending) return;
      ui.stPending.textContent = String(m10Pending.size);
      ui.stPending.className = `status-val ${m10Pending.size ? 'warn' : 'good'}`;
    }

    // ── UBX RX ────────────────────────────────────────────────────────────

    const ubxFeed = createUbxParser((cls, id, payload) => {
      const label = `${cls.toString(16).padStart(2,'0').toUpperCase()}-${id.toString(16).padStart(2,'0').toUpperCase()}`;
      logResp(`UBX ${label} [${payload.length}b]`);
      ubxQueue.push({ cls, id, payload: new Uint8Array(payload), t: Date.now() });
      if (ubxQueue.length > 300) ubxQueue.shift();
    });

    session.onBytes((bytes) => ubxFeed(bytes));

    // ── Wait helpers ──────────────────────────────────────────────────────

    async function waitForUbx(pred, ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const idx = ubxQueue.findIndex(e => { try { return pred(e); } catch { return false; } });
        if (idx !== -1) return ubxQueue.splice(idx, 1)[0];
        await new Promise(r => setTimeout(r, 40));
      }
      return null;
    }

    const waitForAck = (ackCls, ackId, ms) =>
      waitForUbx(e => e.cls === 0x05 && (e.id === 0x01 || e.id === 0x00) && e.payload[0] === ackCls && e.payload[1] === ackId, ms);

    // CFG-VALGET レスポンス、または CFG-VALGET に対する NACK のどちらかを待つ
    // NACK が返った場合は e.id === 0x00 で判定できる
    const waitForValGetOrNack = (ms) =>
      waitForUbx(e =>
        (e.cls === 0x06 && e.id === 0x8B) ||
        (e.cls === 0x05 && e.id === 0x00 && e.payload[0] === 0x06 && e.payload[1] === 0x8B),
        ms
      );

    const waitForMonVer = (ms) =>
      waitForUbx(e => e.cls === 0x0A && e.id === 0x04, ms);

    // ── TX ────────────────────────────────────────────────────────────────

    async function sendUbx(pkt, label) {
      const hex = Array.from(pkt).slice(0, 12).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      logCmd(`${label}  [${pkt.length}b] ${hex}…`);
      await session.sendBytes(pkt);
    }

    // ── Parse CFG-VALGET response ─────────────────────────────────────────

    function parseValGetPayload(payload) {
      const result = new Map();
      if (payload.length < 4) return result;
      let off = 4;
      while (off + 4 <= payload.length) {
        const key = ((payload[off]) | (payload[off+1]<<8) | (payload[off+2]<<16) | (payload[off+3]<<24)) >>> 0;
        const sz  = cfgKeyValueSize(key);
        if (!sz || off + 4 + sz > payload.length) break;
        result.set(key, decodeValue(payload, off + 4, key));
        off += 4 + sz;
      }
      return result;
    }

    function parseMonVer(payload) {
      if (payload.length < 40) return 'Unknown';
      const dec = new TextDecoder();
      const sw = dec.decode(payload.slice(0, 30)).replace(/\0.*/g, '').trim();
      const hw = dec.decode(payload.slice(30, 40)).replace(/\0.*/g, '').trim();
      let ext = '';
      for (let off = 40; off + 30 <= payload.length; off += 30) {
        const s = dec.decode(payload.slice(off, off + 30)).replace(/\0.*/g, '').trim();
        if (s) ext += (ext ? ' | ' : '') + s;
      }
      return `SW:${sw} HW:${hw}${ext ? ' | '+ext : ''}`;
    }

    // MON-VER の拡張フィールドから MOD= を読み取り Flash 対応を判定する
    // MAX-M10S → Flash あり / MAX-M10M → Flash なし (BBR のみ)
    function detectFlashFromMonVer(payload) {
      if (payload.length < 40) return null;
      const dec = new TextDecoder();
      for (let off = 40; off + 30 <= payload.length; off += 30) {
        const s = dec.decode(payload.slice(off, off + 30)).replace(/\0.*/g, '').trim();
        if (!s.startsWith('MOD=')) continue;
        const mod = s.slice(4).toUpperCase();
        // MAX-M10M / NEO-M10M 等 "M10M" を含む → Flash なし
        if (mod.includes('M10M')) return false;
        // MAX-M10S / NEO-M10S 等 "M10S" を含む → Flash あり
        if (mod.includes('M10S')) return true;
        // その他の型番は不明として null を返す
        return null;
      }
      return null; // MOD= フィールドが見つからない
    }


    // ── Render helpers ────────────────────────────────────────────────────

    function makeCheckboxItem(key, labelText, descText = '') {
      const val     = !!m10Config[key];
      const pending = m10Pending.has(key);
      const item    = document.createElement('div');
      item.className = `item${pending ? ' pending' : ''}`;
      item.innerHTML = `
        <div class="label">
          ${labelText}${descText ? `<br><small>${descText}</small>` : ''}
        </div>
        <label class="toggle-btn">
          <input type="checkbox" data-cfg-key="${key}" ${val ? 'checked' : ''}/>On
        </label>
      `;
      return item;
    }

    function makeSelectItem(key, labelText, options) {
      const val     = m10Config[key];
      const pending = m10Pending.has(key);
      const item    = document.createElement('div');
      item.className = `item${pending ? ' pending' : ''}`;
      let opts = options.map(o => `<option value="${o.value}" ${o.value == val ? 'selected' : ''}>${o.label}</option>`).join('');
      item.innerHTML = `
        <div class="label">${labelText}</div>
        <select data-cfg-key="${key}">${opts}</select>
      `;
      return item;
    }

    function makeNumberItem(key, labelText, unit, min, max, step) {
      const val     = m10Config[key] ?? 0;
      const pending = m10Pending.has(key);
      const item    = document.createElement('div');
      item.className = `item${pending ? ' pending' : ''}`;
      item.innerHTML = `
        <div class="label">${labelText}<br><small>${unit}</small></div>
        <input type="number" data-cfg-key="${key}" value="${val}" min="${min}" max="${max}" step="${step}" style="width:110px;text-align:right;background:var(--t-bg);border:1px solid var(--t-border);color:var(--t-text);padding:2px 6px;border-radius:4px;font-family:var(--t-font);font-size:12px;">
      `;
      return item;
    }

    // ── Render sections ───────────────────────────────────────────────────

    function renderGnss() {
      if (!ui.gnssGrid) return;
      ui.gnssGrid.innerHTML = '';

      for (const sys of GNSS_SYSTEMS) {
        const sysItem = document.createElement('div');
        sysItem.className = `item gnss-sys-item${m10Pending.has(sys.key) ? ' pending' : ''}`;
        const sysEna = !!m10Config[sys.key];
        const sigEna = !!m10Config[sys.sigKey];
        sysItem.innerHTML = `
          <div class="label">
            <div class="label-title"><span class="name">${sys.name}</span></div>
            <small>System / ${sys.sigLabel} signal</small>
          </div>
          <div class="toggle-group">
            <label class="toggle-btn">
              <input type="checkbox" data-cfg-key="${sys.key}" ${sysEna ? 'checked' : ''}/>System
            </label>
            <label class="toggle-btn">
              <input type="checkbox" data-cfg-key="${sys.sigKey}" ${sigEna ? 'checked' : ''}/>Signal
            </label>
          </div>
        `;
        ui.gnssGrid.appendChild(sysItem);
      }

      // Extra BeiDou B1C
      const bdsB1C = makeCheckboxItem(CFG_KEY.SIGNAL_BDS_B1C_ENA, 'BeiDou B1C', '追加信号');
      ui.gnssGrid.appendChild(bdsB1C);

      // Extra QZSS L1S
      const qzssL1S = makeCheckboxItem(CFG_KEY.SIGNAL_QZSS_L1S_ENA, 'QZSS L1S (SLAS)', '追加信号');
      ui.gnssGrid.appendChild(qzssL1S);
    }

    function renderSbas() {
      if (!ui.sbasGrid) return;
      ui.sbasGrid.innerHTML = '';
      const items = [
        [CFG_KEY.SBAS_USE_TESTMODE, 'Test Mode 衛星を使用',     '通常は運用中でないテスト用SBAS衛星も補正に使用する（通常はOFF）'],
        [CFG_KEY.SBAS_USE_RANGING,  'SBAS 測距補正',            'SBAS衛星を追加の測距ソースとして使い測位精度を向上させる'],
        [CFG_KEY.SBAS_USE_DIFFCORR, 'SBAS 差分補正 (DGPS)',     'SBASの誤差補正データを適用してDGPS相当の精度を得る'],
        [CFG_KEY.SBAS_USE_INTEGRITY,'SBAS インテグリティ',      'SBAS が異常と判定した衛星を自動的に除外し信頼性を高める'],
      ];
      for (const [key, label, desc] of items) {
        ui.sbasGrid.appendChild(makeCheckboxItem(key, label, desc));
      }
    }

    function renderNmea() {
      if (!ui.nmeaGrid) return;
      ui.nmeaGrid.innerHTML = '';

      // Output messages
      for (const msg of NMEA_MESSAGES) {
        const rate    = m10Config[msg.key] || 0;
        const pending = m10Pending.has(msg.key);
        const item    = document.createElement('div');
        item.className = `item${pending ? ' pending' : ''}`;
        item.innerHTML = `
          <div class="label">
            <div class="label-title">
              <span class="name">${msg.name}</span>
              <span class="desc">${msg.desc}</span>
            </div>
          </div>
          <label class="toggle-btn">
            <input type="checkbox" data-cfg-key="${msg.key}" ${rate > 0 ? 'checked' : ''}/>On
          </label>
        `;
        ui.nmeaGrid.appendChild(item);
      }

      if (!ui.nmeaProto) return;
      ui.nmeaProto.innerHTML = '';

      ui.nmeaProto.appendChild(makeSelectItem(CFG_KEY.NMEA_PROTVER,    'NMEAプロトコルバージョン', NMEA_PROTVER_OPTIONS));
      ui.nmeaProto.appendChild(makeSelectItem(CFG_KEY.NMEA_SVNUMBERING,'衛星番号体系 (SV Numbering)',
        [{ value: 0, label: 'Strict — NMEA標準の番号のみ' }, { value: 1, label: 'Extended — u-blox拡張番号も使用' }]));

      const boolItems = [
        [CFG_KEY.NMEA_HIGHPREC,   'High Precision',  '座標の小数桁を増やし高精度な出力にする（GGA緯度経度が7桁→9桁）'],
        [CFG_KEY.NMEA_COMPAT,     'Compatibility Mode', '古いNMEAパーサーとの互換性を確保（フィールド数を旧仕様に合わせる）'],
        [CFG_KEY.NMEA_CONSIDER,   'Consider Mode',   '受信できていないシステムも測位計算の候補として考慮する'],
        [CFG_KEY.NMEA_LIMIT82,    'Limit to 82 Chars', 'NMEAセンテンスを82文字以内に切り詰める（古い機器との互換性）'],
        [CFG_KEY.NMEA_OUT_MSKFIX, 'Output Masked Fix', '仰角マスクで除外された衛星を含む測位結果も出力する'],
      ];
      for (const [key, label, desc] of boolItems) {
        ui.nmeaProto.appendChild(makeCheckboxItem(key, label, desc));
      }

      // NMEA constellation output filters
      // ONにすると、そのコンステレーションがGSV/GSAなどから除外される（非表示になる）
      const sep = document.createElement('div');
      sep.style.cssText = 'grid-column:1/-1; padding:6px 0 2px; color:var(--t-muted); font-size:11px; border-top:1px solid var(--t-border); margin-top:4px;';
      sep.textContent = 'NMEA出力から除外するコンステレーション（ONにすると GSV・GSA などに表示されなくなります）';
      ui.nmeaProto.appendChild(sep);

      const filterItems = [
        [CFG_KEY.NMEA_FILT_GPS,  'GPS を非表示',     'ONにするとGPS衛星がGSV/GSAなどのNMEA出力から除外される'],
        [CFG_KEY.NMEA_FILT_SBAS, 'SBAS を非表示',    'ONにするとSBAS衛星がNMEA出力から除外される'],
        [CFG_KEY.NMEA_FILT_GAL,  'Galileo を非表示', 'ONにするとGalileo衛星がNMEA出力から除外される'],
        [CFG_KEY.NMEA_FILT_QZSS, 'QZSS を非表示',    'ONにするとQZSS衛星がNMEA出力から除外される'],
        [CFG_KEY.NMEA_FILT_GLO,  'GLONASS を非表示', 'ONにするとGLONASS衛星がNMEA出力から除外される'],
      ];
      for (const [key, label, desc] of filterItems) {
        ui.nmeaProto.appendChild(makeCheckboxItem(key, label, desc));
      }
    }

    function renderRate() {
      if (ui.rateMeas) {
        ui.rateMeas.setAttribute('data-cfg-key', CFG_KEY.RATE_MEAS);
        ui.rateMeas.closest('.item')?.classList.toggle('pending', m10Pending.has(CFG_KEY.RATE_MEAS));
        ui.rateMeas.innerHTML = '';
        for (const ms of MEAS_RATES_MS) {
          const opt = document.createElement('option');
          opt.value = String(ms);
          opt.textContent = ms < 1000 ? `${ms} ms  (${(1000/ms).toFixed(0)} Hz)` : `${ms/1000} s  (${(1000/ms).toFixed(1)} Hz)`;
          if (ms === m10Config[CFG_KEY.RATE_MEAS]) opt.selected = true;
          ui.rateMeas.appendChild(opt);
        }
      }

      if (ui.rateNav) {
        ui.rateNav.setAttribute('data-cfg-key', CFG_KEY.RATE_NAV);
        ui.rateNav.closest('.item')?.classList.toggle('pending', m10Pending.has(CFG_KEY.RATE_NAV));
        ui.rateNav.innerHTML = '';
        for (const r of NAV_RATES) {
          const opt = document.createElement('option');
          opt.value = String(r);
          opt.textContent = `${r} (1 nav per ${r} meas)`;
          if (r === m10Config[CFG_KEY.RATE_NAV]) opt.selected = true;
          ui.rateNav.appendChild(opt);
        }
      }

      if (ui.cfgBaud) {
        ui.cfgBaud.setAttribute('data-cfg-key', CFG_KEY.UART1_BAUDRATE);
        ui.cfgBaud.closest('.item')?.classList.toggle('pending', m10Pending.has(CFG_KEY.UART1_BAUDRATE));
        ui.cfgBaud.innerHTML = '';
        for (const br of BAUDRATE_LIST) {
          const opt = document.createElement('option');
          opt.value = String(br);
          opt.textContent = `${br} baud`;
          if (br === m10Config[CFG_KEY.UART1_BAUDRATE]) opt.selected = true;
          ui.cfgBaud.appendChild(opt);
        }
      }

      if (ui.inpGrid) {
        ui.inpGrid.innerHTML = '';
        ui.inpGrid.appendChild(makeCheckboxItem(CFG_KEY.UART1INPROT_UBX,  'UBX バイナリ受信',  'このツールからの設定コマンドに必要。通常はON'));
        ui.inpGrid.appendChild(makeCheckboxItem(CFG_KEY.UART1INPROT_NMEA, 'NMEA テキスト受信', '外部からNMEAコマンドを送る場合にON'));
      }

      if (ui.outpGrid) {
        ui.outpGrid.innerHTML = '';
        ui.outpGrid.appendChild(makeCheckboxItem(CFG_KEY.UART1OUTPROT_UBX,  'UBX バイナリ出力',  'UBX形式のデータをUART1へ出力する'));
        ui.outpGrid.appendChild(makeCheckboxItem(CFG_KEY.UART1OUTPROT_NMEA, 'NMEA テキスト出力', 'NMEAセンテンスをUART1へ出力する。通常はON'));
      }
    }

    function renderNav() {
      if (!ui.navGrid) return;
      ui.navGrid.innerHTML = '';
      ui.navGrid.appendChild(makeSelectItem(CFG_KEY.NAVSPG_DYNMODEL,    'Dynamic Model（動的モデル）', DYNMODEL_OPTIONS));
      ui.navGrid.appendChild(makeSelectItem(CFG_KEY.NAVSPG_FIXMODE,     'Fix Mode（測位モード）',      FIXMODE_OPTIONS));
      ui.navGrid.appendChild(makeSelectItem(CFG_KEY.NAVSPG_UTCSTANDARD, 'UTC Standard',               UTCSTANDARD_OPTIONS));
      ui.navGrid.appendChild(makeCheckboxItem(CFG_KEY.NAVSPG_INIFIX3D,  '初回 Fix を 3D に限定', '最初の測位を必ず3D（衛星4個以上）にする。2D測位での誤った初回Fixを防ぐ'));
    }

    function renderTp() {
      if (!ui.tpGrid) return;
      ui.tpGrid.innerHTML = '';
      ui.tpGrid.appendChild(makeCheckboxItem(CFG_KEY.TP_TP1_ENA,           'TP1 出力を有効化',           'タイムパルス（PPS）ピンへの出力をONにする'));
      ui.tpGrid.appendChild(makeCheckboxItem(CFG_KEY.TP_SYNC_GNSS_TP1,      'GNSS 時刻に同期',            'タイムパルスをGNSS時刻に合わせる（OFFにすると内部発振器基準）'));
      ui.tpGrid.appendChild(makeCheckboxItem(CFG_KEY.TP_USE_LOCKED_TP1,     '測位中は Locked パラメータを使用', 'FIX取得後に Period/Length の別セット（Locked欄）に切り替える'));
      ui.tpGrid.appendChild(makeCheckboxItem(CFG_KEY.TP_ALIGN_TO_TOW_TP1,   'GPS 週境界に整列',           'パルスのタイミングをGPS週始め（TOW=0）に揃える'));
      ui.tpGrid.appendChild(makeCheckboxItem(CFG_KEY.TP_POL_TP1,            '立ち上がりエッジをアクティブにする', 'ON=パルス開始が立上り / OFF=パルス開始が立下り'));
      ui.tpGrid.appendChild(makeSelectItem(CFG_KEY.TP_TIMEGRID_TP1,         '時刻グリッド（時刻系の基準）',  TP_TIMEGRID_OPTIONS));
      ui.tpGrid.appendChild(makeNumberItem(CFG_KEY.TP_PERIOD_TP1,           'パルス周期（未測位時）',        'μs　例: 1秒=1,000,000', 1, 4294967295, 1000));
      ui.tpGrid.appendChild(makeNumberItem(CFG_KEY.TP_PERIOD_LOCK_TP1,      'パルス周期（測位中）',         'μs', 1, 4294967295, 1000));
      ui.tpGrid.appendChild(makeNumberItem(CFG_KEY.TP_LEN_TP1,              'パルス幅（未測位時）',          'μs', 0, 4294967295, 1000));
      ui.tpGrid.appendChild(makeNumberItem(CFG_KEY.TP_LEN_LOCK_TP1,         'パルス幅（測位中）',           'μs', 0, 4294967295, 1000));
      // キャンバスが既に表示中なら即時描画（非表示時は setupTabs 側で描画）
      requestAnimationFrame(renderTpChart);
    }

    function renderTpChart() {
      const canvas = overlay.querySelector('#m10-tp-chart');
      if (!canvas) return;
      const W = canvas.clientWidth;
      if (W < 60) return;  // 非表示またはレイアウト前

      const H = 220;
      canvas.width  = W;
      canvas.height = H;

      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, W, H);

      const enabled  = !!m10Config[CFG_KEY.TP_TP1_ENA];
      const polarity = !!m10Config[CFG_KEY.TP_POL_TP1]; // true=立ち上がり起点

      const clampUs = (v) => Math.max(1, (v >>> 0) || 1);
      const periodNF = clampUs(m10Config[CFG_KEY.TP_PERIOD_TP1]);
      const lenNF    = Math.max(0, (m10Config[CFG_KEY.TP_LEN_TP1] >>> 0) || 0);
      const periodL  = clampUs(m10Config[CFG_KEY.TP_PERIOD_LOCK_TP1]);
      const lenL     = Math.max(0, (m10Config[CFG_KEY.TP_LEN_LOCK_TP1] >>> 0) || 0);

      function fmtUs(us) {
        if (us >= 1e6) return `${(us / 1e6).toFixed(3).replace(/\.?0+$/, '')}s`;
        if (us >= 1e3) return `${(us / 1e3).toFixed(2).replace(/\.?0+$/, '')}ms`;
        return `${us}µs`;
      }

      function drawArrow(x1, x2, ay, label, lineClr, txtClr) {
        ctx.strokeStyle = lineClr;
        ctx.fillStyle   = txtClr;
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(x1 + 5, ay);
        ctx.lineTo(x2 - 5, ay);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, ay); ctx.lineTo(x1+6, ay-3); ctx.lineTo(x1+6, ay+3); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x2, ay); ctx.lineTo(x2-6, ay-3); ctx.lineTo(x2-6, ay+3); ctx.closePath(); ctx.fill();
        ctx.textAlign = 'center';
        ctx.font = '9px monospace';
        ctx.fillStyle = txtClr;
        ctx.fillText(label, (x1 + x2) / 2, ay - 3);
      }

      const LPAD   = 150;
      const CX     = LPAD;
      const CW     = W - LPAD - 8;
      const CYCLES = 2.4;

      const rows = [
        { y: 20,  label: '未測位時', sub: '(No Fix)', period: periodNF, len: lenNF, color: '#d4a820' },
        { y: 120, label: '測位中',   sub: '(Locked)', period: periodL,  len: lenL,  color: '#28b050' },
      ];

      rows.forEach(row => {
        const wy1 = row.y + 8;
        const wy2 = wy1 + 30;

        const rawDuty = row.period > 0 ? Math.min(1, row.len / row.period) : 0;
        let visDuty = rawDuty;
        let notToScale = false;
        if (rawDuty > 0 && rawDuty < 0.05)  { visDuty = 0.05; notToScale = true; }
        else if (rawDuty > 0.95)             { visDuty = 0.95; notToScale = true; }

        const cw = CW / CYCLES;
        const pw = visDuty * cw;
        const gw = cw - pw;

        // 立ち上がり起点: アクティブ=HIGH, アイドル=LOW
        const yIdle   = polarity ? wy2 - 2 : wy1 + 2;
        const yActive = polarity ? wy1 + 2 : wy2 - 2;

        // 波形背景
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(CX, wy1 - 2, CW, 34);

        // 波形描画（パルス→ギャップ→… を繰り返す）
        ctx.strokeStyle = enabled ? row.color : '#3a3a3a';
        ctx.lineWidth   = 2;
        ctx.lineJoin    = 'miter';
        ctx.beginPath();
        let x = CX;
        ctx.moveTo(x, yActive);
        let rem = CW;
        while (rem > 0.5) {
          const pw2 = Math.min(pw, rem); ctx.lineTo(x + pw2, yActive); x += pw2; rem -= pw2;
          if (rem < 0.5) break;
          ctx.lineTo(x, yIdle);
          const gw2 = Math.min(gw, rem); ctx.lineTo(x + gw2, yIdle);  x += gw2; rem -= gw2;
          if (rem < 0.5) break;
          ctx.lineTo(x, yActive);
        }
        ctx.stroke();

        // 周期アノテーション（下矢印）
        drawArrow(CX, CX + cw, wy2 + 14, 'T', '#3a3a3a', '#666');

        // パルス幅アノテーション（上矢印）
        if (pw > 14) drawArrow(CX, CX + pw, wy1 - 6, 'W', '#3a3a3a', '#666');

        // 左ラベル
        ctx.textAlign = 'left';
        ctx.fillStyle = enabled ? row.color : '#444';
        ctx.font = 'bold 11px monospace';
        ctx.fillText(row.label, 5, row.y + 14);
        ctx.fillStyle = '#555';
        ctx.font = '10px monospace';
        ctx.fillText(row.sub,                     5, row.y + 25);
        ctx.fillText(`T: ${fmtUs(row.period)}`,   5, row.y + 38);
        ctx.fillText(`W: ${fmtUs(row.len)}`,      5, row.y + 50);
        ctx.fillText(`Duty: ${(rawDuty * 100).toFixed(1)}%`, 5, row.y + 62);
        if (notToScale) {
          ctx.fillStyle = '#906020';
          ctx.font = '9px monospace';
          ctx.fillText('※縮尺省略', 5, row.y + 74);
        }
      });

      // 極性ラベル
      const polTxt = polarity ? '↑ Rising edge active（立ち上がり起点）' : '↓ Falling edge active（立ち下がり起点）';
      ctx.fillStyle = '#555';
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(polTxt, W - 5, H - 5);

      // TP1無効時オーバーレイ
      if (!enabled) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(CX, 0, CW, H);
        ctx.fillStyle = '#555';
        ctx.font = '13px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('TP1 無効 (Disabled)', CX + CW / 2, H / 2);
      }
    }

    function renderAll() {
      renderGnss();
      renderSbas();
      renderNmea();
      renderRate();
      renderNav();
      renderTp();
      updatePending();
      if (ui.stFw) ui.stFw.textContent = fwVersion;
    }

    // ── Read ──────────────────────────────────────────────────────────────

    async function readConfig() {
      if (!session.connected) { setStatus('Not connected', 'bad'); return; }
      setStatus('Reading...', 'warn');
      ubxQueue.length = 0;

      try {
        await sendUbx(buildMonVer(), 'MON-VER');
        const r = await waitForMonVer(2000);
        if (r) {
          fwVersion = parseMonVer(r.payload);
          logInfo(`FW: ${fwVersion}`);
          const detected = detectFlashFromMonVer(r.payload);
          if (detected !== null) {
            hasFlash = detected;
            logInfo(`Module: ${detected ? 'Flash 搭載 → Save Flash が使用可能' : 'Flash 非搭載 (MAX-M10M 等) → BBR モードで保存します'}`);
          } else {
            logInfo('Module: Flash 対応不明 — 初回 Save 時に自動判定します');
          }
          updateSaveButtons();
        }
      } catch { /* ignore */ }

      const keys = allConfigKeys();
      const BATCH = 16;
      let okCount = 0;
      m10Unsupported.clear(); // 毎回リセットして再検出

      // 1キーずつ読み取るフォールバック関数
      async function readKeysOneByOne(keyList) {
        for (const key of keyList) {
          const hexKey = `0x${(key >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
          await sendUbx(buildValGet([key]), `CFG-VALGET ${hexKey} (fallback)`);
          const r = await waitForValGetOrNack(1500);
          if (!r) {
            logWarn(`  ${hexKey}: timeout (not supported?)`);
            m10Unsupported.add(key);
          } else if (r.cls === 0x05) {
            logWarn(`  ${hexKey}: NACK (key not supported by this firmware)`);
            m10Unsupported.add(key);
          } else {
            const parsed = parseValGetPayload(r.payload);
            for (const [k, v] of parsed) { m10Config[k] = v; okCount++; }
          }
          await new Promise(res => setTimeout(res, 20));
        }
      }

      for (let i = 0; i < keys.length; i += BATCH) {
        const batch = keys.slice(i, i + BATCH);
        const bn = `batch ${Math.floor(i/BATCH)+1}/${Math.ceil(keys.length/BATCH)}`;
        setStatus(`Reading config (${bn})...`, 'warn');

        await sendUbx(buildValGet(batch), `CFG-VALGET ${bn}`);
        const got = await waitForValGetOrNack(2000);

        if (got && got.cls === 0x06) {
          const parsed = parseValGetPayload(got.payload);
          for (const [key, value] of parsed) { m10Config[key] = value; okCount++; }
        } else {
          if (got && got.cls === 0x05) {
            logWarn(`${bn}: NACK — バッチ内に未対応キーがあります。1キーずつ再試行します...`);
          } else {
            logWarn(`${bn}: タイムアウト — 1キーずつ再試行します...`);
          }
          setStatus(`Reading (${bn} fallback)...`, 'warn');
          await readKeysOneByOne(batch);
        }
      }

      if (m10Unsupported.size > 0) {
        logInfo(`未対応キー ${m10Unsupported.size} 件を検出（Save Flash 時は自動スキップされます）`);
      }

      m10Pending.clear();
      renderAll();
      setStatus(`Config read OK (${okCount} items, ${m10Unsupported.size} unsupported)`, okCount > 0 ? 'good' : 'warn');
    }

    // ── Write ─────────────────────────────────────────────────────────────

    async function writeConfig() {
      if (!session.connected) { setStatus('Not connected', 'bad'); return; }
      if (!m10Pending.size) { setStatus('No pending changes', 'warn'); return; }

      setStatus('Writing to RAM...', 'warn');
      // 未対応キーは書き込みをスキップ
      const kvPairs = Array.from(m10Pending.entries()).filter(([k]) => !m10Unsupported.has(k));
      const skipped = m10Pending.size - kvPairs.length;
      if (skipped > 0) logInfo(`未対応キー ${skipped} 件をスキップします`);
      if (!kvPairs.length) { m10Pending.clear(); renderAll(); setStatus('No writable changes', 'warn'); return; }

      const BATCH = 8;
      let errors = 0;

      for (let i = 0; i < kvPairs.length; i += BATCH) {
        const batch = kvPairs.slice(i, i + BATCH);
        await sendUbx(buildValSet(batch, 0x01), `CFG-VALSET RAM batch ${Math.floor(i/BATCH)+1}`);
        const ack = await waitForAck(0x06, 0x8A, 2500);
        if (!ack)               { logWarn('Timeout waiting ACK'); errors++; }
        else if (ack.id === 0x00) { logWarn('NACK received'); errors++; }
        else                    logInfo('ACK OK');
        await new Promise(r => setTimeout(r, 50));
      }

      m10Pending.clear();
      renderAll();
      if (errors) setStatus(`Write done with ${errors} error(s)`, 'bad');
      else setStatus('Changes written to RAM', 'good');
    }

    // ── 共通: 設定キーをバッチ送信して永続化 ─────────────────────────────

    async function savePersistent(layerByte, layerName) {
      if (!session.connected) { setStatus('Not connected', 'bad'); return; }
      setStatus(`Saving to ${layerName}...`, 'warn');

      const kvPairs = allConfigKeys()
        .filter(k => m10Config[k] !== undefined && !m10Unsupported.has(k))
        .map(k => [k, m10Config[k]]);

      if (m10Unsupported.size > 0) {
        logInfo(`未対応キー ${m10Unsupported.size} 件をスキップします（Read で NACK 確認済み）`);
      }

      const BATCH = 8;
      let errors = 0;

      for (let i = 0; i < kvPairs.length; i += BATCH) {
        const batch = kvPairs.slice(i, i + BATCH);
        const bn    = `batch ${Math.floor(i/BATCH)+1}/${Math.ceil(kvPairs.length/BATCH)}`;
        setStatus(`Saving to ${layerName} (${bn})...`, 'warn');

        await sendUbx(buildValSet(batch, layerByte), `CFG-VALSET ${layerName} ${bn}`);
        const ack = await waitForAck(0x06, 0x8A, 3000);

        if (!ack)               { logWarn(`${bn}: タイムアウト`); errors++; }
        else if (ack.id === 0x00) { logWarn(`${bn}: NACK`);       errors++; }
        else                    { logInfo(`${bn}: ACK OK`); }
        await new Promise(r => setTimeout(r, 80));
      }

      if (errors) setStatus(`Save ${layerName} failed (${errors} error(s))`, 'bad');
      else        setStatus(`Config saved to ${layerName}`, 'good');
    }

    // ── Save Flash (layer = RAM+Flash = 0x05) ─────────────────────────────
    async function saveFlash() { await savePersistent(0x05, 'Flash'); }

    // ── Save BBR (layer = RAM+BBR = 0x03) ────────────────────────────────
    async function saveBbr()   { await savePersistent(0x03, 'BBR'); }

    // ── Reset ─────────────────────────────────────────────────────────────

    async function resetDevice() {
      if (!session.connected) { setStatus('Not connected', 'bad'); return; }
      await sendUbx(buildSoftReset(), 'CFG-RST (soft)');
      setStatus('Soft reset sent', 'warn');
    }

    // ── Export / Import ───────────────────────────────────────────────────

    function exportConfig() {
      const data = { fwVersion, config: {} };
      for (const k of allConfigKeys()) {
        if (m10Config[k] !== undefined) data.config[`0x${(k >>> 0).toString(16).toUpperCase()}`] = m10Config[k];
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `ublox-m10-config-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus('エクスポートしました', 'good');
    }

    function importConfig(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          let count = 0;
          for (const [hexKey, value] of Object.entries(data.config || {})) {
            const key = parseInt(hexKey, 16);
            if (!isNaN(key) && typeof value === 'number') {
              m10Config[key] = value;
              m10Pending.set(key, value);
              count++;
            }
          }
          renderAll();
          setStatus(`インポート完了 (${count}件 pending)`, 'good');
        } catch {
          setStatus('JSONの読み込みに失敗しました', 'bad');
        }
      };
      reader.readAsText(file);
    }

    // ── Event Handlers ────────────────────────────────────────────────────

    function handleCfgChange(e) {
      const input  = e.target;
      const keyStr = input.getAttribute('data-cfg-key');
      if (!keyStr) return;
      const key = parseInt(keyStr);
      let   val;
      if (input.type === 'checkbox') val = input.checked ? 1 : 0;
      else if (input.tagName === 'SELECT') val = Number(input.value);
      else if (input.type === 'number')    val = Number(input.value) >>> 0;
      else return;
      m10Config[key] = val;
      m10Pending.set(key, val);
      updatePending();
      // Re-render the item border for pending state
      const item = input.closest('.item');
      if (item) item.classList.add('pending');
      // TP関連キー変更時はチャートをリアルタイム再描画
      if (((key >>> 16) & 0x0FFF) === 0x0005) renderTpChart();
    }

    function setupHandlers() {
      ui.btnRead?.addEventListener('click',      readConfig);
      ui.btnWrite?.addEventListener('click',     writeConfig);
      ui.btnSaveFlash?.addEventListener('click', saveFlash);
      ui.btnSaveBbr?.addEventListener('click',   saveBbr);
      ui.btnReset?.addEventListener('click',     resetDevice);
      ui.btnExport?.addEventListener('click', exportConfig);
      ui.btnImport?.addEventListener('click', () => ui.importFile?.click());
      ui.importFile?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) { importConfig(file); e.target.value = ''; }
      });

      // Delegate all cfg-key changes from the whole body of the overlay
      const body = overlay.querySelector('.m10-body');
      body?.addEventListener('change',  handleCfgChange);
      body?.addEventListener('input',   handleCfgChange);

      session.onState(() => syncConnState());
    }

    function setupTabs() {
      const buttons  = Array.from(overlay.querySelectorAll('.m10-tab-btn'));
      const sections = Array.from(overlay.querySelectorAll('#m10-main > section[id^="m10-tab-"]'));
      if (!buttons.length) return;

      // A tab can own multiple sections (e.g. "rate" owns "m10-tab-rate", "m10-tab-rate-extra", ...)
      const activate = (target) => {
        buttons.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === target));
        sections.forEach(s => {
          const secId = s.id; // e.g. "m10-tab-rate" or "m10-tab-rate-extra"
          // Show section if it starts with "m10-tab-{target}" (exact or with suffix)
          const belongs = secId === `m10-tab-${target}` || secId.startsWith(`m10-tab-${target}-`);
          s.classList.toggle('hidden', !belongs);
        });
      };

      const initial = buttons.find(b => b.classList.contains('active'))?.getAttribute('data-tab') || 'gnss';
      activate(initial);
      buttons.forEach(btn => btn.addEventListener('click', () => {
        const t = btn.getAttribute('data-tab');
        if (t) {
          activate(t);
          // TPタブ表示後にチャートを描画（hidden解除後にclientWidthが確定するのを待つ）
          if (t === 'tp') requestAnimationFrame(renderTpChart);
        }
      }));
    }

    // ── Overlay open/close ────────────────────────────────────────────────

    const openOverlay = () => {
      overlay.classList.add('visible');
      overlay.setAttribute('aria-hidden', 'false');
      syncConnState();
    };

    const closeOverlay = () => {
      overlay.classList.remove('visible');
      overlay.setAttribute('aria-hidden', 'true');
    };

    openButton?.addEventListener('click',  openOverlay);
    closeButton?.addEventListener('click', closeOverlay);
    backdrop?.addEventListener('click',    closeOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('visible')) closeOverlay();
    });

    // ── Init ──────────────────────────────────────────────────────────────
    setupTabs();
    setupHandlers();
    renderAll();
    syncConnState();
  }

  // ── Public Entry Point ────────────────────────────────────────────────────

  function initUbloxM10Tool({ session, overlayId = 'ublox-overlay', openButtonId = 'btn-m10' }) {
    if (!session) throw new Error('initUbloxM10Tool: session is required');
    const overlay = document.getElementById(overlayId);
    if (!overlay) throw new Error(`initUbloxM10Tool: #${overlayId} not found`);
    if (overlay.dataset.m10ToolInit === '1') return;
    overlay.dataset.m10ToolInit = '1';

    const openButton  = document.getElementById(openButtonId);
    const closeButton = overlay.querySelector('#m10-btn-close');
    const backdrop    = overlay.querySelector('#m10-backdrop');
    if (!openButton) throw new Error(`initUbloxM10Tool: #${openButtonId} not found`);

    initUbloxM10ToolInternal({ session, scope: overlay, openButton, closeButton, backdrop });
  }

  global.initUbloxM10Tool = initUbloxM10Tool;

})(window);
