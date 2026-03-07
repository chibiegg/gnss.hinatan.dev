# Teseo-LIV3FL 設定ツール

対象:

- `htdocs/index.html`（統合版：Viewer上でTeseo設定モーダルを開く）
- `htdocs/teseo-liv3fl/index.html`（単体版）

STMicroelectronics の GNSS モジュール **Teseo-LIV3FL** 向けの設定ツールです。
Web Serial API 経由で NMEA 形式のコマンドを送受信し、PSTM パラメータを読み書きします。

## 必要環境

- **Chrome / Edge**（Web Serial API 対応）
- **HTTPS もしくは localhost** での実行
- 対象デバイス: PSTM コマンド（例: `PSTMGETPAR` / `PSTMSETPAR`）に応答する Teseo-LIV3FL

## 起動（ローカル例）

```bash
cd htdocs
python3 -m http.server 8000
```

- 統合版（Viewer + Teseoモーダル）：`http://localhost:8000/`
- 単体版：`http://localhost:8000/teseo-liv3fl/`

## 画面の操作フロー（推奨）

1. （統合版の場合）Viewer側で **BAUD** を選択し、**Connect** でシリアル接続
2. **TESEO** ボタンで設定モーダルを開く
3. **Read**：モジュールから現在設定を読み出し
4. UIで値を変更（変更は Pending として保持）
5. **Write**：変更を RAM に反映
6. 必要なら **Save NVM**：不揮発メモリへ保存（`PSTMSAVEPAR`）
7. 必要なら **Reset**：ソフトリセット（`PSTMSRR`）

単体版（`/teseo-liv3fl/`）の場合は、そのページ内の **Connect** から同様に操作します。

## 送受信する主なコマンド

- 取得
	- `PSTMGETSWVER`（ファームウェア文字列をログから推定）
	- `PSTMGETPAR,1xxx`（CDB を読み出し）
- 設定
	- `PSTMSETPAR,1xxx,<value>`（CDB を書き込み）
- 保存
	- `PSTMSAVEPAR`（NVMへ保存）
- リセット
	- `PSTMSRR`（ソフトリセット）

## 変更できる項目（実装で扱っている CDB の例）

- **Constellations**：GPS / GLONASS / QZSS / Galileo / BeiDou（Tracking / Positioning）
	- 対象: CDB-200 / CDB-227
- **SBAS**：SBAS Engine、GSVへのSBAS衛星出力、SBASサービス
	- 対象: CDB-200 / CDB-135
- **NMEA Output**：NMEAメッセージ出力マスク（例：GNS/GGA/GSA/VTG/RMC/GSV など）
	- 対象: CDB-201 / CDB-228
- **Serial / Timing**：ボーレート、Fix Rate、Mask Angle
	- 対象: CDB-102 / CDB-303 / CDB-104

注意:
- ボーレート変更はリセットが必要な場合があります（UI上でも `baud change requires reset ($PSTMSRR)` と表示）。

## トラブルシュート

- **Web Serial API not available**
	- Chrome/Edge + `https://` または `http://localhost` を確認してください。

- **Read/Write がうまくいかない**
	- 対象が PSTM コマンドに応答する構成か確認してください。
	- NMEA出力が多い場合、ログが流れて応答検出（substring検索）に影響することがあります。必要に応じて出力を絞ってから実行してください。
