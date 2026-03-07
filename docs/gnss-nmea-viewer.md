# GNSS NMEA Viewer

対象:

- `htdocs/index.html`（統合版：Viewer + Teseo設定モーダル）
- `htdocs/simple.html`（旧/簡易版：Viewerのみ）

Web Serial API を使って GNSS モジュールから NMEA センテンスを受信し、状態を可視化するツールです。

## 必要環境

- **Chrome / Edge**（Web Serial API 対応）
- **HTTPS もしくは localhost** での実行
- GNSS モジュール（USB-シリアル変換などでPCに接続できること）

## 起動（ローカル例）

`htdocs/` を配信してブラウザで開きます。

```bash
cd htdocs
python3 -m http.server 8000
```

- `http://localhost:8000/`（統合版）
- `http://localhost:8000/simple.html`（旧/簡易版）

## 使い方

1. **Baud** を選択します（モジュール側設定と一致させます）。
2. **Connect** を押して、ポート選択ダイアログからGNSSのシリアルポートを選びます。
3. 受信した NMEA が自動的に解析・表示されます。

統合版（`/`）の場合:

- 右上の **Teseo** ボタンから、Teseo-LIV3FL の設定モーダルを開けます（Viewerの更新は継続します）。

補助機能:
- **Demo**：疑似NMEAを生成して動作確認
- **Map**：地図パネルの表示（Follow / Re-center / Clear Track）
- **Reset**：UI状態のリセット

## 主な表示内容

- 時刻/日付（UTC）
- Fix 状態（2D/3D/DGPS/RTK/Float RTK など）
- 緯度・経度・高度
- 速度、進行方向
- DOP（PDOP/HDOP/VDOP）
- 使用衛星/可視衛星（衛星テーブル・Sky View）
- Raw NMEA ログ

統合版の追加要素:

- Teseo設定モーダル（Read/Write/Save NVM/Reset など）

## 対応している主な NMEA（実装上のパーサ）

- `GGA`：位置・高度・Fix quality・使用衛星数・HDOP
- `RMC`：位置・速度・針路・日付・ステータス
- `VTG`：対地速度・進行方向
- `GSA`：Fix mode、使用衛星、PDOP/HDOP/VDOP
- `GSV`：可視衛星（仰角/方位角/SNR）

補足:
- Talker ID（`GP/GL/GA/GB/BD/GQ/GN` など）と PRN から GPS/GLONASS/Galileo/BeiDou/QZSS/SBAS を判別して色分けします。

## トラブルシュート

- **Connect が効かない / Web Serial API 非対応**
  - Chrome/Edge を使用しているか確認してください。
  - `https://` または `http://localhost` で開いているか確認してください。

- **データが化ける / 何も表示されない**
  - ボーレートがモジュールと一致しているか確認してください。
  - USB-シリアル変換の配線（TX/RX/GND）や電源を確認してください。
