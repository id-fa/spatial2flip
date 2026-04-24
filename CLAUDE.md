# CLAUDE.md

このファイルは Claude Code（および他の AI アシスタント）がこのリポジトリで作業する際の指針です。

## プロジェクト概要

360° / VR / Apple 空間写真をブラウザ内で表示し、**カメラワーク**（左右 360/180/90/45° 回転・上下 90/45° 回転・ズームイン/アウト・8の字・停止）の組合せによる動画、または左右視差パタパタを **アニメーション WebP または MP4 (H.264)** として生成するシングルページ Web アプリ。すべてクライアントサイドで完結し、サーバー側の保存・処理は一切行わない。生成物は即時にインラインプレビュー可能。

## アーキテクチャ

ビルドステップなし。素の HTML / ES Modules / CDN のみで動作する。

```
index.html         # 単一ページ、ES Modules を importmap で解決
css/style.css
js/
  app.js           # エントリポイント。UI バインディングと状態管理（カメラワーク UI 含む）
  viewer.js        # Three.js ベースのビューア + オフスクリーンカメラワークキャプチャ + 平面ステレオ
                   # compileCameraSteps / evalCameraTimeline をモジュールレベルで export
  converter.js     # VR180 / 空間写真のパタパタ生成 + ffmpeg.wasm による WebP / MP4 エンコード
  heic.js          # libheif-js による MV-HEIC デコード + 左右 SBS 合成
  fisheye.js       # 180° 魚眼 (mono / SBS) を equirectangular 半球テクスチャに展開
sw.js              # PWA Service Worker（App Shell キャッシュ + CDN/WASM 事前取得 + cache-first）
manifest.webmanifest  # PWA マニフェスト
icons/favicon.png  # ブラウザタブ用 64x64
icons/icon-192.png # PWA 用 192x192（any maskable）
icons/icon-512.png # PWA 用 512x512（any maskable）
for_icon.png       # 元画像（1254x1254）。アイコン再生成用のソース
serve.py           # 開発サーバー（Python http.server ラッパー）
```

### 依存ライブラリ

すべて CDN から読み込み:

- Three.js r162（`importmap` 経由、`https://unpkg.com/three@0.162.0`）
- @ffmpeg/ffmpeg 0.12.10 / @ffmpeg/util 0.12.1 / @ffmpeg/core 0.12.6（dynamic import、`https://unpkg.com`）
- libheif-js 1.19.8（`<script>` タグ動的挿入、`window.libheif` グローバル）

## 重要な設計判断

### 1. Three.js のレイヤ分離による立体視

WebXR 対応のため、メッシュとカメラに `layers` を使う:

- **layer 0**: モノラル（両目共通）
- **layer 1**: 左目用
- **layer 2**: 右目用

メインカメラは `layer 0 + 1` を有効化（非 VR 時は左目を表示）。XR セッション開始時に左目カメラへ layer 1、右目カメラへ layer 2 を enable する（`viewer.js` の `sessionstart` イベント）。

### 2. 球体ジオメトリの `scale(-1, 1, 1)`

標準的な 360° ビューアパターン。X 軸方向を反転することで、カメラが球体の内側から見たときにテクスチャが正しい向きで表示される。

### 3. VR180 の半球ジオメトリ

`SphereGeometry(radius, ws, hs, -π, π, 0, π)` で前方 180° のみをカバー。`phi` の範囲 `[-π, 0]` が +X → -Z → -X を通る半球（= カメラ前方）になる。

### 4. カスタムポインタコントロール + YXZ Euler 回転（OrbitControls 不使用）

360° 視点回転は「カメラ位置固定、向きのみ変更」が自然。OrbitControls は target を中心に orbit するため、target を原点近傍に置くハックが必要だが実装が煩雑。代わりに `lon/lat` から直接カメラの回転を設定（`viewer.js#_updateCameraRotation`）。

**`lookAt` ではなく `YXZ` Euler 回転**を使う:

```js
this.camera.rotation.order = 'YXZ';
this.camera.rotation.set(degToRad(lat), degToRad(-lon), 0);
```

- lon 正 = 右向き（景色は左へ流れる）、lat 正 = 上向き
- `lookAt` 方式だと lat=±90°（真上・真下）で up ベクトル `(0,1,0)` と forward が並行になり NaN になるが、Euler 方式なら特異点なく ±90° まで到達可
- カメラワークの「上 90° / 下 90°」が正しく機能するために必須

ドラッグ操作は `lat` を ±85° にクランプ（誤操作防止）。カメラワーク再生・キャプチャは ±90° 以上まで許容。

### 5. マウスホイールで FOV ズーム

ビューア canvas 上の `wheel` イベントで `camera.fov` を `[25°, 100°]` の範囲で指数的に変化（`factor = exp(deltaY * 0.0015)`）。`wheel` は `{ passive: false }` で登録し `preventDefault()` してページスクロールを抑止。XR 中はスキップ（WebXR 側が FOV を制御するため）。`setImage` ごとに `fov` は `_baseFov=75` にリセット。

### 6. カメラワークのタイムラインモデル

カメラワークは「開始位置 (lon/lat/fov) + ステップ列」をタイムラインに展開して再生・キャプチャする。`viewer.js` の末尾に **module-level export** として実装:

```js
export function compileCameraSteps(steps, startView, fovMin, fovMax)
export function evalCameraTimeline(timeline, t)
```

**ステップスキーマ（`state.cameraSteps` の各要素）:**

```js
{ type: 'rotate',  axis: 'lon'|'lat', delta: 度, duration: 秒 }
{ type: 'pause',   duration: 秒 }
{ type: 'zoom',    direction: 'in'|'out', factor: 0.5|2.0, duration: 秒 }
{ type: 'figure8', size: 'small'|'large', ampLon: 度, ampLat: 度, duration: 秒 }
```

**compile の挙動:**

- ステップを順に走査し、現在の `(lon, lat, fov)` から各区間の `startLon/Lat/Fov` と `endLon/Lat/Fov` を生成して `segments` に push
- rotate: 該当軸に `delta` を加算、zoom: `fov *= factor`（`[fovMin, fovMax]` にクランプ）、pause: 変化なし、figure8: start=end（中心帰還）＋ ampLon/ampLat を保持
- `cursor` で区間の先頭時刻 `startTime` と終端 `endTime` を管理
- 戻り値: `{ segments, totalDuration }`

**eval の挙動:**

- `t` を受け取り該当セグメントを線形探索
- 通常セグメント: lon/lat は線形補間、fov は **対数空間線形補間**（`exp(lerp(log(a), log(b), t))`）で「一定速度のズーム」になる
- `type === 'figure8'`: Lissajous 曲線 `lon = startLon + ampLon·sin(2πt), lat = startLat + ampLat·sin(4πt)`。localT=0 と localT=1 で中心に戻るため次セグメントへの継目がガタつかない
  - 縦横比 2:1 の横長 ∞。小 = 10°×5°、大 = 30°×15°
  - VR180 での利用は事前ズームイン前提（半球端に触れやすい）

### 7. `captureCameraSequence` が正本、`captureRotation` はラッパー

オフスクリーンキャプチャは `captureCameraSequence({ steps, start, width, height, fps, onProgress })` が正本。独立した `WebGLRenderer` + `PerspectiveCamera`（`rotation.order = 'YXZ'`）でフレーム毎に `compileCameraSteps` / `evalCameraTimeline` から算出した `lon/lat/fov` を適用 → `canvas.toBlob('image/jpeg', 0.92)` で JPEG Blob として収集。

`captureRotation({ duration, ... })` は後方互換のためのラッパーで、内部で `{ type: 'rotate', axis: 'lon', delta: -360, duration }` を組み立てて委譲。

### 8. ビューアでのシーケンス再生（プレビュー）

`viewer.playCameraSequence(steps, { start, onEnd, onTick })` は `requestAnimationFrame` で進行し、毎フレーム `this._lon / this._lat / this.camera.fov` を書き換えるだけ。既存の `setAnimationLoop` が `_updateCameraRotation()` を呼んで描画を反映する。

- 再生開始時に開始位置にスナップ
- ユーザーが `pointerdown` / `wheel` すると `stopCameraPlayback()` で自動停止
- 再生中に format 切替 / 開始位置更新 / 変換開始すると停止

`app.js` 側は再生ボタン押下時に `ensureViewerVisible()` で `scrollIntoView({behavior: 'smooth'})` → `waitForScrollEnd()`（`scrollY` の安定 5 フレーム or タイムアウト 1.5s）してから再生開始する。スクロール待ち中に停止ボタンを押されたら再生キャンセル。

### 9. 開始位置の明示的な取得

カメラワークは必ず「開始位置 (lon, lat, fov)」を基準に相対的に動く。UI では `① 開始位置を設定` ボタンを押すまで他のステップ操作は全て disabled（`state.cameraStart === null` チェック）。押下時に `viewer.getCurrentView()` を保存。

- 360° では start を変えるとそこを起点に回転
- VR180 では「ズームイン＋中心を前方中央からずらす」で利用範囲を調整できる
- `simple` モード（回転時間のみ指定）は `cameraStart` を使わず `{ lon: 0, lat: 0, fov: 75 }` 固定起点で 1 回転または 170° スイープ

### 10. 動画生成は「モード × フォーマット」でルーティング

動画生成方式は `state.mode`（`'record' | 'simple' | 'camera' | 'patapata'`）と `state.format` の組合せで決まる。ユーザーが UI のタブで明示的にモードを選ぶ（ステップの有無で自動分岐しない）。

| mode | 使う API | 役割 |
|---|---|---|
| `record` | `viewer.captureRecordedSequence({samples})` | ビューア操作の録画軌跡を動画化 |
| `simple` | `viewer.captureCameraSequence([{rotate,-360 or -170,duration}], start={0,0,75})` | 1 回転の単純動画（360°）または 170° 水平スイープ（fisheyeMono180）|
| `camera` | `viewer.captureCameraSequence(state.cameraSteps, start=state.cameraStart)` | ユーザー定義のカメラワーク |
| `patapata` | `captureVR180PataPata(image, layout, {cycles, interval, fps})` | 左右視差の交互切替 |

`handleConvert` は `state.mode` を読んで分岐する（`app.js#handleConvert`）。

**フォーマット別の利用可能モード**（`getAvailableModes(format)`）:

| format | 利用可能モード |
|---|---|
| mono360 / sbs360 / ou360 / fisheyeMono180 | record / simple / camera |
| sbs180 / ou180 / fisheyeSbs180 | record / simple / camera / patapata |
| spatial | patapata のみ |

フォーマット変更で現在のモードが不可になった場合は `getDefaultMode(format)` にフォールバック（spatial / VR180 / fisheyeSbs → patapata、他 → simple）。既に有効なモードは維持する（ユーザーの選択を尊重）。

**UI レイアウト**:
- 動画変換カード先頭に **常時表示の共通パラメータ** (`.convert-common`): 出力形式 / 解像度 / FPS / 品質（デフォルト q=60）。パタパタモードでは解像度は無視され元画像サイズに追従する（パネル内に注記）
- 共通パラメータの下に 4 つの **モードタブ** (`input[name="mode"]` ラジオ + `.mode-tab` ラベル) と対応する **モードパネル** (`.mode-panel[data-mode=...]`)。利用不可タブは `hidden`、ロック中は `disabled`
- 共通「変換開始」ボタンがアクティブモードに応じて処理を振り分ける

**出力ファイル名 prefix** (`buildOutputPrefix()`):
- record: `recording_{360|vr180|fisheye180_mono|fisheye180_sbs}_*`
- camera: `{rotation360|vr180|fisheye180_mono|fisheye180_sbs}_camera_*`
- patapata: `{vr180|spatial|fisheye180_sbs}_patapata_*`
- simple: `rotation360_*` または `fisheye180_mono_*`

### 11. VR180 パタパタは 2D Canvas のみ

Three.js を使わず、入力画像の左右半分を別々の Canvas に描画し、一定間隔で交互に描画してフレームを生成（`converter.js#captureVR180PataPata`）。モードが `camera` または `simple` のときは（VR180 でも）Three.js 経由の `captureCameraSequence` を通る。

### 12. Apple 空間写真は SBS 合成→平面ステレオで扱う

Apple 空間写真 (MV-HEIC) は VR180 とは投影・画角が異なる（通常画角 ~65°、直線投影）ため、球面マッピングは使えない。対応方針:

1. `heic.js#loadSpatialHeic` で libheif-js を使い全画像をデコードし、`pickStereoPair` で **同一寸法で揃っている 2 枚をステレオペアとして自動選別**（primary の 2D/depth 画像は寸法が一意なので自動で除外される）
2. 左を `pair.left`、右を `pair.right` として SBS 合成した Canvas を生成（既存の sbs レイアウト処理フローに合流）
3. ビューアは `_setupPlanarStereo` で PlaneGeometry × 2 を layer 1/2 に配置、カメラの前方 1m に固定
4. パタパタ変換は SBS レイアウトとして `captureVR180PataPata` に流用（app.js で `layout = 'sbs180'` に書き換えて呼ぶ）
5. カメラワークは原理的に使えない（平面なので視点を回しても意味がない）→ UI で `convert-360-options` 全体を非表示

平面ステレオ時は非 VR ドラッグ操作を無効化（`viewer.js#_setupControls` で `format === 'spatial'` を early return）。VR 時は world space に固定された Plane を WebXR カメラが見る。

### 13. 魚眼 180° (mono / SBS) は読み込み時に equirectangular へ unwarp

魚眼 180° 画像は equirectangular とは射影が異なるため、球面へ直接貼ると歪む。そこで `fisheye.js` の `unwarpFisheye180Mono` / `unwarpFisheye180SBS` で **画像読み込み時／フォーマット切替時に一度だけ** equirectangular 半球テクスチャに変換し、以降は既存の VR180 パイプライン（mono180 半球 / sbs180 半球×2）に完全に乗せる。これにより録画・カメラワーク・ジャイロ・ピンチ・WebP/MP4 エンコードなどの既存機能がそのまま動く。

**仮定（最小構成）:**
- 射影モデル: equidistant（`r = θ / (π/2) × R`）
- 円の中心 = 画像中心
- 円の半径 = 短辺 / 2
- FOV = 180°（光軸からの最大角 = π/2）

SBS は入力画像を左右半分に分割 → 片眼ずつ unwarp → SBS レイアウトに合成 → 既存の `sbs180` 描画パスに流す。mono は全体を 1 眼として unwarp → 新規 `mono180` フォーマット（layer 0 の半球）で表示。

**app.js 側の統合:**
- `state.image` は元の魚眼画像を保持、`state.displayImage` に unwarp 済みを保持、`state.unwarpedMono` / `state.unwarpedSbs` がキャッシュ
- `applyViewerImage()` が format に応じて unwarp を実行 or スキップし viewer に渡す
- 変換フロー（`handleConvert`）は魚眼 SBS のパタパタで `state.displayImage` を渡す
- 魚眼モノラルは「パタパタ対象外」。カメラワーク無しのときのデフォルトは 360° 回転ではなく水平 170° スイープ（`delta = -170`）
- 出力ファイル名 prefix: `fisheye180_mono_*`, `fisheye180_sbs_patapata_*`, `fisheye180_{mono,sbs}_camera_*`

**非対応（意図的）:**
- 射影モデルの UI 切替（equisolid / stereographic / orthographic 等）
- 円の中心／半径／FOV の UI 調整
- 左右反転トグル
- 190° 以上の超広角

実写で歪みが気になるようならまず射影モデルセレクタから追加すると良い。

### 14. 生成結果のインラインプレビュー

WebP アニメーションは `<img src="blob:...">` をセットするだけでブラウザがループ再生する。追加のプレイヤーライブラリは不要。MP4 は同じ container 内の `<video controls autoplay loop muted playsinline>` 要素に流し込む。`app.js` の preview-button ハンドラは `link.dataset.kind`（`image` / `video`）を見て `<img>` と `<video>` を出し分ける。

再変換や再アップロードでは `resetDownload()` から `URL.revokeObjectURL` で古い blob を確実に破棄している（放置するとメモリリーク）。video 側は `pause()` + `removeAttribute('src')` を忘れると blob が解放されず残り続ける。

### 15. 出力形式（WebP / MP4）の切り替え

UI の「出力形式」セレクタ (`#output-format`) で選択。`converter.js` の `framesToVideo(frames, fps, quality, outputFormat, ...)` が両方を扱う（旧 `framesToWebP` は後方互換のための薄いエイリアス）。

- **WebP**: `libwebp` + `-q:v <0-100>`（高いほど高画質）+ `-loop 0` で無限ループ
- **MP4**: `libx264` + `-crf <10-40>` + `-pix_fmt yuv420p` + `-vf pad=ceil(iw/2)*2:ceil(ih/2)*2` + `-movflags +faststart`
  - H.264 は偶数解像度必須 → `pad` フィルタで奇数サイズを救済
  - `yuv420p` は古いプレーヤー / SNS / iOS Safari 互換のため必須（省略するとサムネ非表示やデコード失敗が起きる）
  - `+faststart` で moov atom を先頭に配置し、ダウンロード途中でも再生開始可能
  - quality (UI の 0-100) → CRF の変換: `crf = round(40 - (quality/100) * 30)`（clamp 10-40）。quality=60→CRF 22、75→CRF 18、90→CRF 13

`@ffmpeg/core@0.12.6` は libx264 を同梱しているのでコア URL の差し替えは不要。

### 16. PWA オフライン対応（Service Worker）

インストール可能 PWA として動作し、**初回訪問後は完全オフラインで動く**（CDN 上の Three.js / ffmpeg.wasm / libheif まで含む）。

**構成:**
- `manifest.webmanifest` — name / start_url / display=standalone / theme_color / 192×192 と 512×512 の PNG（`purpose: "any maskable"`）
- `sw.js` — Service Worker。install/activate/fetch の 3 ハンドラ
- `icons/` — `for_icon.png`（1254×1254 の元画像）から Pillow で生成。`Image.quantize(256)` + `optimize=True, compress_level=9` で写真系でも 512×512 / 62KB に収まる。元画像のデザイン（黒枠＋黄色矩形＋中央のキャラ）は周辺 10〜15% が装飾枠なので Android のマスク適用で一部が切り取られても主役は残る

**キャッシュ戦略:**
- `install`: 同一オリジンの App Shell（HTML/CSS/JS/manifest/icon）を `cache.addAll`
- `activate`: 古いキャッシュ掃除 + `skipWaiting`/`clients.claim` + **CDN の主要資産（Three.js / ffmpeg 本体 / ffmpeg-core.js / ffmpeg-core.wasm / util / libheif-bundle.js）をバックグラウンド事前取得**
- `fetch`: cache-first、ネットワーク取得成功時は自動でキャッシュ追加（= 初回 on-demand に触れた内部 sub-dep も自動でキャッシュされる）
- `navigate`: キャッシュ優先 + オフライン時は `./index.html` にフォールバック

**重要な設計判断:**
- CDN からの事前取得 URL は `converter.js` / `heic.js` / `index.html` の importmap と**文字列一致**必須。バージョンアップ時は `sw.js` の `OFFLINE_CDN` も同時更新し、`CACHE_VERSION` を上げて古いキャッシュを掃除する（= cache-first ゆえに古い URL がキャッシュ残存すると stale を返し続けるため）
- ffmpeg の `worker.js` は converter.js 内で fetch → 相対 import を絶対 URL に書き換え → Blob URL 化しており、この「元の fetch」が SW を通るのでキャッシュされる。Blob URL 自体は SW の制御下にない点に注意
- libheif の `.wasm` は `libheif-bundle.js` に埋め込まれている（単一ファイル）ため別途 `.wasm` URL を事前取得する必要はない
- `serve.py` は **ThreadingHTTPServer 必須**。シングルスレッドだと SW install 中の並行 fetch（`sw.js` 自身の取得と App Shell の取得）でデッドロックし、install が永久に完了しない
- `serve.py` は `/sw.js` に対して `Service-Worker-Allowed: /` ヘッダを付与（将来サブディレクトリ配置しても scope 変更可能に）

**PWA 化の前提:**
- HTTPS 必須（`localhost` は例外）
- `start_url` と `scope` は相対 URL で記述（GitHub Pages など任意パスにホストされても動く）

### 17. カメラワーク定義の JSON エクスポート/インポート

カメラワーク（`state.cameraStart` + `state.cameraSteps`）を JSON でファイル保存／復元できる。配布や複数画像間の再利用、バックアップ用途。

**JSON スキーマ（`spatial2flip-camerawork/1`）:**
```json
{
  "schema": "spatial2flip-camerawork/1",
  "exportedAt": "2026-04-23T14:30:00.000Z",
  "start": { "lon": 0, "lat": 0, "fov": 75 },
  "steps": [
    { "type": "rotate", "axis": "lon", "delta": -360, "duration": 10 },
    { "type": "pause", "duration": 2 },
    { "type": "zoom", "direction": "in", "factor": 0.5, "duration": 3 },
    { "type": "figure8", "size": "small", "ampLon": 10, "ampLat": 5, "duration": 5 }
  ]
}
```

**実装要点:**
- `app.js#validateCameraWorkJSON` で厳格バリデーション（schema 文字列、start の lon/lat/fov が数値、steps が配列、各 step の type / duration / 型別必須フィールドを確認）。どの step の何が不正かを日本語メッセージで alert
- エクスポート時に内部 `id` は含めず、インポート時に再採番（`state.cameraStepIdSeq`）
- インポート時に既存の cameraStart または steps がある場合は confirm で上書き確認
- ファイル名 prefix: `camerawork_YYYYMMDD_HHMMSS.json`
- 互換のため `schema` フィールドは省略可（ただし指定があれば `spatial2flip-camerawork/` で始まる必要）
- 将来スキーマ変更時は `schema: "spatial2flip-camerawork/2"` に上げてインポート時分岐を足す

### 18. カメラワーク UI の並び替え（DnD + ボタン両対応）

各ステップ行に:
- **グリップ (`⠿`)** でドラッグ。`li.draggable` はデフォルト `false`、`mousedown` がグリップ上のときだけ `true` に切り替える（ラベル・秒数 input・▲▼・× の操作と干渉しない）
- **▲▼ ボタン** で隣接スワップ
- **秒数 input** で duration だけ in-place 編集（`change` イベントで state を書き換え、list 全体は再 render しない＝フォーカス維持）
- **×** で削除

並び替え完了時は `flashCameraStepRows([...ids])` で該当 li に `is-swapped` クラスを付け、`@keyframes camera-step-flash` を 1 回だけ再生（移動したことを視覚フィードバック）。DnD 時は `drop-before` / `drop-after` 擬似要素で挿入位置を青ライン表示。

### 19. 録画モードは「停止 → 保持 → 変換」の 2 段階フロー

以前は録画停止と同時に変換が走り、品質・FPS・解像度の調整ができなかった。現在は:

1. 録画停止 → samples を `state.pendingRecordSamples = { samples, duration }` に保持するだけ
2. ユーザーが共通パラメータ（出力形式 / 解像度 / FPS / 品質）を調整
3. 「変換開始」ボタン押下時に `handleConvert` が `state.mode === 'record'` 分岐で `viewer.captureRecordedSequence()` を実行

**保持データの破棄トリガー:**
- 画像再アップロード（`loadImage`）
- フォーマット切替（viewpoint の意味が変わる可能性があるため）
- 新しい録画の開始（古いデータを破棄してから開始）
- 録画タブの「✕ 録画を破棄」ボタン

**UI 配置の非自明点:**
- `#record-start` / `#record-discard` は録画タブパネル内
- `#record-stop` は `#viewer-buttons`（ビューア直下）にある。録画中にユーザーがビューアをドラッグしていてタブまでスクロールで戻らなくても停止できるようにするため
- 両方の record-stop を作らない：ID はユニーク、JS は `getElementById('record-stop')` で取得

### 20. 画像未登録でも UI は全表示、ボタンだけ disable

初回訪問者がアプリの機能を把握できるよう、`#after-upload` は最初から可視。`state.image` が null の間:
- 「変換開始」ボタン → `updateConvertButtonEnabled()` が `!!state.image` で disable
- 「録画開始」ボタン → `updateRecordPanelUI()` が `!state.image` で disable、ステータスに「画像をアップロードしてください」を表示
- ビューア canvas は黒背景のまま。`#viewer-placeholder`（⇪ アイコン + "画像をドロップしてください"）をオーバーレイ表示
- 画像読込成功時に `#viewer` へ `has-image` クラスを付与 → CSS が `.viewer-placeholder { display: none }` で非表示に

カメラワークの「① 開始位置を設定」は画像なしでもクリック可能（`getCurrentView()` がデフォルト lon/lat/fov を返すため）。ステップを組んで JSON エクスポートする用途もあり、意図的に image-less でも動くように残している。

### 21. busy 状態の一元管理とタブ／フォーマットロック

`isBusy()` が録画中 / カメラワーク再生中 / 変換中の OR を返す単一のゲートとなる:

```js
function isBusy() {
  if (state.viewer.isRecording()) return true;
  if (state.viewer.isPlayingSequence()) return true;
  return !!state.isConverting;
}
```

`updateConvertUI()` がこれを見て:
- モードタブのラジオ `disabled` を切替
- フォーマットラジオの `disabled` を切替
- カメラワーク編集ボタン群の `disabled` を切替
- 「変換開始」「録画開始」の `disabled` を切替

**タイミング注意:** `viewer.playCameraSequence()` は同期的に内部フラグを立てるので、呼出 **後** に `updateConvertUI()` を呼ぶ必要がある。呼出前だと `isPlayingSequence()` がまだ false で、ロックがかからない。`captureRecordedSequence` / `captureCameraSequence` は async だが、`state.isConverting` を呼出前に立てて `try/finally` で戻すので同じ問題は起きない。

### 22. ラベルの日本語／英語 1 行表示と入力レイアウト

`.options label` は `display: flex; flex-direction: column` なので、子要素が直接テキスト・span・input と並んでいると **それぞれが別の flex 行** になり、「出力形式 / Output Format [select]」が 3 行に割れる。

対策として、HTML でテキスト + `.en` span を `<span class="label-text">` で 1 つにラップし、input + unit span を `<span class="label-control">` でラップする:

```html
<label>
  <span class="label-text">回転時間 <span class="en">/ Rotation Time</span></span>
  <span class="label-control">
    <input type="number" ...>
    <span class="unit">秒 / sec</span>
  </span>
</label>
```

`.label-text` は `white-space: nowrap` で JA/EN を必ず同一行に（グリッド幅 minmax(200px,1fr) に収まる前提）。`.label-control` は `display: flex` で input + unit を横並びに。

新しい数値入力系 UI を `.options` 内に足すときはこの構造に合わせること。

## ffmpeg.wasm のクロスオリジン Worker 問題（非自明）

### 問題

`@ffmpeg/ffmpeg` v0.12 は内部で `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })` を呼ぶ。esm.sh や jsdelivr など一部 CDN 経由で ESM をロードすると、Chrome は cross-origin module worker の生成を拒否する（`Failed to construct 'Worker': Script at '...' cannot be accessed from origin '...'`）。

### 解決策（`converter.js` に実装済み）

1. **unpkg から素の ESM を読み込む**: 相対 import でも CORS ヘッダが通るため ESM 解決が機能する
2. **worker.js を fetch し、相対 import を絶対 URL に書き換えて Blob URL 化** → `classWorkerURL` に渡す
3. **Blob URL は作成元ドキュメントと同一オリジン扱い** → Worker 生成が許可される
4. **コアは UMD ではなく ESM 版を使う**: module worker では `importScripts` が投げ、フォールバックの `await import(coreURL).default` が走る。UMD 版は `export default` を持たないため ESM 版（`dist/esm/ffmpeg-core.js`）必須

**触るな危険**: この fetch + 正規表現書き換え + Blob URL の一連の流れは ffmpeg.wasm の内部実装に依存している。ffmpeg.wasm のバージョンアップ時は worker.js の import 文とコア読み込みロジックを再確認すること。

### 関連する正規表現

```js
/((?:\bfrom|\bimport)\s*\(?\s*)(["'])\.\/([^"']+)\2/g
```

worker.js 内の `import { X } from "./const.js"` や `import("./foo.js")` パターンにマッチし、unpkg の絶対 URL に置換する。

## 開発手順

### ローカル起動

```bash
python serve.py      # http://localhost:8000
python serve.py 8080 # ポート指定
```

`file://` 直開きでは動かない（ES Modules と ffmpeg.wasm Worker が HTTP context 必須）。

### 動作確認

ビルドやテストスイートはない。ブラウザ（Chrome / Edge）で以下を手動確認:

1. 各フォーマット（mono360 / sbs360 / ou360 / sbs180 / ou180 / spatial）で画像が球面または平面に正しく貼られているか
2. HEIC ファイルを落とすと自動で spatial に切り替わり、左右がずれて立体視できるか
3. ドラッグ操作で視点が自然に回るか（spatial はドラッグ無効）
4. マウスホイールで拡大・縮小ができるか（25°〜100° FOV クランプ、フォーマット切替で 75° にリセット）
5. WebXR 対応環境で「ENTER VR」ボタンが有効化されるか、VR 時に左右の目に別画像が見えるか
6. **モード UI**:
   - 画像未登録でも UI は全表示（ビューアはプレースホルダー）、録画開始・変換開始ボタンだけ disable
   - mono360 系は 3 タブ、VR180/fisheyeSbs は 4 タブ、spatial はパタパタタブのみ表示
   - フォーマット変更で現モードが不可になれば自動フォールバック、有効なモードは維持
7. **カメラワーク** (`camera` モード):
   - 開始位置未設定時、全てのステップ追加／プレビュー／全削除ボタンが disabled
   - ビューアを動かしてから開始位置を設定するとステータスが緑で表示される
   - ±360/180/90/45° / 上下 90/45° / ズームイン/アウト / 図 8 小/大 / 停止 を組合せて追加できる
   - 各行の秒数 input で duration を即時変更、合計時間も即座に更新
   - ▲▼ / DnD（グリップ `⠿`）で並び替え、移動した行が青くフラッシュ
   - 「▶ ビューアで再生」でビューアが画面内に収まっていなければスクロール後に再生、開始位置にスナップして進行
   - 再生中に canvas をドラッグ／ホイールで自動停止、モードタブ・フォーマット・変換開始も自動ロック
   - 上下 90° で真上・真下が正しく表示される（Euler YXZ 方式）
8. **録画** (`record` モード):
   - 「録画開始」でビューア上に REC インジケータ、ビューア直下に「録画停止」ボタンが出現
   - 停止→「録画データ保持中: X.X 秒 / N サンプル」表示、即座に変換は走らない
   - 共通パラメータ（品質／FPS／解像度）を調整してから「変換開始」で動画生成
   - フォーマット変更・画像再アップロード・新しい録画開始・✕ ボタンで保持データが破棄される
9. **かんたん** (`simple` モード): 360° は指定秒数で一回転、fisheyeMono180 は 170° 水平スイープ
10. **パタパタ** (`patapata` モード): 左右視差を指定間隔・サイクル数で交互切替（VR180 / fisheyeSbs / spatial）
11. 図 8 ステップ前後で lon/lat が正しく中心に戻り、連続ステップで継目がガタつかないか
12. ズームステップが対数補間で一定速度に感じられるか（線形だと終盤に急加速して見える）
13. 録画・再生・変換中にモードタブ／フォーマットラジオが disabled になるか
14. 変換後に「▶ プレビュー」ボタンで即時にインライン再生できるか（WebP は `<img>`、MP4 は `<video>` で表示される）
15. ダウンロードされた WebP / MP4 が他アプリでも再生できるか
16. 出力形式セレクタを MP4 に切り替えた場合、拡張子 `.mp4` で保存され、奇数解像度（例 960×540 ではなく 961×541 相当のキャプチャ）でも H.264 エンコードが通るか

### よくある落とし穴

- **OU の上下割り当て**: `flipY=true`（Three.js デフォルト）のため、画像の上半分 = テクスチャ v ∈ [0.5, 1.0]。「top = 左目」の慣例を採用している。入力画像によっては逆のこともあるので、テストで逆転していたら offset/repeat を入れ替える
- **画像解像度の上限**: 8K 360° 画像などは `new THREE.Texture` でメモリ負荷が高い。必要に応じてリサイズキャップを入れる。空間写真は `heic.js` で 1 眼あたり 2048px にダウンサンプル済み
- **ffmpeg.wasm の一時ファイル**: `writeFile` / `readFile` / `deleteFile` の対で使う。エラー時にリークしないよう `finally` ブロックで必ず cleanup すること
- **MediaRecorder は未使用**: ffmpeg.wasm で WebP / MP4 を直接作るため、`canvas.captureStream` や `MediaRecorder` への依存はない
- **MP4 のループ再生はプレビューのみ**: `<video loop>` 属性でブラウザがループするだけで、MP4 ファイル自体にループ情報はない（WebP の `-loop 0` のようなコンテナレベルのループ指定は MP4 にはない）。ループ再生を期待する配布先では WebP を選ぶ
- **MP4 の音声**: 入力は静止画連番なので常に無音。`-an` を付けているが、仮に外すと音声ストリームなしで警告が出るだけなので実害はない
- **MP4 サイズの偶数化**: 現状 `pad=ceil(iw/2)*2:ceil(ih/2)*2` で右下に 1px 黒パディングが入り得る。視覚的にはほぼ不可視だが、完全な偶数入力を渡せば発生しない
- **libheif-js の API 形態**: `libheif-wasm/libheif-bundle.js` を `<script>` で読み込むと `window.libheif` が**そのまま**オブジェクト（`new libheif.HeifDecoder()` が呼べる状態）になる。factory 関数ではない。ただしバージョンによっては factory になる可能性もあるので `heic.js` では `typeof lib === 'function'` を両対応している
- **MV-HEIC の画像構造**: Apple 空間写真は HEIC 内に **3 枚**のトップレベル画像を持つ: (1) primary = 2D 表示用の大きい画像（depth マップ埋め込み、例 5712×4284）、(2) 左眼ステレオ画像（中サイズ、例 2688×2016）、(3) 右眼ステレオ画像（同一寸法）。`libheif-js` の `decoder.decode()` は 3 枚すべてを配列で返すため、素朴に `images[0]` / `images[1]` を取ると左眼に primary が入り「左半分だけ表示される／パタパタが視差にならない」症状が出る。`heic.js#pickStereoPair` は同一寸法ペアを自動検出し、primary（寸法がペアと異なる）を捨てる。Apple の慣例で primary → left → right の順に並ぶので、配列出現順で左右を決定。立体感が反転していたら `pair.left` と `pair.right` を入れ替える
- **Apple 空間シーン (Spatial Scene)**: iOS 26 の AI 深度による 2D→3D 変換は**非対応**。本物のステレオペアを持つ **空間写真 (Spatial Photo)** のみ扱う。空間シーンは深度マップ + 元画像で構成されるため、別アーキテクチャ（depth-based warping）が必要
- **lookAt 禁止**: `_updateCameraRotation` を `camera.lookAt(x,y,z)` に戻すと lat=±90° で NaN が出て画面が真っ黒になる。必ず `rotation.order = 'YXZ'` の Euler で `rotation.set(pitch, -yaw, 0)` を使うこと（カメラワークの「上下 90°」はこの前提）
- **fov 補間は対数空間**: `evalCameraTimeline` で zoom 区間は `exp(lerp(log(a), log(b), t))`。線形補間だと終盤に急加速するため、既に実装されているこの挙動を変えないこと
- **figure-8 は start=end**: `compileCameraSteps` で figure-8 セグメントは `endLon=startLon, endLat=startLat`（中心帰還）。Lissajous の `sin(0)=sin(2π)=0` に依存しているので duration 端の扱いを変えると継目がガタつく
- **VR180 での広角カメラワーク**: VR180 は前方半球しかないので、`cameraStart.fov` を絞らずに大振幅（±180° lon / 図 8 大）を使うと黒背景が見えてしまう。UI 側で警告は出していないが、動作は壊れない
- **カメラワーク状態のライフサイクル**: `state.cameraStart` と `state.cameraSteps` はフォーマット切替や再アップロードでも保持される（ユーザが明示的に更新・削除するまで）。setImage は viewer 内の `_lon/_lat/fov` をリセットするが、これらは別軸
- **録画 samples のライフサイクル**: `state.pendingRecordSamples` は **画像再アップロード / フォーマット切替 / 新規録画開始 / 録画タブの ✕ ボタン** のいずれかで破棄。モードタブの切替では保持される（パラメータ調整のため別タブに行って戻ってきても残っている必要があるため）
- **busy 状態更新のタイミング**: `viewer.playCameraSequence()` は同期的に内部フラグを立てるため、`updateConvertUI()` は **呼出の後** に走らせないと `isPlayingSequence()` がまだ false のままでロックが掛からない。`captureRecordedSequence` / `captureCameraSequence` は async なので代わりに `state.isConverting = true` を呼出前にセットして `try/finally` で戻す（ここは順序を変えないこと）
- **モード UI の labels は 3 段構成**: `.options label` は `display: flex; flex-direction: column`。子要素として生テキスト + `<span class="en">` を並べると**各々が別行**になってしまうため、必ず `<span class="label-text">...</span>` と `<span class="label-control">[input]<span class="unit">...</span></span>` でラップすること

## 外部ドキュメント

- Three.js WebXR: https://threejs.org/docs/#manual/en/introduction/How-to-create-VR-content
- Three.js Euler: https://threejs.org/docs/#api/en/math/Euler
- ffmpeg.wasm API (v0.12): https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/packages/ffmpeg
- libwebp 入力オプション: https://ffmpeg.org/ffmpeg-codecs.html#libwebp
- WebXR Device API: https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API
- libheif-js README: https://github.com/catdad-experiments/libheif-js
- Apple 空間写真フォーマット仕様: https://developer.apple.com/documentation/imageio/creating-spatial-photos-and-videos-with-spatial-metadata
- Lissajous 曲線（図 8 パラメトリック式の参考）: https://en.wikipedia.org/wiki/Lissajous_curve
