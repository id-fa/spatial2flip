// ffmpeg.wasm を動的にロード（初回のみ。以降はキャッシュ）。
//
// クロスオリジン制約回避の経緯:
//   - esm.sh から直接 ESM を読み込むと、内部で new Worker(...) する際に
//     cross-origin Worker 制約でブラウザにブロックされる。
//   - 解決策: worker.js を fetch → 相対 import を絶対 URL に書き換え →
//     Blob URL に変換して classWorkerURL に渡す。これで Worker 自身は
//     ドキュメント同一オリジン（Blob URL）になる。
//   - コアは module worker で dynamic import されるため、UMD 版ではなく
//     export default を持つ ESM 版 (@ffmpeg/core/dist/esm/) を使う必要がある。

let ffmpegPromise = null;

const FFMPEG_BASE = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm';
const UTIL_BASE = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm';
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

async function buildWorkerBlobURL() {
  const resp = await fetch(`${FFMPEG_BASE}/worker.js`);
  if (!resp.ok) throw new Error(`worker.js fetch failed: ${resp.status}`);
  let code = await resp.text();
  // 相対 import を絶対 URL に書き換え（Blob URL 上では相対解決できないため）
  code = code.replace(
    /((?:\bfrom|\bimport)\s*\(?\s*)(["'])\.\/([^"']+)\2/g,
    (_m, prefix, quote, file) => `${prefix}${quote}${FFMPEG_BASE}/${file}${quote}`
  );
  return URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
}

function loadFFmpeg(onStatus) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      if (onStatus) onStatus('ffmpeg.wasm を読み込み中... (初回のみ 30MB 程度)');

      const [ffmpegMod, utilMod] = await Promise.all([
        import(`${FFMPEG_BASE}/index.js`),
        import(`${UTIL_BASE}/index.js`),
      ]);
      const { FFmpeg } = ffmpegMod;
      const { fetchFile, toBlobURL } = utilMod;

      const ffmpeg = new FFmpeg();

      const [coreURL, wasmURL, classWorkerURL] = await Promise.all([
        toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
        buildWorkerBlobURL(),
      ]);

      await ffmpeg.load({ coreURL, wasmURL, classWorkerURL });

      return { ffmpeg, fetchFile };
    })();
  }
  return ffmpegPromise;
}

/**
 * VR180 画像の左右半分を一定間隔で切り替えるパタパタアニメーション用フレームを生成。
 */
export async function captureVR180PataPata(image, format, options) {
  const { cycles = 5, interval = 0.3, fps = 30 } = options || {};
  const isSBS = format === 'sbs180';

  const halfW = isSBS ? Math.floor(image.width / 2) : image.width;
  const halfH = isSBS ? image.height : Math.floor(image.height / 2);

  // 出力サイズの上限（メモリ保護）
  const maxDim = 1280;
  let outW = halfW;
  let outH = halfH;
  if (outW > maxDim || outH > maxDim) {
    const scale = maxDim / Math.max(outW, outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }

  const leftCanvas = document.createElement('canvas');
  leftCanvas.width = outW;
  leftCanvas.height = outH;
  leftCanvas.getContext('2d').drawImage(
    image, 0, 0, halfW, halfH, 0, 0, outW, outH
  );

  const rightCanvas = document.createElement('canvas');
  rightCanvas.width = outW;
  rightCanvas.height = outH;
  const rx = isSBS ? halfW : 0;
  const ry = isSBS ? 0 : halfH;
  rightCanvas.getContext('2d').drawImage(
    image, rx, ry, halfW, halfH, 0, 0, outW, outH
  );

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');

  const framesPerHalf = Math.max(1, Math.round(interval * fps));
  const totalSwitches = cycles * 2; // 1 サイクル = L→R→L（2 回切替）
  const totalFrames = framesPerHalf * totalSwitches;
  const frames = [];

  for (let i = 0; i < totalFrames; i++) {
    const switchIdx = Math.floor(i / framesPerHalf);
    const isLeft = switchIdx % 2 === 0;
    ctx.drawImage(isLeft ? leftCanvas : rightCanvas, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92)
    );
    frames.push(blob);
  }

  return { frames, fps };
}

/**
 * JPEG フレーム群を動画（アニメーション WebP または MP4）に変換。
 *
 * @param {Blob[]} frames
 * @param {number} fps
 * @param {number} quality  WebP: 0-100 (高いほど高画質) / MP4: 同値を内部で CRF に変換
 * @param {'webp'|'mp4'} outputFormat
 */
export async function framesToVideo(frames, fps, quality, outputFormat, onProgress, onStatus) {
  const { ffmpeg, fetchFile } = await loadFFmpeg(onStatus);

  const progressHandler = ({ progress }) => {
    if (onProgress) onProgress(Math.min(1, Math.max(0, progress)));
  };
  ffmpeg.on('progress', progressHandler);

  const isMP4 = outputFormat === 'mp4';
  const outName = isMP4 ? 'output.mp4' : 'output.webp';
  const mimeType = isMP4 ? 'video/mp4' : 'image/webp';
  const statusLabel = isMP4 ? 'MP4' : 'WebP';

  const names = [];

  try {
    if (onStatus) onStatus('フレームを ffmpeg に渡しています...');
    for (let i = 0; i < frames.length; i++) {
      const name = `f${String(i).padStart(5, '0')}.jpg`;
      await ffmpeg.writeFile(name, await fetchFile(frames[i]));
      names.push(name);
    }

    if (onStatus) onStatus(`${statusLabel} にエンコード中...`);

    let args;
    if (isMP4) {
      // quality 0-100 を CRF 51-10 にマッピング（高画質ほど低 CRF）
      const crf = Math.max(10, Math.min(40, Math.round(40 - (quality / 100) * 30)));
      args = [
        '-framerate', String(fps),
        '-i', 'f%05d.jpg',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', String(crf),
        '-pix_fmt', 'yuv420p',
        // H.264 は偶数解像度必須。奇数サイズを来ても通るようパディング
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-movflags', '+faststart',
        '-an',
        outName,
      ];
    } else {
      args = [
        '-framerate', String(fps),
        '-i', 'f%05d.jpg',
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-q:v', String(quality),
        '-preset', 'default',
        '-loop', '0',
        '-an',
        '-vsync', '0',
        outName,
      ];
    }

    await ffmpeg.exec(args);

    const data = await ffmpeg.readFile(outName);
    return new Blob([data.buffer], { type: mimeType });
  } finally {
    try { ffmpeg.off('progress', progressHandler); } catch {}
    for (const name of names) {
      try { await ffmpeg.deleteFile(name); } catch {}
    }
    try { await ffmpeg.deleteFile(outName); } catch {}
  }
}

// 後方互換のためのエイリアス
export const framesToWebP = (frames, fps, quality, onProgress, onStatus) =>
  framesToVideo(frames, fps, quality, 'webp', onProgress, onStatus);
