// Apple 空間写真 (MV-HEIC) のデコード。libheif-js (WASM) を動的ロード。
//
// Apple 空間写真（iPhone 15 Pro+ / Apple Vision Pro）の HEIC 構造:
//   - 3 枚のトップレベル画像を含む:
//     1. primary: 2D 表示用の大きい画像（depth マップ埋め込み、例 5712×4284）
//     2. stereo left:  片眼用の中サイズ画像（例 2688×2016）
//     3. stereo right: 同一寸法のペア画像
//   - libheif-js の decoder.decode() は全画像を配列で返すが、順序と何が primary かは
//     明示されない。primary は「他と寸法が一致しない」一意の画像、stereo pair は
//     「同一寸法が 2 枚揃っている」組み合わせとして識別する。
//
// 方針:
//   - 全画像をデコードし、同一寸法で揃っている 2 枚をステレオペアとして採用
//   - どちらが左/右かは配列の出現順（= item ID 順）で決める（Apple の慣例に合わせる）
//   - 候補ペアが見つからないときはフォールバックで images[0] / images[1] を使う
//   - 単一画像のときは mono として左右に同じ画像を複製（立体感なし）
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
 * 複数画像の中からステレオペアを選ぶ。
 * Apple 空間写真は primary (2D/depth 入り) + 左右ペア（同一寸法）で構成される。
 * 同一寸法のペアが存在すればそれを採用、無ければフォールバックで先頭 2 枚。
 * 戻り値: { left: HeifImage, right: HeifImage } または null（画像が 0 枚のとき）
 */
function pickStereoPair(images) {
  if (!images || images.length === 0) return null;
  if (images.length === 1) return { left: images[0], right: images[0], pairFound: false };

  // 同一寸法ごとにグルーピング
  const groups = new Map();
  for (const img of images) {
    const key = `${img.get_width()}x${img.get_height()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(img);
  }

  // サイズが揃ったペアを探す（複数ペアがあれば面積が大きい方を優先）
  let bestPair = null;
  let bestArea = -1;
  for (const group of groups.values()) {
    if (group.length >= 2) {
      const area = group[0].get_width() * group[0].get_height();
      if (area > bestArea) {
        bestArea = area;
        bestPair = [group[0], group[1]];
      }
    }
  }

  if (bestPair) {
    // 元配列での出現順で左/右を決定（Apple の慣例: primary / left / right の順）
    const iA = images.indexOf(bestPair[0]);
    const iB = images.indexOf(bestPair[1]);
    const [left, right] = iA < iB ? [bestPair[0], bestPair[1]] : [bestPair[1], bestPair[0]];
    return { left, right, pairFound: true };
  }

  // 同一寸法ペアが無い: 先頭 2 枚をそのまま使う（従来互換）
  return { left: images[0], right: images[1], pairFound: false };
}

/**
 * HEIC / HEIF ファイルを読み込み、左右ペアを SBS 合成した Canvas を返す。
 * Apple 空間写真（primary + stereo pair 3 枚構造）では同一寸法のペアを自動選別し、
 * primary（depth 付き表示用）は無視する。
 * 単一画像しか含まれない HEIC の場合は左右を同じ画像で複製して返す（立体感はない）。
 */
export async function loadSpatialHeic(file) {
  const lib = await ensureLibheif();
  const buffer = await file.arrayBuffer();

  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(buffer);

  if (!images || images.length === 0) {
    throw new Error('HEIC のデコードに失敗しました / Failed to decode HEIC');
  }

  const pair = pickStereoPair(images);

  const leftCanvas = await heifToCanvas(pair.left);
  const rightCanvas = pair.right === pair.left
    ? leftCanvas
    : await heifToCanvas(pair.right);

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
  sbs.dataset.stereoPairFound = String(pair.pairFound);

  // 開発時にどの画像を採用したか分かるようログ出力
  const dims = images.map((i) => `${i.get_width()}×${i.get_height()}`).join(', ');
  console.info(
    `[spatial2flip] HEIC images: [${dims}] → `
    + `stereo pair: ${pair.pairFound ? `${w}×${h} × 2` : '(同一寸法ペアなし — fallback)'}`
  );

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
