import { Viewer } from './viewer.js';
import { captureVR180PataPata, framesToWebP } from './converter.js';
import { loadSpatialHeic } from './heic.js';

const state = {
  image: null,
  imageUrl: null,
  format: 'mono360',
  viewer: null,
};

function init() {
  const viewerContainer = document.getElementById('viewer');
  state.viewer = new Viewer(viewerContainer);

  document.getElementById('vr-button-container')
    .appendChild(state.viewer.createVRButton());

  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) loadImage(e.target.files[0]);
  });

  const dropZone = document.getElementById('drop-zone');
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) loadImage(e.dataTransfer.files[0]);
  });

  document.querySelectorAll('input[name="format"]').forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) {
        state.format = r.value;
        if (state.image) state.viewer.setImage(state.image, state.format);
        updateConvertUI();
      }
    });
  });

  document.getElementById('convert-button').addEventListener('click', handleConvert);

  const previewBtn = document.getElementById('preview-button');
  const previewContainer = document.getElementById('preview-container');
  const previewImg = document.getElementById('preview-img');
  previewBtn.addEventListener('click', () => {
    const link = document.getElementById('download-link');
    if (!link.href) return;
    if (previewContainer.hidden) {
      previewImg.src = link.href;
      previewContainer.hidden = false;
      previewBtn.textContent = '■ プレビューを閉じる';
    } else {
      previewContainer.hidden = true;
      previewImg.removeAttribute('src');
      previewBtn.textContent = '▶ プレビュー';
    }
  });

  updateConvertUI();
}

function isHeicFile(file) {
  return /\.(heic|heif)$/i.test(file.name) || /image\/(heic|heif)/i.test(file.type);
}

async function loadImage(file) {
  const heic = isHeicFile(file);
  if (!heic && !file.type.startsWith('image/')) {
    alert('画像ファイルを選択してください');
    return;
  }

  const progressEl = document.getElementById('progress');
  const progressText = document.getElementById('progress-text');
  const progressBar = document.getElementById('progress-bar');

  try {
    let imageSource;

    if (heic) {
      document.getElementById('after-upload').hidden = false;
      progressEl.hidden = false;
      progressBar.removeAttribute('value'); // indeterminate
      progressText.textContent = 'HEIC をデコード中... (初回は libheif-js を読み込みます)';
      imageSource = await loadSpatialHeic(file);
      progressEl.hidden = true;
      progressBar.value = 0;

      // 空間写真を読み込んだら自動で spatial フォーマットに切替
      selectFormat('spatial');
    } else {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
      state.imageUrl = url;
      imageSource = img;
    }

    state.image = imageSource;
    state.viewer.setImage(imageSource, state.format);
    document.getElementById('after-upload').hidden = false;

    resetDownload();
    progressEl.hidden = true;
  } catch (err) {
    progressEl.hidden = true;
    progressBar.value = 0;
    console.error(err);
    alert('画像の読み込みに失敗しました: ' + err.message);
  }
}

function selectFormat(format) {
  state.format = format;
  const radio = document.querySelector(`input[name="format"][value="${format}"]`);
  if (radio) radio.checked = true;
  updateConvertUI();
}

function resetDownload() {
  const link = document.getElementById('download-link');
  if (link.href && link.href.startsWith('blob:')) {
    URL.revokeObjectURL(link.href);
  }
  link.removeAttribute('href');
  link.hidden = true;

  const previewBtn = document.getElementById('preview-button');
  const previewContainer = document.getElementById('preview-container');
  const previewImg = document.getElementById('preview-img');
  previewBtn.hidden = true;
  previewContainer.hidden = true;
  previewImg.removeAttribute('src');
  previewBtn.textContent = '▶ プレビュー';
}

function updateConvertUI() {
  const isPataPata = state.format.endsWith('180') || state.format === 'spatial';
  document.getElementById('convert-360-options').hidden = isPataPata;
  document.getElementById('convert-180-options').hidden = !isPataPata;
}

async function handleConvert() {
  if (!state.image) return;

  const button = document.getElementById('convert-button');
  const progressEl = document.getElementById('progress');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');

  button.disabled = true;
  progressEl.hidden = false;
  progressBar.value = 0;
  resetDownload();

  try {
    let frames;
    let fps;
    let quality;
    const isSpatial = state.format === 'spatial';
    const is180 = state.format.endsWith('180');
    const isPataPata = is180 || isSpatial;

    if (isPataPata) {
      const cycles = parseInt(document.getElementById('cycles').value, 10) || 5;
      const interval = parseFloat(document.getElementById('interval').value) || 0.3;
      quality = parseInt(document.getElementById('quality180').value, 10) || 75;
      fps = 30;

      progressText.textContent = 'パタパタフレーム生成中...';
      // 空間写真は SBS 合成済みなので sbs180 と同じレイアウトで処理
      const layout = isSpatial ? 'sbs180' : state.format;
      const result = await captureVR180PataPata(state.image, layout, {
        cycles, interval, fps,
      });
      frames = result.frames;
      progressBar.value = 0.4;
    } else {
      const duration = parseFloat(document.getElementById('duration').value) || 5;
      fps = parseInt(document.getElementById('fps').value, 10) || 30;
      const [w, h] = document.getElementById('resolution').value.split(',').map(Number);
      quality = parseInt(document.getElementById('quality').value, 10) || 75;

      progressText.textContent = '360° 回転フレーム生成中...';
      const result = await state.viewer.captureRotation({
        width: w,
        height: h,
        duration,
        fps,
        onProgress: (p) => {
          progressBar.value = p * 0.4;
          progressText.textContent = `360° 回転フレーム生成中... ${Math.round(p * 100)}%`;
        },
      });
      frames = result.frames;
    }

    const webpBlob = await framesToWebP(
      frames,
      fps,
      quality,
      (p) => {
        progressBar.value = 0.4 + p * 0.6;
        progressText.textContent = `WebP エンコード中... ${Math.round(p * 100)}%`;
      },
      (msg) => {
        progressText.textContent = msg;
      }
    );

    progressBar.value = 1;
    progressText.textContent = `完了: ${(webpBlob.size / 1024).toFixed(0)} KB / ${frames.length} フレーム`;

    const link = document.getElementById('download-link');
    const url = URL.createObjectURL(webpBlob);
    link.href = url;
    const prefix = isSpatial ? 'spatial_patapata'
      : is180 ? 'vr180_patapata'
      : 'rotation360';
    link.download = `${prefix}_${timestamp()}.webp`;
    link.textContent = `ダウンロード (${(webpBlob.size / 1024).toFixed(0)} KB)`;
    link.hidden = false;
    document.getElementById('preview-button').hidden = false;
  } catch (err) {
    console.error(err);
    progressText.textContent = 'エラー: ' + err.message;
  } finally {
    button.disabled = false;
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '_' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

init();
