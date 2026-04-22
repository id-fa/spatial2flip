# CLAUDE.md

このファイルは Claude Code（および他の AI アシスタント）がこのリポジトリで作業する際の指針です。

## プロジェクト概要

360° / VR / Apple 空間写真をブラウザ内で表示し、回転アニメーションまたは左右視差パタパタを **アニメーション WebP または MP4 (H.264)** として生成するシングルページ Web アプリ。すべてクライアントサイドで完結し、サーバー側の保存・処理は一切行わない。生成物は即時にインラインプレビュー可能。

## アーキテクチャ

ビルドステップなし。素の HTML / ES Modules / CDN のみで動作する。

```
index.html         # 単一ページ、ES Modules を importmap で解決
css/style.css
js/
  app.js           # エントリポイント。UI バインディングと状態管理
  viewer.js        # Three.js ベースのビューア + オフスクリーン回転キャプチャ + 平面ステレオ
  converter.js     # VR180 / 空間写真のパタパタ生成 + ffmpeg.wasm による WebP / MP4 エンコード
  heic.js          # libheif-js による MV-HEIC デコード + 左右 SBS 合成
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

### 4. カスタムポインタコントロール（OrbitControls 不使用）

360° 視点回転は「カメラ位置固定、向きのみ変更」が自然。OrbitControls は target を中心に orbit するため、target を原点近傍に置くハックが必要だが実装が煩雑。代わりに `lon/lat` → `lookAt(target)` の直接制御を採用（`viewer.js#_updateCameraRotation`）。

### 5. 360° 回転キャプチャはオフスクリーンレンダラで実行

メインビューアのインタラクションを阻害しないよう、`captureRotation` 内で独立した `WebGLRenderer` とカメラを生成し、同一シーンを異なるアングルで連続レンダリング → `canvas.toBlob('image/jpeg', 0.92)` で JPEG Blob として収集。

### 6. VR180 パタパタは 2D Canvas のみ

Three.js を使わず、入力画像の左右半分を別々の Canvas に描画し、一定間隔で交互に描画してフレームを生成（`converter.js#captureVR180PataPata`）。

### 7. Apple 空間写真は SBS 合成→平面ステレオで扱う

Apple 空間写真 (MV-HEIC) は VR180 とは投影・画角が異なる（通常画角 ~65°、直線投影）ため、球面マッピングは使えない。対応方針:

1. `heic.js#loadSpatialHeic` で libheif-js を使い左右画像を抽出
2. 左を `images[0]`、右を `images[1]` として SBS 合成した Canvas を生成（既存の sbs レイアウト処理フローに合流）
3. ビューアは `_setupPlanarStereo` で PlaneGeometry × 2 を layer 1/2 に配置、カメラの前方 1m に固定
4. パタパタ変換は SBS レイアウトとして `captureVR180PataPata` に流用（app.js で `layout = 'sbs180'` に書き換えて呼ぶ）
5. 360° 回転動画は不可（UI 側で spatial 選択時は `convert-360-options` を非表示）

平面ステレオ時は非 VR ドラッグ操作を無効化（`viewer.js#_setupControls` で `format === 'spatial'` を early return）。VR 時は world space に固定された Plane を WebXR カメラが見る。

### 8. 生成結果のインラインプレビュー

WebP アニメーションは `<img src="blob:...">` をセットするだけでブラウザがループ再生する。追加のプレイヤーライブラリは不要。MP4 は同じ container 内の `<video controls autoplay loop muted playsinline>` 要素に流し込む。`app.js` の preview-button ハンドラは `link.dataset.kind`（`image` / `video`）を見て `<img>` と `<video>` を出し分ける。

再変換や再アップロードでは `resetDownload()` から `URL.revokeObjectURL` で古い blob を確実に破棄している（放置するとメモリリーク）。video 側は `pause()` + `removeAttribute('src')` を忘れると blob が解放されず残り続ける。

### 9. 出力形式（WebP / MP4）の切り替え

UI の「出力形式」セレクタ (`#output-format`) で選択。`converter.js` の `framesToVideo(frames, fps, quality, outputFormat, ...)` が両方を扱う（旧 `framesToWebP` は後方互換のための薄いエイリアス）。

- **WebP**: `libwebp` + `-q:v <0-100>`（高いほど高画質）+ `-loop 0` で無限ループ
- **MP4**: `libx264` + `-crf <10-40>` + `-pix_fmt yuv420p` + `-vf pad=ceil(iw/2)*2:ceil(ih/2)*2` + `-movflags +faststart`
  - H.264 は偶数解像度必須 → `pad` フィルタで奇数サイズを救済
  - `yuv420p` は古いプレーヤー / SNS / iOS Safari 互換のため必須（省略するとサムネ非表示やデコード失敗が起きる）
  - `+faststart` で moov atom を先頭に配置し、ダウンロード途中でも再生開始可能
  - quality (UI の 0-100) → CRF の変換: `crf = round(40 - (quality/100) * 30)`（clamp 10-40）。quality=60→CRF 22、75→CRF 18、90→CRF 13

`@ffmpeg/core@0.12.6` は libx264 を同梱しているのでコア URL の差し替えは不要。

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
4. WebXR 対応環境で「ENTER VR」ボタンが有効化されるか、VR 時に左右の目に別画像が見えるか
5. 360° 変換が指定時間で一回転し、連続的な WebP アニメになるか
6. VR180 / spatial 変換で左右視差が指定間隔でパタパタ切り替わるか
7. 変換後に「▶ プレビュー」ボタンで即時にインライン再生できるか（WebP は `<img>`、MP4 は `<video>` で表示される）
8. ダウンロードされた WebP / MP4 が他アプリでも再生できるか
9. 出力形式セレクタを MP4 に切り替えた場合、拡張子 `.mp4` で保存され、奇数解像度（例 960×540 ではなく 961×541 相当のキャプチャ）でも H.264 エンコードが通るか

### よくある落とし穴

- **OU の上下割り当て**: `flipY=true`（Three.js デフォルト）のため、画像の上半分 = テクスチャ v ∈ [0.5, 1.0]。「top = 左目」の慣例を採用している。入力画像によっては逆のこともあるので、テストで逆転していたら offset/repeat を入れ替える
- **画像解像度の上限**: 8K 360° 画像などは `new THREE.Texture` でメモリ負荷が高い。必要に応じてリサイズキャップを入れる。空間写真は `heic.js` で 1 眼あたり 2048px にダウンサンプル済み
- **ffmpeg.wasm の一時ファイル**: `writeFile` / `readFile` / `deleteFile` の対で使う。`framesToWebP` の `finally` ブロックで必ず cleanup すること（エラー時にリークする）
- **MediaRecorder は未使用**: ffmpeg.wasm で WebP / MP4 を直接作るため、`canvas.captureStream` や `MediaRecorder` への依存はない
- **MP4 のループ再生はプレビューのみ**: `<video loop>` 属性でブラウザがループするだけで、MP4 ファイル自体にループ情報はない（WebP の `-loop 0` のようなコンテナレベルのループ指定は MP4 にはない）。ループ再生を期待する配布先では WebP を選ぶ
- **MP4 の音声**: 入力は静止画連番なので常に無音。`-an` を付けているが、仮に外すと音声ストリームなしで警告が出るだけなので実害はない
- **MP4 サイズの偶数化**: 現状 `pad=ceil(iw/2)*2:ceil(ih/2)*2` で右下に 1px 黒パディングが入り得る。視覚的にはほぼ不可視だが、完全な偶数入力を渡せば発生しない
- **libheif-js の API 形態**: `libheif-wasm/libheif-bundle.js` を `<script>` で読み込むと `window.libheif` が**そのまま**オブジェクト（`new libheif.HeifDecoder()` が呼べる状態）になる。factory 関数ではない。ただしバージョンによっては factory になる可能性もあるので `heic.js` では `typeof lib === 'function'` を両対応している
- **MV-HEIC のステレオ順序**: Apple は左目を primary (index 0)、右目を secondary (index 1) として格納する。他ソースの HEIC では順序が違う可能性があるので、立体感が反転していたら `heic.js` で `images[0]` と `images[1]` を入れ替える
- **Apple 空間シーン (Spatial Scene)**: iOS 26 の AI 深度による 2D→3D 変換は**非対応**。本物のステレオペアを持つ **空間写真 (Spatial Photo)** のみ扱う。空間シーンは深度マップ + 元画像で構成されるため、別アーキテクチャ（depth-based warping）が必要

## 外部ドキュメント

- Three.js WebXR: https://threejs.org/docs/#manual/en/introduction/How-to-create-VR-content
- ffmpeg.wasm API (v0.12): https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/packages/ffmpeg
- libwebp 入力オプション: https://ffmpeg.org/ffmpeg-codecs.html#libwebp
- WebXR Device API: https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API
- libheif-js README: https://github.com/catdad-experiments/libheif-js
- Apple 空間写真フォーマット仕様: https://developer.apple.com/documentation/imageio/creating-spatial-photos-and-videos-with-spatial-metadata
