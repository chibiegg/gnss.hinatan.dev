# gnss.hinatan.dev

Web Serial API を使って GNSS モジュールとブラウザを直結し、NMEA の表示・解析や、STMicroelectronics の GNSS モジュール **Teseo-LIV3FL** の設定を行うための静的 HTML ツール集です。

公開サイト： https://gnss.hinatan.dev/

## できること

- **GNSS NMEA Viewer**：受信した NMEA を表示・解析
- **Teseo-LIV3FL Settings**：Teseo-LIV3FL の設定変更（対応機種のみ）

## 使い方（利用者向け）

### 必要なもの

- **Chrome / Edge**（Web Serial API 対応）
- PC に接続できる GNSS モジュール（USB-シリアル変換など）

### 開くページ

- 統合版（Viewer + Teseo 設定）：https://gnss.hinatan.dev/
- Viewer のみ（旧/簡易版）：https://gnss.hinatan.dev/simple.html
- Teseo 単体版：https://gnss.hinatan.dev/teseo-liv3fl/

### 接続手順（共通）

1. 上記いずれかのページを開きます。
2. ページ内の **Connect** を押します。
3. OS のポート選択ダイアログが開くので、GNSS のシリアルポートを選びます。
4. 必要に応じて **Baudrate** を選択します（モジュール側設定と一致させてください）。

> Note: 接続時に OS の権限確認が出る場合があります。

### よくあるつまずき

- **ポートが出てこない**：他のアプリ（ターミナル、設定ツール等）が同じポートを掴んでいないか確認してください。
- **Connect ボタンを押しても何も起きない**：HTTPS で開けているか（URL が https:// か）と、Chrome / Edge を使っているか確認してください。
- **文字化け/解析できない**：Baudrate が合っているか確認してください。

## ドキュメント

- GNSS NMEA Viewer：<docs/gnss-nmea-viewer.md>
- Teseo-LIV3FL 設定ツール：<docs/teseo_liv3fl.md>

---

## 開発者向け（ローカルでの実行）

このリポジトリは静的ファイルのため、ローカルで UI を確認する場合は `htdocs/` を HTTP サーバで配信して開きます。

### 必要環境

- **Chrome / Edge**（Web Serial API 対応ブラウザ）
- **HTTPS もしくは localhost** での実行（Web Serial API の制約）
- GNSS モジュール（USB-シリアル変換などでPCに接続できること）

### 起動例

1. `htdocs/` を HTTP サーバで配信して開きます（`localhost` なら HTTP でも動作します）。

   例：
   ```bash
   cd htdocs
   python3 -m http.server 8000
   ```

2. ブラウザで開きます。
   - 統合版（Viewer + Teseo モーダル）：`http://localhost:8000/`
   - Viewer のみ（旧/簡易版）：`http://localhost:8000/simple.html`
   - Teseo 単体版：`http://localhost:8000/teseo-liv3fl/`

3. ページ内の **Connect** を押してポート選択ダイアログから GNSS のシリアルポートを選びます。
4. 必要に応じて **Baudrate** を選択します（モジュール側の設定と一致させてください）。

> Note: 接続時にOSの権限確認が出る場合があります。

詳細な機能・操作手順・トラブルシュートはツール別ドキュメントを参照してください。
