// 180° 魚眼画像 → equirectangular 半球テクスチャへの展開。
// 仮定（最小構成）:
//   - 射影モデル: equidistant（r = θ / (π/2) × R）
//   - 円の中心 = 画像中心
//   - 円の半径 R = 短辺 / 2
//   - FOV = 180°（光軸からの最大角 = π/2）
// 将来、射影モデル／中心／半径／FOV を UI で微調整するなら opts で受けられるよう拡張する。

/**
 * モノラル 180° 魚眼画像を equirectangular 半球（1:1）に展開する。
 * @param {CanvasImageSource & { width: number, height: number }} source
 * @returns {HTMLCanvasElement}
 */
export function unwarpFisheye180Mono(source) {
  const sw = source.width || source.videoWidth;
  const sh = source.height || source.videoHeight;
  const outSize = Math.min(sw, sh);
  return _unwarpOne(source, 0, 0, sw, sh, outSize);
}

/**
 * SBS 180° 魚眼画像（左右に 2 眼分の魚眼円）を SBS equirectangular に展開する。
 * 出力は 2:1 の SBS VR180 互換（左半分 = 左眼、右半分 = 右眼）。
 * @param {CanvasImageSource & { width: number, height: number }} source
 * @returns {HTMLCanvasElement}
 */
export function unwarpFisheye180SBS(source) {
  const sw = source.width || source.videoWidth;
  const sh = source.height || source.videoHeight;
  const halfW = Math.floor(sw / 2);
  const eyeSize = Math.min(halfW, sh);

  const left = _unwarpOne(source, 0, 0, halfW, sh, eyeSize);
  const right = _unwarpOne(source, halfW, 0, halfW, sh, eyeSize);

  const out = document.createElement('canvas');
  out.width = eyeSize * 2;
  out.height = eyeSize;
  const ctx = out.getContext('2d');
  ctx.drawImage(left, 0, 0);
  ctx.drawImage(right, eyeSize, 0);
  return out;
}

// 1 眼分の unwarp 本体。
// source の (sx, sy, sw, sh) 領域を「片目の魚眼画像」とみなし、outSize×outSize の
// equirectangular 半球テクスチャを返す（上下左右それぞれ 180°）。
function _unwarpOne(source, sx, sy, sw, sh, outSize) {
  const srcCv = document.createElement('canvas');
  srcCv.width = sw;
  srcCv.height = sh;
  const srcCtx = srcCv.getContext('2d');
  srcCtx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  const srcPx = srcCtx.getImageData(0, 0, sw, sh).data;

  const cx = sw / 2;
  const cy = sh / 2;
  const R = Math.min(sw, sh) / 2;

  const out = document.createElement('canvas');
  out.width = outSize;
  out.height = outSize;
  const outCtx = out.getContext('2d');
  const dstImg = outCtx.createImageData(outSize, outSize);
  const dstPx = dstImg.data;

  const halfPi = Math.PI / 2;
  const invSize = 1 / (outSize - 1);

  for (let y = 0; y < outSize; y++) {
    const t = y * invSize;
    const pitch = halfPi - t * Math.PI;     // v=0 top=+π/2, v=1 bottom=-π/2
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    for (let x = 0; x < outSize; x++) {
      const u = x * invSize;
      const yaw = -halfPi + u * Math.PI;    // u=0 left=-π/2, u=1 right=+π/2
      const sYaw = Math.sin(yaw);
      const cYaw = Math.cos(yaw);
      // 3D 方向（前方 = +Z と仮定）。光軸は +Z。
      const dx = sYaw * cp;
      const dy = sp;
      const dz = cYaw * cp;

      const dstIdx = (y * outSize + x) * 4;
      // 後ろ向きや FOV 外は黒で埋める
      if (dz <= 0) { dstPx[dstIdx + 3] = 255; continue; }
      const theta = Math.acos(Math.min(1, Math.max(-1, dz)));
      if (theta > halfPi) { dstPx[dstIdx + 3] = 255; continue; }

      const alpha = Math.atan2(dy, dx);
      const rNorm = theta / halfPi;
      const fx = cx + rNorm * R * Math.cos(alpha);
      // 画像座標系は y 軸下向き → scene の上（+y）は画像の上（cy から引く）
      const fy = cy - rNorm * R * Math.sin(alpha);

      if (fx < 0 || fx >= sw - 1 || fy < 0 || fy >= sh - 1) {
        dstPx[dstIdx + 3] = 255;
        continue;
      }

      // バイリニア補間
      const fxi = fx | 0;
      const fyi = fy | 0;
      const wx = fx - fxi;
      const wy = fy - fyi;
      const iTL = (fyi * sw + fxi) * 4;
      const iTR = iTL + 4;
      const iBL = iTL + sw * 4;
      const iBR = iBL + 4;

      for (let c = 0; c < 3; c++) {
        const tl = srcPx[iTL + c];
        const tr = srcPx[iTR + c];
        const bl = srcPx[iBL + c];
        const br = srcPx[iBR + c];
        const top = tl + (tr - tl) * wx;
        const bot = bl + (br - bl) * wx;
        dstPx[dstIdx + c] = top + (bot - top) * wy;
      }
      dstPx[dstIdx + 3] = 255;
    }
  }

  outCtx.putImageData(dstImg, 0, 0);
  return out;
}
