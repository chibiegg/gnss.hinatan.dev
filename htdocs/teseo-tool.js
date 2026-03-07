'use strict';

// Teseo-LIV3FL configuration tool
// - Uses a shared SerialSession (single connection + single read loop)
// - Supports overlay mode (integrated viewer) and standalone page

(function initTeseoToolFactory(global) {
  function initTeseoToolInternal({ session, scope, mode, openButton = null, closeButton = null, backdrop = null }) {
    if (!session) throw new Error('initTeseoTool: session is required');
    if (!scope) throw new Error('initTeseoTool: scope is required');

    const isOverlayMode = mode === 'overlay';
    const overlay = scope;

    function qs(...selectors) {
      for (const sel of selectors) {
        const el = overlay.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    const BAUDRATE_TABLE = {
      0x0: 300, 0x1: 600, 0x2: 1200, 0x3: 2400,
      0x4: 4800, 0x5: 9600, 0x6: 14400, 0x7: 19200,
      0x8: 38400, 0x9: 57600, 0xA: 115200, 0xB: 230400,
      0xC: 460800, 0xD: 921600,
    };

    const BAUDRATE_REVERSE = Object.fromEntries(Object.entries(BAUDRATE_TABLE).map(([k, v]) => [v, Number(k)]));
    const BAUDRATE_LIST = Object.values(BAUDRATE_TABLE);

    const SBAS_SERVICES = {
      0: 'WAAS', 1: 'EGNOS', 2: 'MSAS', 3: 'GAGAN', 4: 'SDCM', 7: 'OFF', 15: 'AUTO',
    };

    const SBAS_SERVICE_KEYS = Object.keys(SBAS_SERVICES).map(Number);

    // NOTE: tables copied from standalone Teseo tool.
    const CDB200_BITS = {
      2: ['SBAS Engine', 'SBAS補強信号を利用し測位精度を向上。', 'SBAS衛星を検索し、補正データを適用します。DGPS相当の精度向上が可能。航空用途や高精度用途で有効。'],
      3: ['SBAS in GSV', 'GSVにSBAS衛星情報を出力。', 'GSVセンテンスにSBAS衛星を含め、補強衛星の受信状況を可視化します。'],
      4: ['STAGPS', '予測エフェメリスを利用しTTFFを短縮。', 'サーバベース予測軌道データを使用。最大約5日間有効な予測データによりCold Start時間短縮。CPU負荷増加のため高クロック推奨。'],
      5: ['2.5ppm TCXO', '2.5ppm精度TCXO向けサポートを有効化。', '高精度TCXO前提でNCO探索レンジを最適化。探索幅縮小により捕捉時間短縮。周波数誤差低減で低C/N0環境の捕捉成功率向上。TCXO精度と設定不一致の場合は性能低下の可能性。'],
      7: ['QZSS Distrib.Acq.', 'QZSS捕捉処理を分散し電流ピークを低減。', '捕捉処理を時間分散化し電流スパイクを緩和。平均電力は同等だがピーク電流を低減。バッテリー設計向け。'],
      11: ['RTCM', 'RTCM補正データ処理を有効化。', 'RTCM標準フォーマットの補正データを受信処理。DGPS/RTK用途向け。'],
      12: ['FDE Algorithm', '異常衛星を自動除外し測位信頼性向上。', '疑わしい測距値を排除。マルチパス環境で有効。RAIM補助機能。'],
      14: ['Walking Mode', '歩行用途向けに測位挙動を最適化。', '低速移動時のノイズ低減。人間歩行速度域に最適化。'],
      15: ['Stop Detection', '停止状態を検出しドリフト抑制。', '静止中の位置変動抑制。消費電力管理との連携可能。'],
      16: ['GPS Tracking', 'GPS衛星の追尾を有効化。', 'GPS衛星の追尾を有効化し受信対象とします。'],
      17: ['GLONASS Tracking', 'GLONASS衛星の追尾を有効化。', 'GLONASS衛星の追尾を有効化し受信対象とします。'],
      18: ['QZSS Tracking', 'QZSS衛星の追尾を有効化。', 'QZSS衛星の追尾を有効化し受信対象とします。'],
      19: ['GNGSV Talker', 'GSVトーカーIDをGNに統一。', 'GSV出力のトーカーIDをGNに統一しマルチGNSSとして扱います。'],
      20: ['GNGSA Talker', 'GSAトーカーIDをGNに統一。', 'GSA出力のトーカーIDをGNに統一しマルチGNSSとして扱います。'],
      21: ['GLONASS Positioning', '測位にGLONASSを使用。', '測位計算にGLONASS衛星を使用します。'],
      22: ['GPS Positioning', '測位にGPSを使用。', '測位計算にGPS衛星を使用します。'],
      23: ['QZSS Positioning', '測位にQZSSを使用。', '測位計算にQZSS衛星を使用します。'],
      24: ['PPS Signal', 'PPS出力を有効化。', 'PPS出力を有効化し時刻同期用途で利用します。'],
      25: ['PPS Polarity Inv.', 'PPS出力の極性を反転。', 'PPS出力の極性を反転します。'],
      26: ['Position Hold', '固定局用途の位置固定モード。', '自動サーベイ後に座標固定。タイミング用途向け。'],
      27: ['TRAIM Algorithm', 'タイミング用途の整合性監視。', '衛星整合性監視アルゴリズム。高信頼タイミング用途向け。'],
      31: ['Low Power Mode', '周期動作により消費電力削減。', '取得→スリープを周期制御。バッテリー機器向け。'],
    };

    const CDB227_BITS = {
      1: ['NMEA Echo', '受信コマンドをNMEAポートへエコーバック。', '受信したPSTM/NMEAコマンドをそのままエコーバックします。'],
      2: ['TTFF Message', '初回測位後にTTFFメッセージを送出。', '初回Fixまでの時間を通知するTTFFメッセージを送出します。'],
      3: ['Few-Sat Positioning', '衛星数が3未満でも測位を許可。', '衛星数不足でも測位を継続します（精度低下の可能性）。'],
      5: ['Return Link Msg', 'Return Link Messageの出力を有効化。', '対応衛星からのReturn Link Messageを出力します。'],
      6: ['Galileo Tracking', 'Galileo衛星の追尾を有効化。', 'Galileo衛星の追尾を有効化し受信対象とします。'],
      7: ['Galileo Positioning', '測位にGalileoを使用。', '測位計算にGalileo衛星を使用します。'],
      8: ['BeiDou Tracking', 'BeiDou衛星の追尾を有効化。', 'BeiDou衛星の追尾を有効化し受信対象とします。'],
      9: ['BeiDou Positioning', '測位にBeiDouを使用。', '測位計算にBeiDou衛星を使用します。'],
      11: ['RTC Disabled', 'RTCを無効化（RTC水晶なし構成向け）。', 'RTCを無効化します。RTC水晶がない構成向け。'],
      12: ['Fast Satellite Drop', 'トンネル侵入時に即座にNO FIX出力。', '測位継続を停止し誤位置表示を防止。'],
    };

    const NMEA_MSG_BITS = [
      [0, '$GPGNS', true],
      [1, '$GPGGA', true],
      [2, '$GPGSA', true],
      [3, '$GPGST', false],
      [4, '$GPVTG', true],
      [5, '$PSTMNOISE', false],
      [6, '$GPRMC', true],
      [7, '$PSTMRF', false],
      [8, '$PSTMTG', false],
      [9, '$PSTMTS', false],
      [10, '$PSTMPA', false],
      [11, '$PSTMSAT', false],
      [12, '$PSTMRES', false],
      [13, '$PSTMTIM', false],
      [14, '$PSTMWAAS', false],
      [15, '$PSTMDIFF', false],
      [16, '$PSTMCORR', false],
      [17, '$PSTMSBAS', false],
      [18, '$PSTMTESTRF', false],
      [19, '$GPGSV', true],
      [20, '$GPGLL', false],
      [21, '$PSTMPPSDATA', false],
    ];

    const NMEA_DESC = {
      '$GPGGA': '現在位置（緯度経度・高度・使用衛星数・Fix状態）',
      '$GPGSA': '使用衛星とDOP値',
      '$GPGSV': '可視衛星情報（PRN・SNR）',
      '$GPRMC': '推奨最小航法データ（位置・速度・日時）',
      '$GPVTG': '対地速度・進行方向',
      '$GPZDA': 'UTC日付時刻',
      '$GPGST': '測位誤差統計情報',
      '$GPGNS': 'GNSS Fix Data（複数コンステレーション対応）',
      '$GPGLL': '緯度経度と時刻、データ有効/無効',
      '$PSTMNOISE': 'ST独自のノイズ関連情報',
      '$PSTMRF': 'ST独自のRF関連情報',
      '$PSTMTG': 'ST独自のテスト/技術情報',
      '$PSTMTS': '時刻同期/周波数同期関連の情報',
      '$PSTMPA': 'ST独自の位置解析/補助情報',
      '$PSTMSAT': '衛星情報（ST独自拡張）',
      '$PSTMRES': 'リセット/再初期化関連の情報',
      '$PSTMTIM': '時刻関連情報',
      '$PSTMWAAS': 'SBAS/WAAS関連の情報',
      '$PSTMDIFF': '差分（DGPS）関連の情報/コマンド',
      '$PSTMCORR': '補正情報（correction）関連の出力',
      '$PSTMSBAS': 'SBAS関連のステータス出力',
      '$PSTMTESTRF': 'RFテスト関連の情報',
      '$PSTMPPSDATA': 'PPS関連の出力データ',
    };

    const NMEA_DETAIL = {
      '$GPGGA': 'Fix時刻、緯度経度、Fix種別、使用衛星数、HDOP、標高、ジオイド高などの測位基本情報。',
      '$GPGSA': '測位モード(2D/3D)、使用衛星PRN一覧、PDOP/HDOP/VDOP。',
      '$GPGSV': '可視衛星情報（衛星ID、仰角、方位角、C/N0）。',
      '$GPRMC': '最小推奨情報：時刻、ステータス、緯度経度、対地速度、針路、日付、磁気偏角など。',
      '$GPVTG': '対地針路と対地速度。',
      '$GPZDA': 'UTC時刻と日付、ローカルタイムゾーン。',
      '$GPGST': '擬似距離誤差統計（RMS、偏差、誤差楕円など）。',
      '$GPGNS': 'GGAに近いFix情報を複数コンステレーション対応で出力。',
      '$GPGLL': '緯度経度と時刻、データ有効/無効。',
      '$PSTMNOISE': 'ノイズ関連の診断情報。用途に応じて有効化。',
      '$PSTMRF': 'RF関連の診断情報。',
      '$PSTMTG': 'テスト/技術情報の出力。',
      '$PSTMTS': '時刻同期/周波数同期関連の情報出力。',
      '$PSTMPA': '位置解析/補助情報。',
      '$PSTMSAT': '衛星情報（ST独自拡張）。',
      '$PSTMRES': 'リセット/再初期化関連の情報出力。',
      '$PSTMTIM': '時刻関連情報の出力。',
      '$PSTMWAAS': 'SBAS/WAAS関連の情報出力。',
      '$PSTMDIFF': '差分（DGPS）関連の情報/コマンド。',
      '$PSTMCORR': '補正情報（correction）関連の出力。',
      '$PSTMSBAS': 'SBAS関連のステータス出力。',
      '$PSTMTESTRF': 'RFテスト関連の情報出力。',
      '$PSTMPPSDATA': 'PPS関連の出力データ。',
    };

    const CONSTELLATIONS = [
      ['GPS', 200, 16, 200, 22],
      ['GLONASS', 200, 17, 200, 21],
      ['QZSS', 200, 18, 200, 23],
      ['Galileo', 227, 6, 227, 7],
      ['BeiDou', 227, 8, 227, 9],
    ];

    const FIX_RATES = [0.5, 1.0, 2.0, 5.0, 10.0];
    const MASK_ANGLES = [0, 5, 10, 15, 20, 25, 30];

    const teseoConfig = {
      fwVersion: 'Unknown',
      cdb_102: 0x5,
      cdb_104: 0,
      cdb_135: 15,
      cdb_200: 0x1963965C,
      cdb_201: 0x00980056,
      cdb_227: 0x0000040D,
      cdb_228: 0x00000000,
      cdb_303: 1.0,
    };

    const teseoPending = new Map();
    /** @type {{ line: string, t: number }[]} */
    const teseoLineQueue = [];

    const ui = {
      // Standalone connection UI (overlay mode does not own serial connect)
      baudSelect: qs('#baud-select'),
      btnConnect: qs('#btn-connect'),

      btnRead: qs('#teseo-btn-read', '#btn-read'),
      btnWrite: qs('#teseo-btn-write', '#btn-write'),
      btnSave: qs('#teseo-btn-save', '#btn-save'),
      btnReset: qs('#teseo-btn-reset', '#btn-reset'),
      stConn: qs('#teseo-st-conn', '#st-conn'),
      stFw: qs('#teseo-st-fw', '#st-fw'),
      stPending: qs('#teseo-st-pending', '#st-pending'),
      stStatus: qs('#teseo-st-status', '#st-status'),
      log: qs('#teseo-log', '#log'),
      cfgBaud: qs('#teseo-cfg-baud', '#cfg-baud'),
      cfgFix: qs('#teseo-cfg-fix', '#cfg-fix'),
      cfgMask: qs('#teseo-cfg-mask', '#cfg-mask'),
      constellationsGrid: qs('#teseo-constellations-grid', '#constellations-grid'),
      sbasGrid: qs('#teseo-sbas-grid', '#sbas-grid'),
      nmeaGrid: qs('#teseo-nmea-grid', '#nmea-grid'),
      featuresGrid: qs('#teseo-features-grid', '#features-grid'),
      featCdb: qs('#teseo-feat-cdb', '#feat-cdb'),
    };

    function setStatus(text, kind = '') {
      if (!ui.stStatus) return;
      ui.stStatus.textContent = text;
      ui.stStatus.className = `status-val ${kind}`.trim();
    }

    function syncConnState() {
      const connected = session.connected;
      if (ui.stConn) {
        ui.stConn.textContent = connected ? 'CONNECTED' : 'DISCONNECTED';
        ui.stConn.className = `status-val ${connected ? 'good' : 'bad'}`;
      }
      if (ui.btnConnect && !isOverlayMode) ui.btnConnect.textContent = connected ? 'Disconnect' : 'Connect';
      if (ui.btnRead) ui.btnRead.disabled = !connected;
      if (ui.btnWrite) ui.btnWrite.disabled = !connected;
      if (ui.btnSave) ui.btnSave.disabled = !connected;
      if (ui.btnReset) ui.btnReset.disabled = !connected;
    }

    function nowStamp() {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return `${hh}:${mm}:${ss}.${ms}`;
    }

    function appendLog(line, kind = '') {
      if (!ui.log) return;

      // Standalone tool uses a <textarea>, overlay uses a <div>
      if (ui.log.tagName === 'TEXTAREA') {
        ui.log.value += `${line}\n`;
        const MAX_LINES = 500;
        const lines = ui.log.value.split('\n');
        if (lines.length > MAX_LINES + 1) {
          ui.log.value = lines.slice(lines.length - (MAX_LINES + 1)).join('\n');
        }
        ui.log.scrollTop = ui.log.scrollHeight;
        return;
      }

      const row = document.createElement('div');
      row.className = `log-line${kind ? ` ${kind}` : ''}`;
      row.textContent = line;
      ui.log.appendChild(row);

      // Keep last N lines to avoid unlimited growth
      const MAX_LINES = 500;
      while (ui.log.childElementCount > MAX_LINES) ui.log.removeChild(ui.log.firstElementChild);

      ui.log.scrollTop = ui.log.scrollHeight;
    }

    function logWarn(message) {
      appendLog(`${nowStamp()} !! ${message}`, 'warn');
    }

    function logCmd(sentenceBody) {
      // The log panel is below the main settings; reveal it once per open to make it discoverable.
      revealLogOnce();
      appendLog(`${nowStamp()} >> $${sentenceBody}`, 'cmd');
    }

    function logResp(line) {
      appendLog(`${nowStamp()} << ${line}`, 'resp');
    }

    let revealedThisOpen = false;
    function revealLogOnce() {
      if (revealedThisOpen) return;
      if (isOverlayMode && !overlay.classList.contains('visible')) return;
      const logSection = ui.log?.closest('section');
      if (!logSection) return;
      revealedThisOpen = true;
      try {
        logSection.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } catch {
        // ignore
      }
    }

    function shouldCapture(line) {
      if (line.includes('PSTMCPU')) return false;
      if (line.includes('PSTM')) return true;
      if (line.includes('GPSAPP') || line.includes('GNSSLIB') || line.includes('BINIMG')) return true;
      return false;
    }

    function pushLine(line) {
      if (!line) return;
      teseoLineQueue.push({ line, t: Date.now() });
      if (teseoLineQueue.length > 300) teseoLineQueue.shift();
      logResp(line);
    }

    session.onLine((line) => {
      if (shouldCapture(line)) pushLine(line);
    });

    function parsePstmset(line) {
      let raw = line.trim();
      if (raw.includes('*')) {
        const [body, csStr] = raw.split('*');
        let calc = 0;
        for (const ch of body.replace(/^\$/, '')) calc ^= ch.charCodeAt(0);
        const cs = calc.toString(16).toUpperCase().padStart(2, '0');
        if (cs !== csStr.slice(0, 2).toUpperCase()) return null;
        raw = body;
      }
      const parts = raw.replace(/^\$/, '').split(',');
      if (!parts.length || (parts[0] !== 'PSTMSET' && parts[0] !== 'PSTMSETPAR')) return null;
      if (parts.length < 3) return null;
      const key = Number(parts[1]);
      if (Number.isNaN(key)) return null;
      const cdbId = key % 1000;
      return { cdbId, vals: parts.slice(2) };
    }

    function applyCdb(cdbId, vals) {
      if (!vals.length) return;
      const raw = vals[0].trim();
      if (raw.includes('.')) {
        const fv = Number(raw);
        if (!Number.isNaN(fv) && cdbId === 303) teseoConfig.cdb_303 = fv;
        return;
      }

      const iv = parseInt(raw, 16);
      if (Number.isNaN(iv)) return;
      if (cdbId === 102) teseoConfig.cdb_102 = iv;
      else if (cdbId === 104) teseoConfig.cdb_104 = iv;
      else if (cdbId === 135) teseoConfig.cdb_135 = iv;
      else if (cdbId === 200) teseoConfig.cdb_200 = iv;
      else if (cdbId === 201) teseoConfig.cdb_201 = iv;
      else if (cdbId === 227) teseoConfig.cdb_227 = iv;
      else if (cdbId === 228) teseoConfig.cdb_228 = iv;
      else if (cdbId === 303) teseoConfig.cdb_303 = iv;
    }

    function getBit(cdb, bit) {
      const v = teseoConfig[`cdb_${cdb}`] || 0;
      return (v & (1 << bit)) !== 0;
    }

    function setBit(cdb, bit, on) {
      const key = `cdb_${cdb}`;
      const oldVal = teseoConfig[key] || 0;
      const newVal = on ? (oldVal | (1 << bit)) : (oldVal & ~(1 << bit));
      if (newVal !== oldVal) {
        teseoConfig[key] = newVal;
        teseoPending.set(cdb, newVal);
      }
    }

    function nmeaEnabled(bit) {
      if (bit < 32) return (teseoConfig.cdb_201 & (1 << bit)) !== 0;
      return (teseoConfig.cdb_228 & (1 << (bit - 32))) !== 0;
    }

    function toggleNmea(bit) {
      if (bit < 32) {
        teseoConfig.cdb_201 ^= (1 << bit);
        teseoPending.set(201, teseoConfig.cdb_201);
      } else {
        teseoConfig.cdb_228 ^= (1 << (bit - 32));
        teseoPending.set(228, teseoConfig.cdb_228);
      }
    }

    function updatePending() {
      if (!ui.stPending) return;
      ui.stPending.textContent = String(teseoPending.size);
      ui.stPending.className = `status-val ${teseoPending.size ? 'warn' : 'good'}`;
    }

    function renderConstellations() {
      if (!ui.constellationsGrid) return;
      ui.constellationsGrid.innerHTML = '';
      CONSTELLATIONS.forEach(([name, tc, tb, pc, pb]) => {
        const track = getBit(tc, tb);
        const pos = getBit(pc, pb);
        const item = document.createElement('div');
        item.className = 'item';
        item.innerHTML = `
          <div class="label">
            <div>${name}</div>
            <small>Tracking / Positioning</small>
          </div>
          <div class="toggle-group">
            <label class="toggle-btn"><input type="checkbox" data-cdb="${tc}" data-bit="${tb}" ${track ? 'checked' : ''}/>Track</label>
            <label class="toggle-btn"><input type="checkbox" data-cdb="${pc}" data-bit="${pb}" ${pos ? 'checked' : ''}/>Pos</label>
          </div>
        `;
        if (teseoPending.has(tc) || teseoPending.has(pc)) item.classList.add('pending');
        ui.constellationsGrid.appendChild(item);
      });
    }

    function renderSbas() {
      if (!ui.sbasGrid) return;
      ui.sbasGrid.innerHTML = '';
      const engine = getBit(200, 2);
      const gsv = getBit(200, 3);

      const item1 = document.createElement('div');
      item1.className = 'item';
      item1.innerHTML = `
        <div class="label">SBAS Engine</div>
        <label class="toggle-btn"><input type="checkbox" data-cdb="200" data-bit="2" ${engine ? 'checked' : ''}/>On</label>
      `;
      if (teseoPending.has(200)) item1.classList.add('pending');

      const item2 = document.createElement('div');
      item2.className = 'item';
      item2.innerHTML = `
        <div class="label">Report in GSV</div>
        <label class="toggle-btn"><input type="checkbox" data-cdb="200" data-bit="3" ${gsv ? 'checked' : ''}/>On</label>
      `;
      if (teseoPending.has(200)) item2.classList.add('pending');

      const item3 = document.createElement('div');
      item3.className = 'item';
      item3.innerHTML = `
        <div class="label">SBAS Service</div>
        <select id="teseo-cfg-sbas"></select>
      `;
      const select = item3.querySelector('select');
      SBAS_SERVICE_KEYS.forEach((k) => {
        const opt = document.createElement('option');
        opt.value = String(k);
        opt.textContent = `${k} - ${SBAS_SERVICES[k]}`;
        if (k === teseoConfig.cdb_135) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', (e) => {
        teseoConfig.cdb_135 = Number(e.target.value);
        teseoPending.set(135, teseoConfig.cdb_135);
        renderAll();
      });
      if (teseoPending.has(135)) item3.classList.add('pending');

      ui.sbasGrid.appendChild(item1);
      ui.sbasGrid.appendChild(item2);
      ui.sbasGrid.appendChild(item3);
    }

    function renderNmea() {
      if (!ui.nmeaGrid) return;
      ui.nmeaGrid.innerHTML = '';
      NMEA_MSG_BITS.forEach(([bit, name]) => {
        const item = document.createElement('div');
        item.className = 'item';
        const desc = NMEA_DESC[name] || '詳細はUM2229参照。';
        const detail = NMEA_DETAIL[name] || desc;
        item.innerHTML = `
          <div class="label">
            <div class="label-title">
              <span class="name">${name}</span>
              <span class="desc">${desc}</span>
            </div>
            <details class="detail">
              <summary>詳細</summary>
              <div class="detail-body">${detail}</div>
            </details>
          </div>
          <label class="toggle-btn"><input type="checkbox" data-nmea-bit="${bit}" ${nmeaEnabled(bit) ? 'checked' : ''}/>On</label>
        `;
        if (teseoPending.has(201) || teseoPending.has(228)) item.classList.add('pending');
        ui.nmeaGrid.appendChild(item);
      });
    }

    function renderFeatures() {
      if (!ui.featuresGrid) return;
      ui.featuresGrid.innerHTML = '';
      const skip200 = new Set([2, 3, 16, 17, 18, 19, 20, 21, 22, 23]);
      const skip227 = new Set([6, 7, 8, 9]);
      const items = [];

      Object.entries(CDB200_BITS).forEach(([bit, [name, shortDesc, detailDesc]]) => {
        const b = Number(bit);
        if (!skip200.has(b)) items.push([200, b, name, shortDesc, detailDesc]);
      });

      Object.entries(CDB227_BITS).forEach(([bit, [name, shortDesc, detailDesc]]) => {
        const b = Number(bit);
        if (!skip227.has(b)) items.push([227, b, name, shortDesc, detailDesc]);
      });

      items.forEach(([cdb, bit, name, shortDesc, detailDesc]) => {
        const item = document.createElement('div');
        item.className = 'item';
        item.innerHTML = `
          <div class="label">
            <div class="label-title">
              <span class="name">${name}</span>
              <span class="desc">${shortDesc}</span>
            </div>
            <details class="detail">
              <summary>詳細</summary>
              <div class="detail-body">${detailDesc || shortDesc}</div>
            </details>
          </div>
          <label class="toggle-btn"><input type="checkbox" data-cdb="${cdb}" data-bit="${bit}" ${getBit(cdb, bit) ? 'checked' : ''}/>On</label>
        `;
        if (teseoPending.has(cdb)) item.classList.add('pending');
        ui.featuresGrid.appendChild(item);
      });

      if (ui.featCdb) ui.featCdb.textContent = `CDB-200: 0x${teseoConfig.cdb_200.toString(16).toUpperCase().padStart(8, '0')}  CDB-227: 0x${teseoConfig.cdb_227.toString(16).toUpperCase().padStart(8, '0')}`;
    }

    function renderSerial() {
      if (ui.cfgBaud) {
        ui.cfgBaud.innerHTML = '';
        BAUDRATE_LIST.forEach((b) => {
          const opt = document.createElement('option');
          opt.value = String(b);
          opt.textContent = `${b} baud`;
          if (b === BAUDRATE_TABLE[teseoConfig.cdb_102]) opt.selected = true;
          ui.cfgBaud.appendChild(opt);
        });
      }

      if (ui.cfgFix) {
        ui.cfgFix.innerHTML = '';
        FIX_RATES.forEach((r) => {
          const opt = document.createElement('option');
          opt.value = String(r);
          opt.textContent = r.toFixed(1);
          if (r === teseoConfig.cdb_303) opt.selected = true;
          ui.cfgFix.appendChild(opt);
        });
      }

      if (ui.cfgMask) {
        ui.cfgMask.innerHTML = '';
        MASK_ANGLES.forEach((a) => {
          const opt = document.createElement('option');
          opt.value = String(a);
          opt.textContent = String(a);
          if (a === teseoConfig.cdb_104) opt.selected = true;
          ui.cfgMask.appendChild(opt);
        });
      }
    }

    function renderAll() {
      renderConstellations();
      renderSbas();
      renderNmea();
      renderSerial();
      renderFeatures();
      updatePending();
      if (ui.stFw) ui.stFw.textContent = teseoConfig.fwVersion;
    }

    function setupTabs() {
      const buttons = Array.from(overlay.querySelectorAll('.teseo-tab-btn, .tab-btn'));
      if (!buttons.length) return;

      // Only tab panels should be toggled; the Serial Log section must remain visible.
      const sections = Array.from(overlay.querySelectorAll('#teseo-main > section[id^="teseo-tab-"], main.main > section[id^="tab-"]'));

      const activateTab = (target) => {
        buttons.forEach((b) => b.classList.toggle('active', b.getAttribute('data-tab') === target));
        sections.forEach((sec) => sec.classList.add('hidden'));
        qs(`#teseo-tab-${target}`, `#tab-${target}`)?.classList.remove('hidden');
      };

      const initial = buttons.find((b) => b.classList.contains('active'))?.getAttribute('data-tab') || 'constellations';
      activateTab(initial);

      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = btn.getAttribute('data-tab');
          if (!target) return;
          activateTab(target);
        });
      });
    }

    function setupStandaloneConnectUi() {
      if (isOverlayMode) return;
      if (!ui.btnConnect || !ui.baudSelect) return;

      ui.baudSelect.innerHTML = '';
      BAUDRATE_LIST.forEach((br) => {
        const opt = document.createElement('option');
        opt.value = String(br);
        opt.textContent = String(br);
        if (br === 115200) opt.selected = true;
        ui.baudSelect.appendChild(opt);
      });

      ui.btnConnect.addEventListener('click', async () => {
        try {
          if (session.connected) {
            setStatus('Disconnecting...', 'warn');
            await session.disconnect();
            setStatus('Disconnected');
            return;
          }

          const baud = Number(ui.baudSelect.value) || 115200;
          setStatus(`Connecting @ ${baud}...`, 'warn');
          await session.connect(baud);
          setStatus('Connected', 'good');
        } catch (e) {
          setStatus(`Connect failed: ${e?.message || e}`, 'bad');
        }
      });
    }

    function padCdb(cdbId) {
      return String(cdbId).padStart(3, '0');
    }

    async function waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const idx = teseoLineQueue.findIndex((e) => {
          try {
            return predicate(e.line);
          } catch {
            return false;
          }
        });
        if (idx !== -1) return teseoLineQueue.splice(idx, 1)[0].line;
        await new Promise((r) => setTimeout(r, 40));
      }
      return null;
    }

    async function waitForCdb(cdbId, timeoutMs) {
      return waitFor((line) => {
        const res = parsePstmset(line);
        return !!res && res.cdbId === cdbId;
      }, timeoutMs);
    }

    async function sendSentence(sentenceBody) {
      logCmd(sentenceBody);
      await session.sendSentenceBody(sentenceBody);
    }

    async function readConfig() {
      if (!session.connected) {
        setStatus('Not connected (use top Connect)', 'bad');
        return;
      }

      setStatus('Reading config... (log is at bottom)', 'warn');
      teseoLineQueue.length = 0;

      // FW version
      try {
        await sendSentence('PSTMGETSWVER');
        const fwLine = await waitFor(
          (l) => l.includes('GPSAPP') || l.includes('GNSSLIB') || l.includes('BINIMG'),
          1500,
        );
        if (fwLine) teseoConfig.fwVersion = fwLine.split('$').pop().slice(0, 40);
      } catch {
        // ignore
      }

      const cdbList = [102, 104, 135, 200, 201, 227, 228, 303];
      const missing = [];
      let okCount = 0;

      const READ_TIMEOUT_MS = 2200;

      for (const cdbId of cdbList) {
        let got = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          setStatus(`Reading CDB-${cdbId} (try ${attempt}/3)...`, 'warn');
          await sendSentence(`PSTMGETPAR,1${padCdb(cdbId)}`);
          got = await waitForCdb(cdbId, READ_TIMEOUT_MS);
          if (got) break;
          logWarn(`timeout waiting CDB-${cdbId}`);
        }

        if (!got) {
          missing.push(cdbId);
          continue;
        }

        const parsed = parsePstmset(got);
        if (parsed) {
          applyCdb(parsed.cdbId, parsed.vals);
          okCount += 1;
        }
      }

      teseoPending.clear();
      renderAll();

      if (missing.length) {
        setStatus(`Read done: ${okCount}/${cdbList.length} (missing: ${missing.join(',')})`, 'warn');
      } else {
        setStatus(`Config read OK (${okCount} params)`, 'good');
      }
    }

    async function writeConfig() {
      if (!session.connected) {
        setStatus('Not connected (use top Connect)', 'bad');
        return;
      }

      if (!teseoPending.size) {
        setStatus('No pending changes', 'warn');
        return;
      }

      revealLogOnce();

      let errors = 0;
      let noResp = 0;

      for (const [cdbId, value] of teseoPending.entries()) {
        setStatus(`Writing CDB-${cdbId}...`, 'warn');

        const valStr = typeof value === 'number' && !Number.isInteger(value)
          ? value.toFixed(1)
          : value.toString(16).toUpperCase();

        let resp = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          await sendSentence(`PSTMSETPAR,1${padCdb(cdbId)},${valStr}`);
          resp = await waitFor(
            (l) => {
              if (l.includes('ERROR') && l.includes('PSTMSETPAR')) return true;
              if (l.includes('PSTMSETPAR') && l.includes(`,1${padCdb(cdbId)}`)) return true;
              const res = parsePstmset(l);
              return !!res && res.cdbId === cdbId;
            },
            2200,
          );
          if (resp) break;
          logWarn(`timeout waiting write-ack CDB-${cdbId}`);
        }

        if (!resp) {
          noResp += 1;
          continue;
        }
        if (resp.includes('ERROR')) errors += 1;
        await new Promise((r) => setTimeout(r, 80));
      }

      teseoPending.clear();
      renderAll();
      if (errors) setStatus(`Write done with ${errors} error(s)`, 'bad');
      else if (noResp) setStatus(`Write sent (no response: ${noResp})`, 'warn');
      else setStatus('Changes written to RAM', 'good');
    }

    async function saveNvm() {
      if (!session.connected) {
        setStatus('Not connected (use top Connect)', 'bad');
        return;
      }

      revealLogOnce();
      let ok = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        setStatus(`Saving to NVM (try ${attempt}/2)...`, 'warn');
        await sendSentence('PSTMSAVEPAR');
        const resp = await waitFor((l) => l.includes('PSTMSAVEPAROK'), 4500);
        if (resp) {
          ok = true;
          break;
        }
        logWarn('timeout waiting PSTMSAVEPAROK');
      }

      if (ok) setStatus('Saved to NVM', 'good');
      else setStatus('Save sent (no OK reply)', 'warn');
    }

    async function resetDevice() {
      if (!session.connected) {
        setStatus('Not connected (use top Connect)', 'bad');
        return;
      }

      revealLogOnce();
      await sendSentence('PSTMSRR');
      setStatus('Soft reset sent', 'warn');
    }

    function setupHandlers() {
      ui.btnRead?.addEventListener('click', readConfig);
      ui.btnWrite?.addEventListener('click', writeConfig);
      ui.btnSave?.addEventListener('click', saveNvm);
      ui.btnReset?.addEventListener('click', resetDevice);

      ui.constellationsGrid?.addEventListener('change', (e) => {
        const input = e.target;
        if (!input.matches("input[type='checkbox'][data-cdb]")) return;
        const cdb = Number(input.getAttribute('data-cdb'));
        const bit = Number(input.getAttribute('data-bit'));
        setBit(cdb, bit, input.checked);
        renderAll();
      });

      ui.sbasGrid?.addEventListener('change', (e) => {
        const input = e.target;
        if (!input.matches("input[type='checkbox'][data-cdb]")) return;
        const cdb = Number(input.getAttribute('data-cdb'));
        const bit = Number(input.getAttribute('data-bit'));
        setBit(cdb, bit, input.checked);
        renderAll();
      });

      ui.nmeaGrid?.addEventListener('change', (e) => {
        const input = e.target;
        if (!input.matches("input[type='checkbox'][data-nmea-bit]")) return;
        const bit = Number(input.getAttribute('data-nmea-bit'));
        toggleNmea(bit);
        renderAll();
      });

      ui.featuresGrid?.addEventListener('change', (e) => {
        const input = e.target;
        if (!input.matches("input[type='checkbox'][data-cdb]")) return;
        const cdb = Number(input.getAttribute('data-cdb'));
        const bit = Number(input.getAttribute('data-bit'));
        setBit(cdb, bit, input.checked);
        renderAll();
      });

      ui.cfgBaud?.addEventListener('change', (e) => {
        const baud = Number(e.target.value);
        const code = BAUDRATE_REVERSE[baud];
        teseoConfig.cdb_102 = code;
        teseoPending.set(102, code);
        renderAll();
      });

      ui.cfgFix?.addEventListener('change', (e) => {
        const rate = Number(e.target.value);
        teseoConfig.cdb_303 = rate;
        teseoPending.set(303, rate);
        renderAll();
      });

      ui.cfgMask?.addEventListener('change', (e) => {
        const mask = Number(e.target.value);
        teseoConfig.cdb_104 = mask;
        teseoPending.set(104, mask);
        renderAll();
      });

      session.onState(() => syncConnState());
    }

    if (isOverlayMode) {
      function openOverlay() {
        overlay.classList.add('visible');
        overlay.setAttribute('aria-hidden', 'false');
        revealedThisOpen = false;
        syncConnState();
      }

      function closeOverlay() {
        overlay.classList.remove('visible');
        overlay.setAttribute('aria-hidden', 'true');
      }

      // Overlay events
      openButton?.addEventListener('click', openOverlay);
      closeButton?.addEventListener('click', closeOverlay);
      backdrop?.addEventListener('click', closeOverlay);

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeOverlay();
      });
    } else {
      // Standalone: log is always visible; skip the "scroll once per open" behavior.
      revealedThisOpen = true;
    }

    // Init
    setupTabs();
    setupStandaloneConnectUi();
    setupHandlers();
    renderAll();
    syncConnState();
  }

  function initTeseoTool({ session, overlayId = 'teseo-overlay', openButtonId = 'btn-teseo' }) {
    if (!session) throw new Error('initTeseoTool: session is required');

    const overlay = document.getElementById(overlayId);
    if (!overlay) throw new Error(`initTeseoTool: overlay #${overlayId} not found`);

    // Prevent double initialization (e.g., accidental duplicate <script> or manual re-init)
    if (overlay.dataset.teseoToolInit === '1') return;
    overlay.dataset.teseoToolInit = '1';

    const openButton = document.getElementById(openButtonId);
    if (!openButton) throw new Error(`initTeseoTool: open button #${openButtonId} not found`);

    const closeButton = overlay.querySelector('#teseo-btn-close');
    const backdrop = overlay.querySelector('#teseo-backdrop');

    initTeseoToolInternal({ session, scope: overlay, mode: 'overlay', openButton, closeButton, backdrop });
  }

  function initTeseoToolStandalone({ session, root = document }) {
    if (!session) throw new Error('initTeseoToolStandalone: session is required');
    const guardEl = root?.documentElement || document.documentElement;

    if (guardEl.dataset.teseoToolStandaloneInit === '1') return;
    guardEl.dataset.teseoToolStandaloneInit = '1';

    initTeseoToolInternal({ session, scope: guardEl, mode: 'standalone' });
  }

  global.initTeseoTool = initTeseoTool;
  global.initTeseoToolStandalone = initTeseoToolStandalone;
})(window);
