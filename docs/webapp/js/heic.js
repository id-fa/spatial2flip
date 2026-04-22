// Apple 空間写真 (MV-HEIC) のデコード。libheif-js (WASM) を動的ロード。
//
// 方針:
//   - 左右 2 つの画像 (index 0 = 左目, 1 = 右目 が Apple の慣例) を抽出
//   - SBS レイアウトに合成した Canvas を返す（既存の sbs 処理フローに合流させるため）
//   - window.libheif が factory の場合と object の場合の両方に対応

const LIBHEIF_SRC = 'https://unpkg.com/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js';

let libheifPromise = null;

function ensureLibheif() {
  if (!libheifPromise) {
    libheifPromise = (async () => {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-libheif]`);
        if (existing) {
          if (window.libheif) {
            resolve();
          } else {
            existing.addEventListener('load', resolve);
            existing.addEventListener('error', () => reject(new Error('libheif-js script load failed')));
          }
          return;
        }
        const s = document.createElement('script');
        s.src = LIBHEIF_SRC;
        s.dataset.libheif = '1';
        s.onload = resolve;
        s.onerror = () => reject(new Error('libheif-js の読み込みに失敗しました'));
        document.head.appendChild(s);
      });

      let lib = window.libheif;
      if (typeof lib === 'function') {
        lib = await lib();
      }
      if (!lib || !lib.HeifDecoder) {
        throw new Error('libheif の初期化に失敗しました');
      }
      return lib;
    })();
  }
  return libheifPromise;
}

/**
 * HEIC / HEIF ファイルを読み込み、左右ペアを SBS 合成した Canvas を返す。
 * 単一画像しか含まれない HEIC の場合は左右を同じ画像で複製して返す（立体感はない）。
 */
export async function loadSpatialHeic(file) {
  const lib = await ensureLibheif();
  const buffer = await file.arrayBuffer();

  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(buffer);

  if (!images || images.length === 0) {
    throw new Error('HEIC のデコードに失敗しました');
  }

  const leftCanvas = await heifToCanvas(images[0]);
  const rightCanvas = images.length >= 2
    ? await heifToCanvas(images[1])
    : leftCanvas;

  const w = leftCanvas.width;
  const h = leftCanvas.height;

  // 出力が巨大になりすぎないよう 1 眼あたり 2048px に制限
  const maxDim = 2048;
  let outW = w;
  let outH = h;
  if (outW > maxDim || outH > maxDim) {
    const scale = maxDim / Math.max(outW, outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }

  const sbs = document.createElement('canvas');
  sbs.width = outW * 2;
  sbs.height = outH;
  const ctx = sbs.getContext('2d');
  ctx.drawImage(leftCanvas, 0, 0, w, h, 0, 0, outW, outH);
  ctx.drawImage(rightCanvas, 0, 0, rightCanvas.width, rightCanvas.height, outW, 0, outW, outH);

  // ビューア側で片眼アスペクトを使えるようメタデータを付与
  sbs.dataset.singleEyeAspect = String(outW / outH);
  sbs.dataset.eyeCount = String(images.length);

  return sbs;
}

async function heifToCanvas(heifImage) {
  const w = heifImage.get_width();
  const h = heifImage.get_height();
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(w, h);

  await new Promise((resolve, reject) => {
    heifImage.display(imageData, (displayData) => {
      if (displayData == null) {
        reject(new Error('HEIF display failed'));
      } else {
        resolve();
      }
    });
  });

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
