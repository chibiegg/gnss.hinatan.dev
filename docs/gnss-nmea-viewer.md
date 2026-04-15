# GNSS NMEA Viewer

対象:

- `htdocs/index.html`（統合版：Viewer + モジュール設定モーダル）
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

- 右上の **⚙** ボタンをクリックするとメニューが開き、接続中のモジュールに合わせた設定ツールを開けます（Viewerの更新は継続します）。

補助機能:
- **Demo**：疑似NMEAを生成して動作確認
- **Map**：地図パネルの表示（Follow / Re-center / Clear Track）
- **DOP**：DOP履歴グラフの表示
- **Reset**：UI状態のリセット
- **REC**：NMEAセッションの録画・再生

## 主な表示内容

- 時刻/日付（UTC）
- Fix 状態（2D/3D/DGPS/RTK/Float RTK など）
- 緯度・経度・高度
- 速度、進行方向
- DOP（PDOP/HDOP/VDOP）
- 使用衛星/可視衛星（衛星テーブル・Sky View）
- Raw NMEA ログ

統合版の追加要素:

- モジュール設定モーダル（Teseo-LIV3FL / u-blox M10）

## 対応している主な NMEA（実装上のパーサ）

- `GGA`：位置・高度・Fix quality・使用衛星数・HDOP
- `RMC`：位置・速度・針路・日付・ステータス
- `VTG`：対地速度・進行方向
- `GSA`：Fix mode、使用衛星、PDOP/HDOP/VDOP
- `GSV`：可視衛星（仰角/方位角/SNR）

補足:
- Talker ID（`GP/GL/GA/GB/BD/GQ/GN` など）と PRN から GPS/GLONASS/Galileo/BeiDou/QZSS/SBAS を判別して色分けします。

## モジュール設定ツール

### Teseo-LIV3FL Settings

STMicroelectronics Teseo-LIV3FL 向け設定ツールです。NMEA プロプライエタリコマンド（PSTMGETPAR / PSTMSETPAR）で設定を読み書きします。

詳細: [docs/teseo_liv3fl.md](teseo_liv3fl.md)

### u-blox M10 Settings

u-blox M10 (SPG 5.20) 向け設定ツールです。UBX バイナリプロトコル（CFG-VALGET / CFG-VALSET）で設定を読み書きします。

**操作ボタン:**

| ボタン | 動作 |
|---|---|
| Read | 現在の設定を RAM から読み込む（MON-VER でFWバージョンも取得） |
| Write RAM | 変更をRAMへ即時反映（再起動で消える） |
| Save Flash | Flashへ永続保存（再起動後も維持） |
| Save BBR | BBR（バッテリーバックアップRAM）へ保存 |
| Soft Reset | モジュールを再起動 |
| Export | 現在の設定をJSONファイルとして書き出し |
| Import | JSONファイルから設定を読み込み |

> Save Flash / Save BBR はモジュールの型番・ファームウェアによって利用可否が変わります。Read 後に自動で有効/無効が切り替わります。

**設定タブ:**

| タブ | 設定内容 |
|---|---|
| GNSS | コンステレーション有効化（GPS / GLONASS / Galileo / BeiDou / QZSS / SBAS）と個別信号（L1C/A, L1OF, E1, B1I, B1C, L1S など） |
| SBAS | 補強信号の利用設定（Test mode / Ranging / DiffCorr / Integrity） |
| NMEA | UART1 への NMEA メッセージ出力（GGA/RMC/GSA/GSV/VTG/GLL/GNS/ZDA）とプロトコル詳細設定 |
| Navigation | Fix モード、初期Fix精度、UTC基準、Dynamic Model（Portable/Stationary/Pedestrian/Automotiveなど） |
| Rate / Serial | 測位レート（Measurement Rate / Nav Ratio）、UART1 ボーレート、入出力プロトコル |
| Timepulse | TP1（PPS）パルス設定（周期・幅・極性・GNSS同期）とパルス波形プレビュー |

## トラブルシュート

- **Connect が効かない / Web Serial API 非対応**
  - Chrome/Edge を使用しているか確認してください。
  - `https://` または `http://localhost` で開いているか確認してください。

- **データが化ける / 何も表示されない**
  - ボーレートがモジュールと一致しているか確認してください。
  - USB-シリアル変換の配線（TX/RX/GND）や電源を確認してください。

- **u-blox M10: Read がタイムアウトする**
  - UBX バイナリプロトコルが UART1 の入力プロトコルに含まれているか確認してください（デフォルトでは有効）。
  - ボーレートが合っているか確認してください。
