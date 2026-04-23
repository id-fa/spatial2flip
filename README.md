# spatial2flip

360° / VR / Apple 空間写真 / **魚眼 180°** をブラウザ上で表示し、カメラワーク（回転・停止・ズーム・8 の字）の組合せ、**ライブ録画**、**端末のジャイロ操作** を使った動画や、左右視差を切り替えるパタパタアニメーションを **アニメーション WebP / MP4 (H.264)** としてダウンロードできるシングルページ Web アプリです。

**PWA 対応**。初回アクセス後は完全オフラインで動作し、ホーム画面に追加すればアプリのように起動できます。

すべての処理はブラウザ内で完結し、画像はサーバーに送信されません。

## 主な機能

- **簡易ビューア**
  - **対応フォーマット**: 360° モノラル / VR360 SBS / VR360 OU / VR180 SBS / VR180 OU / 魚眼 180° モノラル / 魚眼 180° SBS / Apple 空間写真 (MV-HEIC)
  - **Apple 空間写真** (iPhone 15 Pro 以降 / Apple Vision Pro で撮影した MV-HEIC) を自動検出
  - **魚眼 180°** は読み込み時に equirectangular 半球へ自動展開（equidistant 射影・中心・短辺半径・FOV 180° 固定）
  - WebXR 対応ブラウザ + VR ゴーグル接続時は立体視
  - マウス / タッチドラッグで視点、**マウスホイールまたはピンチ** で FOV ズーム
  - **ジャイロ操作**: スマホ / タブレットで「📱 ジャイロ」をタップすると端末を動かして視点操作（iOS は許可ダイアログ）。画面回転にも追従（録画中は向きを固定）

- **ライブ録画**
  - ビューア上の操作（ドラッグ／ピンチ／ジャイロ）をそのまま動画化
  - 録画中は赤い REC インジケータ + 経過秒が表示
  - 録画停止後、ビューア解像度ではなく選択した出力解像度でオフスクリーン再レンダー → 高品質な動画として出力

- **カメラワーク詳細設定**
  - 開始位置（視点＋ズーム）を保存し、そこを起点に以下のステップを自由に組合せ
    - **回転**: 左右 360° / 180° / 90° / 45°、上下 90° / 45°
    - **ズーム**: イン / アウト（対数空間補間で一定速度感）
    - **図 8**: 横 8 の字（小 / 大）。開始位置を中心に 1 周し正確に復帰
    - **停止**: 任意秒数静止
  - 各ステップの秒数はインライン編集可、合計時間も即時更新
  - ▲▼ ボタン／グリップ `⠿` の DnD で並び替え
  - 「▶ ビューアで再生」で変換前に動きを確認（ビューア自動スクロール）
  - **JSON エクスポート / インポート**: カメラワーク定義をファイルに保存し、別画像や別環境で再利用

- **パタパタアニメーション**
  - VR180 SBS/OU、魚眼 180° SBS、空間写真でカメラワーク未設定時は左右視差を交互に切り替える動画を生成
  - 切替サイクル数・切替間隔・品質を調整可能

- **出力形式**
  - **WebP**: 無限ループアニメーション（`<img>` 単体で再生、SNS・メッセンジャー互換）
  - **MP4 (H.264)**: yuv420p + faststart で SNS / iOS Safari フレンドリー
  - 変換後に「▶ プレビュー」でインライン再生、ダウンロード可

- **PWA（オフライン動作）**
  - 初回アクセス時に Service Worker が Three.js / ffmpeg.wasm / libheif を含む全依存をバックグラウンドでキャッシュ
  - 2 回目以降は完全オフライン動作可能
  - Chrome / Edge では URL バーの「インストール」でアプリとして利用可能、iOS Safari では「ホーム画面に追加」

- **完全クライアント処理**
  - 画像アップロード・レンダリング・エンコードすべてブラウザ内で実行
  - サーバーへの保存・送信は一切なし

## 技術スタック

| ライブラリ | 用途 |
|---|---|
| [Three.js](https://threejs.org/) r162 | 球面マッピング・WebXR 立体視・オフスクリーンカメラワーク/録画キャプチャ |
| [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) 0.12.10 | フレーム群を libwebp / libx264 で WebP / MP4 にエンコード |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.19.8 | Apple 空間写真 (MV-HEIC) のデコード |
| Python 3 | 開発用静的ファイルサーバー（`serve.py`、`ThreadingHTTPServer`） |

ビルドステップ不要。素の HTML + ES Modules + CDN で動作します。

## 動作要件

- **ブラウザ**: Chrome / Edge 最新版推奨（WebXR・ES Modules をフル活用）。iOS Safari でも主要機能は動作
- **Python 3**: ローカル起動用。`file://` では ES Modules / ffmpeg.wasm Worker / Service Worker が動作しないため HTTP サーバー経由が必須
- **ネットワーク**: 初回起動時に CDN から Three.js（約 600KB）と ffmpeg.wasm 一式（約 30MB）をダウンロード → Service Worker が自動キャッシュ。以降はオフラインでも動作
- **HTTPS**: PWA として本番配信する場合は HTTPS 必須（`localhost` は例外）。ジャイロ（iOS）も HTTPS 必須

## 使い方

### 1. 起動

```bash
python serve.py
# → http://localhost:8000 をブラウザで開く
```

ポートを変更するときは `python serve.py 8080` のように引数で指定できます。

Python を使わず任意の静的サーバーでも動きます:

```bash
# Node.js の場合
npx serve .

# PHP の場合
php -S localhost:8000
```

### 2. 画像をアップロード

- ドロップゾーンに画像をドラッグ&ドロップ、またはクリックしてファイル選択
- 対応形式: JPG / PNG / WebP / HEIC（Apple 空間写真）
- HEIC ファイルをアップロードすると自動的に「空間写真」フォーマットが選択されます

### 3. 画像形式を選択

| 選択肢 | 想定入力 |
|---|---|
| 360° モノラル | 2:1 のエクイレクタングラー画像（標準的な 360° 写真） |
| VR360 SBS | 左右に 2 枚並んだステレオ 360° 画像 |
| VR360 OU | 上下に 2 枚並んだステレオ 360° 画像 |
| VR180 SBS | 左右に 2 枚並んだステレオ 180° 画像 |
| VR180 OU | 上下に 2 枚並んだステレオ 180° 画像 |
| 魚眼 180° モノラル | 円形魚眼画像（中心・短辺半径・FOV 180° 前提） |
| 魚眼 180° SBS | 左右に 2 眼分の魚眼円が並んだステレオ魚眼画像 |
| 空間写真 | iPhone 15 Pro 以降 / Apple Vision Pro の MV-HEIC（通常画角のステレオペア） |

SBS / OU の左右（上下）割り当ては「左 / 上 = 左目」を標準。空間写真は MV-HEIC 内の画像 index 0 を左目、1 を右目として扱います。

### 4. プレビュー

ビューアエリアで:

- **ドラッグ**: 視点回転（360° は全方向、VR180 / 魚眼 180° は前方半球内、空間写真は回転なし）
- **マウスホイール / ピンチ**: 拡大・縮小（FOV 25°〜100°）
- **📱 ジャイロ**（モバイル / タブレット）: タップで ON。以降は端末の向きで視点が追従
- **ENTER VR**: WebXR 対応ブラウザ + VR ゴーグル接続時に立体視

### 5. 動画変換

**出力形式**: アニメーション WebP（ループ再生）または MP4 (H.264) を選択。

#### 5-A. シンプルモード（ステップ未設定時）

**360° 系（mono360 / sbs360 / ou360）・魚眼 180° モノラル:**

- 回転時間 (1〜30 秒)
  - 360° 系: Y 軸周り 1 回転
  - 魚眼 180° モノラル: 水平 170° スイープ（半球の両端を避けた範囲）
- FPS (10〜60)
- 解像度（正方形 or 16:9 プリセット）
- 品質

**VR180 系 / 魚眼 180° SBS / 空間写真（sbs180 / ou180 / fisheyeSbs180 / spatial）:**

- 切替サイクル数 (1〜20 往復)
- 切替間隔 (0.1〜2 秒)
- 品質

→ 左右画像を交互に切り替える「パタパタ」アニメーションを生成

#### 5-B. カメラワーク詳細設定モード

空間写真以外で利用可能。

1. ビューアで**開始位置（視点＋ズーム）**を決める
2. `① 開始位置を設定` ボタンで現在位置を保存
3. パレットから好きな動作を追加:
   - 左 / 右 360° / 180° / 90° / 45°、上 / 下 90° / 45°
   - ズームイン / アウト
   - ∞ 小さく / 大きく、停止
4. 各ステップの秒数は右側入力欄でいつでも変更
5. ▲▼ または `⠿` DnD で並び替え
6. `▶ ビューアで再生` で確認
7. `変換開始` でそのシーケンス通りの動画を生成

**JSON でエクスポート / インポート** できます:

- `⤓ エクスポート` で `camerawork_YYYYMMDD_HHMMSS.json` を保存（開始位置 + ステップ列）
- `⤒ インポート` で保存した JSON を読み込み（既存の定義は上書き確認あり）
- 別画像や別端末でカメラワークを再利用したり、複雑な動きをテンプレート化できます

VR180 / 魚眼 180° は前方半球しかないので、大きな回転や図 8 大を使うときは**先にズームイン**しておくと半球端で黒背景が見えるのを避けられます。

#### 5-C. ライブ録画モード

1. ビューアで自由に視点を動かせる状態にする
2. `● 録画開始` ボタンを押す（赤い REC インジケータ + 経過秒表示）
3. ドラッグ / ホイール / ピンチ / ジャイロで視点を動かす（= 録画される）
4. `■ 録画停止` で停止 → 即座にオフスクリーン再レンダーしてエンコード
5. 結果が `▶ プレビュー` / `ダウンロード` に表示される

録画中は画角変更（ピンチ）は無効（事前に決めた画角で録画）、画面回転も固定されます。出力解像度 / FPS / 品質 / 形式は上の動画変換セクションの設定を共有します。

### 6. プレビューとダウンロード

変換完了後:
- `▶ プレビュー` で WebP は `<img>` に、MP4 は `<video controls autoplay loop>` にインライン表示
- `ダウンロード` リンクから `.webp` / `.mp4` を保存

初回の変換では ffmpeg.wasm（約 30MB）の読み込みに時間がかかります。2 回目以降は Service Worker / ブラウザキャッシュで高速化、**オフラインでも動作**します。

### 7. PWA としてインストール

Service Worker が有効になると (初回オンライン訪問後):

- **Chrome / Edge (PC / Android)**: URL バー右端の「インストール」アイコンからアプリとしてインストール
- **iOS Safari**: 共有メニュー →「ホーム画面に追加」
- インストール後は単独ウィンドウで起動、オフラインでも完全動作

## プロジェクト構成

```
.
├── index.html            # 単一ページ UI
├── manifest.webmanifest  # PWA マニフェスト
├── sw.js                 # Service Worker（App Shell + CDN/WASM キャッシュ）
├── css/
│   └── style.css
├── js/
│   ├── app.js            # UI バインディング・状態管理（カメラワーク・録画・ジャイロ・JSON I/O）
│   ├── viewer.js         # Three.js ビューア + カメラワーク / 録画キャプチャ + ジャイロ
│   ├── converter.js      # パタパタ生成 + ffmpeg.wasm による WebP / MP4 エンコード
│   ├── heic.js           # libheif-js による MV-HEIC デコード
│   └── fisheye.js        # 180° 魚眼 (mono / SBS) を equirectangular 半球に展開
├── icons/
│   ├── favicon.png       # 64×64（ブラウザタブ）
│   ├── icon-192.png      # PWA 用 192×192
│   └── icon-512.png      # PWA 用 512×512
├── for_icon.png          # アイコン元画像（再生成用）
└── serve.py              # 開発用静的ファイルサーバー（ThreadingHTTPServer）
```

## 既知の制約

- 8K 以上の巨大な 360° 画像はブラウザのメモリ制限により扱えないことがあります
- Safari は WebXR 対応が限定的で、立体視機能は Chrome / Edge を推奨
- MP4 はコンテナレベルでループ情報を持たないため、配布先でのループ再生を期待する場合は WebP を選ぶこと
- **魚眼 180°**:
  - 射影モデルは equidistant 固定、円の中心 = 画像中央、半径 = 短辺/2、FOV = 180° の前提
  - 実写で歪む場合は撮影機材の射影（equisolid / stereographic 等）が異なる可能性あり
- **空間写真**:
  - iOS 26 の「空間シーン」（AI 深度による 2D→3D 変換）は非対応。本物のステレオペアを持つ **空間写真 (Spatial Photo)** のみ
  - MV-HEIC 内の spatial metadata（baseline / FOV / disparity）は未使用、FOV は Apple 標準の約 65° をハードコード
  - 平面ステレオなのでカメラワーク / 録画は利用不可（パタパタのみ）
- **ジャイロ**:
  - iOS は HTTPS 必須かつ初回タップで許可ダイアログ
  - デスクトップブラウザは `DeviceOrientationEvent` API が存在してもイベントが発火しないため、タッチ対応端末にのみ UI を表示
- **iOS Safari で HEIC（空間写真）をアップロードする場合**:
  - Safari は写真アプリから画像を選択すると **HEIC を自動的に JPEG へ変換**してアップロードする挙動があり、Apple 空間写真の MV-HEIC 構造（primary + ステレオペア 3 枚）が失われて立体視できなくなります
  - 本アプリは `accept="image/heic,image/heif,..."` を MIME タイプとして明示しているため多くのケースでは変換を回避できますが、iOS バージョンや Safari の挙動により変換される場合があります
  - 確実に HEIC のままアップロードするには、iOS の **写真 App →「共有」→「ファイルに保存」** で一度「ファイル」App に保存し、その後ファイル App からアップロードしてください
  - 代替案: 一度 PC / Mac に AirDrop・iCloud Drive 経由で HEIC を転送し、PC のブラウザでアップロード

## ライセンス

MIT

---

# spatial2flip (English)

A single-page web app that displays 360° / VR / Apple Spatial Photos / **180° fisheye** images in your browser, and exports them as looping videos — either through combined camera work (rotate / pause / zoom / figure-8), **live recording**, or **device-gyroscope-driven** viewing — or as pata-pata (flip) animations that alternate between the left and right eye views. Output is **Animated WebP / MP4 (H.264)**.

**PWA-ready.** After the first visit it runs fully offline and can be installed to your home screen as an app.

All processing runs inside your browser. Images are never uploaded to any server.

## Key Features

- **Simple Viewer**
  - **Supported formats**: 360° Mono / VR360 SBS / VR360 OU / VR180 SBS / VR180 OU / Fisheye 180° Mono / Fisheye 180° SBS / Apple Spatial Photo (MV-HEIC)
  - **Apple Spatial Photos** (MV-HEIC captured with iPhone 15 Pro+ / Apple Vision Pro) are auto-detected
  - **180° fisheye** images are automatically unwarped to an equirectangular hemisphere at load time (equidistant projection, centered circle, radius = min side / 2, FOV 180°, fixed)
  - Stereoscopic display on WebXR-capable browsers with a connected VR headset
  - Mouse / touch drag to look around; **mouse wheel or pinch** to zoom FOV
  - **Gyroscope**: on phone / tablet, tap the "📱 Gyro" button to aim the view by moving your device (iOS shows a permission dialog). Screen rotation is tracked live (and locked during recording).

- **Live Recording**
  - Record viewer interactions (drag / pinch / gyroscope) directly as a video
  - A red REC indicator + elapsed seconds are shown during recording
  - On stop, frames are re-rendered off-screen at the selected output resolution — not at viewer resolution — for a clean high-quality output

- **Camera Work Settings**
  - Save a start position (view + zoom) and build a sequence from freely combinable steps:
    - **Rotate**: Left/Right 360° / 180° / 90° / 45°, Up/Down 90° / 45°
    - **Zoom**: In / Out (log-space interpolation for constant-feeling zoom speed)
    - **Figure-8**: Horizontal ∞ (small / large). Completes one loop and returns exactly to center.
    - **Pause**: hold for N seconds
  - Each step's duration can be inline-edited; total time updates immediately
  - Reorder via ▲▼ buttons or drag the grip handle `⠿`
  - "▶ Preview" plays the sequence in the viewer before exporting (auto-scrolls if needed)
  - **JSON export / import**: save and reuse your camera work definition on different images or devices

- **Pata-pata (Flip) Animation**
  - For VR180 SBS/OU, Fisheye 180° SBS, and Spatial Photos without camera work steps, generates a video that rapidly alternates between the left and right eye views
  - Configurable number of cycles, interval, and quality

- **Output Formats**
  - **WebP**: infinite-loop animation (plays in a single `<img>`, SNS / messenger friendly)
  - **MP4 (H.264)**: yuv420p + faststart, SNS / iOS Safari friendly
  - "▶ Preview" plays the result inline after conversion; the file is downloadable

- **PWA (Offline Operation)**
  - On first visit, the Service Worker caches all dependencies (Three.js / ffmpeg.wasm / libheif) in the background
  - Subsequent visits work fully offline
  - Installable via the URL bar on Chrome / Edge, or via "Add to Home Screen" on iOS Safari

- **Fully Client-Side Processing**
  - Upload, rendering, and encoding all happen inside your browser
  - Nothing is uploaded to any server

## Tech Stack

| Library | Purpose |
|---|---|
| [Three.js](https://threejs.org/) r162 | Sphere mapping, WebXR stereoscopy, off-screen camera work / recording capture |
| [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) 0.12.10 | Encodes frame sets into WebP / MP4 via libwebp / libx264 |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.19.8 | Decodes Apple Spatial Photos (MV-HEIC) |
| Python 3 | Development static-file server (`serve.py`, `ThreadingHTTPServer`) |

No build step. Runs on plain HTML + ES Modules + CDN assets.

## Requirements

- **Browser**: latest Chrome / Edge recommended (full WebXR + ES Modules support). iOS Safari also works for the main features.
- **Python 3**: for local development. `file://` cannot run ES Modules / ffmpeg.wasm worker / Service Worker, so an HTTP server is required.
- **Network**: at first launch, Three.js (~600 KB) and the full ffmpeg.wasm bundle (~30 MB) are fetched from CDN. The Service Worker caches everything automatically, after which the app runs offline.
- **HTTPS**: required for production PWA deployment (`localhost` is exempt). Gyroscope on iOS also requires HTTPS.

## Usage

### 1. Launch

```bash
python serve.py
# → open http://localhost:8000 in your browser
```

Change port with `python serve.py 8080`.

Any static server works too:

```bash
# Node.js
npx serve .

# PHP
php -S localhost:8000
```

### 2. Upload an Image

- Drag and drop into the drop zone, or click to browse
- Accepted: JPG / PNG / WebP / HEIC (Apple Spatial Photo)
- Uploading a HEIC file automatically switches the format to "Spatial Photo"

### 3. Select Image Format

| Option | Expected Input |
|---|---|
| 360° Mono | 2:1 equirectangular image (standard 360° photo) |
| VR360 SBS | Stereo 360° image, left / right side-by-side |
| VR360 OU | Stereo 360° image, top / bottom |
| VR180 SBS | Stereo 180° image, left / right side-by-side |
| VR180 OU | Stereo 180° image, top / bottom |
| Fisheye 180° Mono | Circular fisheye image (assumes centered circle, radius = min side / 2, FOV 180°) |
| Fisheye 180° SBS | Stereo fisheye with two circular images side-by-side |
| Spatial Photo | iPhone 15 Pro+ / Apple Vision Pro MV-HEIC (normal-FOV stereo pair) |

For SBS / OU, "left / top = left eye" is the default convention. For spatial photos, image index 0 inside the MV-HEIC is treated as the left eye and index 1 as the right eye.

### 4. Preview

In the viewer area:

- **Drag**: rotate view (360° all directions; VR180 / fisheye 180° within the front hemisphere; spatial photo disables drag)
- **Mouse wheel / pinch**: zoom (FOV 25°–100°)
- **📱 Gyro** (mobile / tablet): tap to enable; the view then follows the device orientation
- **ENTER VR**: stereoscopic view on WebXR-capable browsers with a connected headset

### 5. Export a Video

**Output Format**: choose Animated WebP (looping) or MP4 (H.264).

#### 5-A. Simple Mode (no steps set)

**360° family (mono360 / sbs360 / ou360) / Fisheye 180° Mono:**

- Rotation time (1–30 sec)
  - 360° family: one full Y-axis rotation
  - Fisheye 180° Mono: 170° horizontal sweep (avoiding the hemisphere edges)
- FPS (10–60)
- Resolution (square or 16:9 presets)
- Quality

**VR180 family / Fisheye 180° SBS / Spatial Photo (sbs180 / ou180 / fisheyeSbs180 / spatial):**

- Cycle count (1–20 round trips)
- Switch interval (0.1–2 sec)
- Quality

→ Generates a pata-pata animation that alternates between the left and right eye views.

#### 5-B. Camera Work Mode

Available for every format except Spatial Photo.

1. Aim the viewer at your desired **start position** (view + zoom)
2. Click `① Set Start Position` to save the current view
3. Add steps from the palette:
   - Left / Right 360° / 180° / 90° / 45°, Up / Down 90° / 45°
   - Zoom In / Out
   - ∞ Small / Large, Pause
4. Edit each step's seconds inline at any time
5. Reorder with ▲▼ buttons or the `⠿` drag handle
6. `▶ Preview` to check the sequence
7. `Convert` to export a video matching the sequence

**JSON export / import** is available:

- `⤓ Export` saves `camerawork_YYYYMMDD_HHMMSS.json` (start + steps)
- `⤒ Import` loads a saved JSON (confirms before overwriting the current definition)
- Use it to reuse camera work across images / devices, or to save complex motion as a template

For VR180 / fisheye 180° (front-hemisphere only), **zoom in before running large rotations or the large figure-8**, otherwise you may see the black background at the hemisphere edges.

#### 5-C. Live Recording Mode

1. Prepare the viewer so you can freely aim it
2. Click `● Start Recording` (red REC indicator + elapsed seconds appears)
3. Drag / wheel / pinch / gyroscope to move the view (this is recorded)
4. Click `■ Stop Recording` → off-screen re-rendering + encoding starts immediately
5. Result appears under `▶ Preview` / `Download`

While recording, zoom changes via pinch are disabled (zoom is fixed to the initial value), and screen rotation is locked. Output resolution / FPS / quality / format share the settings from the Video Export section above.

### 6. Preview and Download

After conversion:
- `▶ Preview` shows WebP in an `<img>` tag and MP4 in a `<video controls autoplay loop>` tag, inline
- The `Download` link saves the `.webp` / `.mp4`

First-time conversion is slower because ffmpeg.wasm (~30 MB) is being loaded. Subsequent runs are fast thanks to Service Worker / browser cache — and they **work offline**.

### 7. Install as PWA

Once the Service Worker is active (after the first online visit):

- **Chrome / Edge (PC / Android)**: click the "Install" icon on the right edge of the URL bar
- **iOS Safari**: Share menu → "Add to Home Screen"
- After install, the app launches in its own window and runs fully offline

## Project Layout

```
.
├── index.html            # Single-page UI
├── manifest.webmanifest  # PWA manifest
├── sw.js                 # Service Worker (App Shell + CDN/WASM cache)
├── css/
│   └── style.css
├── js/
│   ├── app.js            # UI bindings / state (camera work, recording, gyro, JSON I/O)
│   ├── viewer.js         # Three.js viewer + camera work / recording capture + gyroscope
│   ├── converter.js      # Pata-pata generation + WebP / MP4 encoding via ffmpeg.wasm
│   ├── heic.js           # MV-HEIC decode via libheif-js
│   └── fisheye.js        # 180° fisheye (mono / SBS) unwarp to equirectangular hemisphere
├── icons/
│   ├── favicon.png       # 64×64 (browser tab)
│   ├── icon-192.png      # PWA 192×192
│   └── icon-512.png      # PWA 512×512
├── for_icon.png          # Source image for icons (for regeneration)
└── serve.py              # Development static-file server (ThreadingHTTPServer)
```

## Known Limitations

- Very large 360° images (8K+) may exceed browser memory limits
- Safari's WebXR support is limited; Chrome / Edge are recommended for stereoscopy
- MP4 has no container-level loop information; use WebP if loop playback is needed on the receiving end
- **Fisheye 180°**:
  - Projection model is fixed to equidistant; circle center = image center, radius = min side / 2, FOV = 180°
  - If real-world images look distorted, the capture gear may use a different projection (equisolid / stereographic / etc.)
- **Spatial Photo**:
  - iOS 26 "Spatial Scene" (AI-depth-based 2D→3D conversion) is **not supported**. Only true **Spatial Photos** with a real stereo pair are handled.
  - MV-HEIC spatial metadata (baseline / FOV / disparity) is unused; FOV is hard-coded to Apple's typical ~65°
  - Since the rendering is planar stereo, camera work / recording is not available (pata-pata only)
- **Gyroscope**:
  - iOS requires HTTPS and a permission dialog on first tap
  - Desktop browsers expose the `DeviceOrientationEvent` API but typically don't fire events; the UI is only shown on touch-capable devices
- **Uploading HEIC (Spatial Photos) from iOS Safari**:
  - Safari **auto-converts HEIC to JPEG** when you pick a photo from the Photos app, which destroys the MV-HEIC multi-image structure (primary + stereo pair) and makes stereoscopic viewing impossible
  - This app declares `accept="image/heic,image/heif,..."` as MIME types, which avoids the conversion in most cases. Depending on iOS version / Safari behavior the conversion may still occur.
  - To guarantee HEIC is preserved, on iOS go to **Photos → Share → Save to Files**, then upload from the Files app
  - Alternative: AirDrop / iCloud Drive the HEIC to a Mac or PC and upload from a desktop browser

## License

MIT
