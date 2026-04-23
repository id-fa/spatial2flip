import { Viewer } from './viewer.js';
import { captureVR180PataPata, framesToVideo } from './converter.js';
import { loadSpatialHeic } from './heic.js';
import { unwarpFisheye180Mono, unwarpFisheye180SBS } from './fisheye.js';

const state = {
  image: null,
  imageUrl: null,
  format: 'mono360',
  viewer: null,
  cameraSteps: [],
  cameraStepIdSeq: 0,
  cameraStart: null, // { lon, lat, fov } — 開始位置を設定されるまで null
  recordTimerRaf: 0,
  // 魚眼 unwarp キャッシュ（state.image が更新されたら無効化）
  displayImage: null,       // 実際にビューアに渡す画像（魚眼なら unwarp 済み）
  unwarpedMono: null,
  unwarpedSbs: null,
};

function init() {
  const viewerContainer = document.getElementById('viewer');
  state.viewer = new Viewer(viewerContainer);

  // WebXR 非対応（iOS など）では Three.js の VRButton が「WEBXR NOT AVAILABLE」
  // リンクを返し、絶対配置でビューアに重なる。そういった環境ではコンテナごと隠す。
  const vrContainer = document.getElementById('vr-button-container');
  if ('xr' in navigator) {
    vrContainer.appendChild(state.viewer.createVRButton());
  } else {
    vrContainer.hidden = true;
  }

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
        if (state.image) applyViewerImage();
        updateConvertUI();
      }
    });
  });

  document.getElementById('convert-button').addEventListener('click', handleConvert);

  initCameraWorkUI();
  initRecorderUI();
  initGyroUI();
  initIOSHint();

  const previewBtn = document.getElementById('preview-button');
  const previewContainer = document.getElementById('preview-container');
  const previewImg = document.getElementById('preview-img');
  const previewVideo = document.getElementById('preview-video');
  previewBtn.addEventListener('click', () => {
    const link = document.getElementById('download-link');
    if (!link.href) return;
    if (previewContainer.hidden) {
      const isVideo = link.dataset.kind === 'video';
      if (isVideo) {
        previewVideo.src = link.href;
        previewVideo.hidden = false;
        previewImg.hidden = true;
        previewImg.removeAttribute('src');
      } else {
        previewImg.src = link.href;
        previewImg.hidden = false;
        previewVideo.hidden = true;
        previewVideo.pause();
        previewVideo.removeAttribute('src');
      }
      previewContainer.hidden = false;
      previewBtn.textContent = '■ プレビューを閉じる / Close Preview';
    } else {
      previewContainer.hidden = true;
      previewImg.removeAttribute('src');
      previewVideo.pause();
      previewVideo.removeAttribute('src');
      previewBtn.textContent = '▶ プレビュー / Preview';
    }
  });

  updateConvertUI();
}

function isHeicFile(file) {
  return /\.(heic|heif)$/i.test(file.name) || /image\/(heic|heif)/i.test(file.type);
}

// iOS / iPadOS 判定（iPadOS 13+ は navigator.userAgent に Macintosh が入るので touch 有無で見る）
function isIOS() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/Macintosh/.test(ua) && 'ontouchend' in document) return true;
  return false;
}

function initIOSHint() {
  const hint = document.querySelector('.ios-hint');
  if (hint && !isIOS()) hint.hidden = true;
}

async function loadImage(file) {
  const heic = isHeicFile(file);
  if (!heic && !file.type.startsWith('image/')) {
    alert('画像ファイルを選択してください / Please select an image file');
    return;
  }

  // iOS Safari で写真アプリから HEIC を選ぶと勝手に JPEG 変換されて MV-HEIC の
  // ステレオペア構造が失われる。拡張子 .heic なのに中身が image/jpeg 等になっている
  // ケースや、iOS で HEIC でない image/jpeg を読み込んだケースを検知して警告を出す。
  if (isIOS() && !heic) {
    // 拡張子は HEIC/HEIF なのに type が違う = 変換された可能性が高い
    const nameLooksHeic = /\.(heic|heif)$/i.test(file.name);
    if (nameLooksHeic) {
      alert(
        '注意: iOS Safari が HEIC を JPEG に変換した可能性があります（空間写真のステレオペアが失われています）。\n'
        + '写真アプリから「共有」→「ファイルに保存」で一度「ファイル」App に保存し、ファイル App 側からアップロードしてください。\n\n'
        + 'Note: iOS Safari may have converted your HEIC to JPEG (losing the spatial stereo pair).\n'
        + 'From Photos app, use "Share → Save to Files", then upload from the Files app instead.'
      );
    }
  }

  if (state.viewer && state.viewer.isRecording()) {
    cancelRecording();
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
      progressText.textContent = 'HEIC をデコード中... (初回は libheif-js を読み込みます) / Decoding HEIC... (loading libheif-js on first use)';
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
    // 新しい画像 → 魚眼 unwarp キャッシュを破棄
    state.unwarpedMono = null;
    state.unwarpedSbs = null;
    state.displayImage = null;
    applyViewerImage();
    document.getElementById('after-upload').hidden = false;

    resetDownload();
    progressEl.hidden = true;
  } catch (err) {
    progressEl.hidden = true;
    progressBar.value = 0;
    console.error(err);
    alert('画像の読み込みに失敗しました / Failed to load image: ' + err.message);
  }
}

function selectFormat(format) {
  state.format = format;
  const radio = document.querySelector(`input[name="format"][value="${format}"]`);
  if (radio) radio.checked = true;
  updateConvertUI();
}

// 現在の state.format に応じて魚眼なら unwarp を行い、viewer に適切な
// displayFormat (mono180 / sbs180) と展開済み画像を渡す。非魚眼はそのまま。
function applyViewerImage() {
  if (!state.image) return;
  if (state.format === 'fisheyeMono180') {
    if (!state.unwarpedMono) state.unwarpedMono = unwarpFisheye180Mono(state.image);
    state.displayImage = state.unwarpedMono;
    state.viewer.setImage(state.displayImage, 'mono180');
  } else if (state.format === 'fisheyeSbs180') {
    if (!state.unwarpedSbs) state.unwarpedSbs = unwarpFisheye180SBS(state.image);
    state.displayImage = state.unwarpedSbs;
    state.viewer.setImage(state.displayImage, 'sbs180');
  } else {
    state.displayImage = state.image;
    state.viewer.setImage(state.image, state.format);
  }
}

function isFisheyeFormat(f) {
  return f === 'fisheyeMono180' || f === 'fisheyeSbs180';
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
  const previewVideo = document.getElementById('preview-video');
  previewBtn.hidden = true;
  previewContainer.hidden = true;
  previewImg.removeAttribute('src');
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewBtn.textContent = '▶ プレビュー / Preview';
}

function updateConvertUI() {
  const isSpatial = state.format === 'spatial';
  const is180 = state.format.endsWith('180');
  const isFisheyeMono = state.format === 'fisheyeMono180';
  // パタパタ対象かどうか = ステレオペアを持つ 180°（VR180 SBS/OU、魚眼 SBS、spatial）
  const supportsPataPata = !isFisheyeMono && (isSpatial || is180);
  const hasSteps = state.cameraSteps.length > 0;
  const useCameraWork = !isSpatial && hasSteps;

  // convert-360-options は spatial 以外（= mono360/sbs360/ou360/sbs180/ou180/fisheye*）で表示
  document.getElementById('convert-360-options').hidden = isSpatial;
  // パタパタ設定は spatial 常時、または VR180/魚眼 SBS でカメラワーク未設定時のみ
  document.getElementById('convert-180-options').hidden =
    !isSpatial && !(supportsPataPata && !useCameraWork);

  // 「回転時間」は 360° 系と魚眼モノ 180° で使う（パタパタ対象フォーマットでは非表示）
  const durationLabel = document.getElementById('duration').closest('label');
  if (durationLabel) durationLabel.hidden = supportsPataPata;

  // カメラワーク summary のフォールバックヒント
  const fallbackHint = document.getElementById('camera-work-fallback-hint');
  if (fallbackHint) {
    if (isFisheyeMono) {
      fallbackHint.textContent = '（未設定時は「回転時間」で左 170° スイープ / If unset: 170° horizontal sweep using Rotation Time）';
    } else {
      fallbackHint.textContent = supportsPataPata
        ? '（未設定時はパタパタアニメ / If unset: pata-pata animation）'
        : '（未設定時は「回転時間」で左 360° 回転 / If unset: full 360° rotation using Rotation Time）';
    }
  }

  // カメラワーク内のオーバーライドヒント
  const overrideHint = document.getElementById('camera-work-hint-override');
  if (overrideHint) {
    overrideHint.textContent = supportsPataPata
      ? 'ステップを 1 つ以上追加すると、パタパタではなくこの設定に従って動画を生成します / Adding one or more steps overrides the pata-pata animation with this sequence'
      : 'ステップを 1 つ以上追加すると、上の「回転時間」は使われずこの設定に従って動画を生成します / Adding one or more steps overrides the Rotation Time above and follows this sequence instead';
  }

  if (isSpatial) {
    state.viewer?.stopCameraPlayback();
  }
  updateDurationEnabledState();
  updateRecorderUI();
}

function initCameraWorkUI() {
  const list = document.getElementById('camera-step-list');
  const playBtn = document.getElementById('camera-preview-play');
  const stopBtn = document.getElementById('camera-preview-stop');
  const clearBtn = document.getElementById('camera-steps-clear');
  const secondsInput = document.getElementById('camera-rotate-seconds');
  const setStartBtn = document.getElementById('camera-set-start');

  const getSeconds = () => {
    const v = parseFloat(secondsInput.value);
    return Number.isFinite(v) && v > 0 ? v : 5;
  };

  setStartBtn.addEventListener('click', () => {
    state.viewer.stopCameraPlayback();
    state.cameraStart = state.viewer.getCurrentView();
    updateCameraStartUI();
  });

  document.querySelectorAll('.camera-add-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.cameraStart) return;
      const axis = btn.dataset.axis;
      const delta = parseFloat(btn.dataset.delta);
      addCameraStep({
        type: 'rotate',
        axis,
        delta,
        duration: getSeconds(),
      });
    });
  });

  document.querySelectorAll('.camera-add-pause-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.cameraStart) return;
      addCameraStep({ type: 'pause', duration: getSeconds() });
    });
  });

  document.querySelectorAll('.camera-add-zoom-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.cameraStart) return;
      const dir = btn.dataset.zoom; // 'in' | 'out'
      const factor = dir === 'in' ? 0.5 : 2.0;
      addCameraStep({
        type: 'zoom',
        direction: dir,
        factor,
        duration: getSeconds(),
      });
    });
  });

  document.querySelectorAll('.camera-add-fig8-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.cameraStart) return;
      const size = btn.dataset.size; // 'small' | 'large'
      // 横 8 の字: 横幅:縦幅 = 2:1
      const ampLon = size === 'large' ? 30 : 10;
      const ampLat = ampLon / 2;
      addCameraStep({
        type: 'figure8',
        size,
        ampLon,
        ampLat,
        duration: getSeconds(),
      });
    });
  });

  clearBtn.addEventListener('click', () => {
    if (state.cameraSteps.length === 0) return;
    if (!confirm('カメラワークの全ステップを削除しますか？ / Delete all camera work steps?')) return;
    state.cameraSteps = [];
    renderCameraSteps();
  });

  const exportBtn = document.getElementById('camera-export-json');
  const importBtn = document.getElementById('camera-import-json');
  const importFile = document.getElementById('camera-import-file');

  exportBtn.addEventListener('click', () => {
    if (state.cameraSteps.length === 0 && !state.cameraStart) {
      alert('エクスポートする内容がありません（開始位置を設定するかステップを追加してください） / Nothing to export (set a start position or add steps)');
      return;
    }
    const data = {
      schema: 'spatial2flip-camerawork/1',
      exportedAt: new Date().toISOString(),
      start: state.cameraStart,
      steps: state.cameraSteps.map(({ id, ...rest }) => rest),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `camerawork_${timestamp()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const { start, steps } = validateCameraWorkJSON(data);
      if (state.cameraSteps.length > 0 || state.cameraStart) {
        if (!confirm('現在のカメラワーク定義を上書きしてインポートしますか？ / Overwrite the current camera work definition with the imported one?')) return;
      }
      state.viewer.stopCameraPlayback();
      state.cameraStart = start;
      state.cameraSteps = steps.map((s) => ({ id: ++state.cameraStepIdSeq, ...s }));
      updateCameraStartUI();
      renderCameraSteps();
    } catch (err) {
      alert('JSON の読み込みに失敗 / Failed to load JSON: ' + err.message);
    } finally {
      importFile.value = '';
    }
  });

  playBtn.addEventListener('click', async () => {
    if (!state.cameraStart) return;
    if (state.cameraSteps.length === 0) {
      alert('ステップを追加してください / Please add at least one step');
      return;
    }
    if (state.viewer.isRecording()) return;
    playBtn.hidden = true;
    stopBtn.hidden = false;
    // 再生中は録画ボタンを無効化（相互排他）
    const recStart = document.getElementById('record-start');
    if (recStart) recStart.disabled = true;

    // ブラウザ表示位置の都合でビューアが隠れていたら、再生前に可視領域へスクロール
    await ensureViewerVisible();

    // スクロール待ちの間に停止ボタンが押された可能性
    if (stopBtn.hidden) return;

    state.viewer.playCameraSequence(state.cameraSteps, {
      start: state.cameraStart,
      onEnd: () => {
        playBtn.hidden = false;
        stopBtn.hidden = true;
        if (recStart) recStart.disabled = false;
      },
    });
  });

  stopBtn.addEventListener('click', () => {
    state.viewer.stopCameraPlayback();
    playBtn.hidden = false;
    stopBtn.hidden = true;
    const recStart = document.getElementById('record-start');
    if (recStart) recStart.disabled = false;
  });

  // ドラッグ中の挿入位置インジケータ
  list.addEventListener('dragover', (e) => {
    const li = e.target.closest('li[data-step-id]');
    if (!li || li.classList.contains('is-dragging')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    clearDropIndicators();
    li.classList.toggle('drop-before', !after);
    li.classList.toggle('drop-after', after);
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clearDropIndicators();
  });

  list.addEventListener('drop', (e) => {
    const li = e.target.closest('li[data-step-id]');
    if (!li) return;
    e.preventDefault();
    const draggedId = Number(e.dataTransfer.getData('text/plain'));
    const targetId = Number(li.dataset.stepId);
    const after = li.classList.contains('drop-after');
    clearDropIndicators();
    if (!draggedId || draggedId === targetId) return;
    moveCameraStepTo(draggedId, targetId, after);
  });

  // 並び替え／削除はイベント委譲
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const li = btn.closest('li[data-step-id]');
    if (!li) return;
    const id = Number(li.dataset.stepId);
    const idx = state.cameraSteps.findIndex((s) => s.id === id);
    if (idx < 0) return;

    if (btn.classList.contains('camera-step-remove')) {
      state.cameraSteps.splice(idx, 1);
      renderCameraSteps();
    } else if (btn.dataset.move === 'up' && idx > 0) {
      const swapped = [state.cameraSteps[idx - 1].id, state.cameraSteps[idx].id];
      [state.cameraSteps[idx - 1], state.cameraSteps[idx]] =
        [state.cameraSteps[idx], state.cameraSteps[idx - 1]];
      renderCameraSteps();
      flashCameraStepRows(swapped);
    } else if (btn.dataset.move === 'down' && idx < state.cameraSteps.length - 1) {
      const swapped = [state.cameraSteps[idx].id, state.cameraSteps[idx + 1].id];
      [state.cameraSteps[idx + 1], state.cameraSteps[idx]] =
        [state.cameraSteps[idx], state.cameraSteps[idx + 1]];
      renderCameraSteps();
      flashCameraStepRows(swapped);
    }
  });

  updateCameraStartUI();
  renderCameraSteps();
}

function updateCameraStartUI() {
  const setStartBtn = document.getElementById('camera-set-start');
  const statusEl = document.getElementById('camera-start-status');
  const s = state.cameraStart;
  if (s) {
    setStartBtn.textContent = '① 開始位置を更新 / Update Start Position';
    statusEl.classList.add('is-set');
    statusEl.textContent = `保存済み / Saved: 左右 / lon ${s.lon.toFixed(1)}° / 上下 / lat ${s.lat.toFixed(1)}° / FOV ${s.fov.toFixed(1)}°`;
  } else {
    setStartBtn.textContent = '① 開始位置を設定 / Set Start Position';
    statusEl.classList.remove('is-set');
    statusEl.textContent = '未設定 — ビューアで視点／ズームを合わせてボタンを押してください / Not set — aim the viewer and click the button';
  }
  updateCameraButtonsEnabled();
}

function updateCameraButtonsEnabled() {
  const ok = state.cameraStart !== null;
  document
    .querySelectorAll('.camera-add-btn, .camera-add-pause-btn, .camera-add-zoom-btn, .camera-add-fig8-btn')
    .forEach((b) => { b.disabled = !ok; });
  document.getElementById('camera-preview-play').disabled = !ok;
  document.getElementById('camera-steps-clear').disabled = !ok;
}

async function ensureViewerVisible() {
  const viewerEl = document.getElementById('viewer');
  const rect = viewerEl.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const fullyVisible = rect.top >= 0 && rect.bottom <= vh;
  if (fullyVisible) return;
  viewerEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await waitForScrollEnd();
}

function waitForScrollEnd(timeout = 1500) {
  return new Promise((resolve) => {
    let lastY = window.scrollY;
    let stable = 0;
    const start = performance.now();
    const step = () => {
      if (performance.now() - start > timeout) return resolve();
      const y = window.scrollY;
      if (Math.abs(y - lastY) < 0.5) {
        stable++;
        if (stable >= 5) return resolve();
      } else {
        stable = 0;
        lastY = y;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function addCameraStep(partial) {
  const step = { id: ++state.cameraStepIdSeq, ...partial };
  state.cameraSteps.push(step);
  renderCameraSteps();
}

// カメラワーク定義 JSON のスキーマ検証。不正なら throw。
// 受け付けるスキーマ: "spatial2flip-camerawork/1"（schema フィールドは省略可。互換のため）。
function validateCameraWorkJSON(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('JSON の形式が不正です / Invalid JSON format');
  }
  if (data.schema && typeof data.schema === 'string'
      && !data.schema.startsWith('spatial2flip-camerawork/')) {
    throw new Error(`想定外のスキーマ / Unexpected schema: ${data.schema}`);
  }

  let start = null;
  if (data.start && typeof data.start === 'object') {
    const lon = Number(data.start.lon);
    const lat = Number(data.start.lat);
    const fov = Number(data.start.fov);
    if ([lon, lat, fov].every(Number.isFinite)) {
      start = { lon, lat, fov };
    } else {
      throw new Error('start の lon/lat/fov が数値ではありません / start.lon/lat/fov must be numbers');
    }
  }

  if (!Array.isArray(data.steps)) {
    throw new Error('steps が配列ではありません / steps must be an array');
  }
  const steps = data.steps.map((s, i) => validateCameraWorkStep(s, i));
  return { start, steps };
}

function validateCameraWorkStep(s, idx) {
  const n = idx + 1;
  if (!s || typeof s !== 'object') throw new Error(`ステップ ${n} が不正 / Step ${n} is invalid`);
  const duration = Number(s.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`ステップ ${n}: duration が不正 (正の数である必要があります) / Step ${n}: duration must be a positive number`);
  }
  const type = s.type;
  if (type === 'rotate') {
    if (s.axis !== 'lon' && s.axis !== 'lat') throw new Error(`ステップ ${n}: axis は 'lon' か 'lat' である必要があります / Step ${n}: axis must be 'lon' or 'lat'`);
    const delta = Number(s.delta);
    if (!Number.isFinite(delta)) throw new Error(`ステップ ${n}: delta が数値ではありません / Step ${n}: delta must be a number`);
    return { type, axis: s.axis, delta, duration };
  }
  if (type === 'pause') return { type, duration };
  if (type === 'zoom') {
    const factor = Number(s.factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      throw new Error(`ステップ ${n}: factor は正の数である必要があります / Step ${n}: factor must be a positive number`);
    }
    const direction = (s.direction === 'in' || s.direction === 'out')
      ? s.direction
      : (factor < 1 ? 'in' : 'out');
    return { type, direction, factor, duration };
  }
  if (type === 'figure8') {
    const ampLon = Number(s.ampLon);
    const ampLat = Number(s.ampLat);
    if (!Number.isFinite(ampLon) || !Number.isFinite(ampLat)) {
      throw new Error(`ステップ ${n}: ampLon / ampLat が数値ではありません / Step ${n}: ampLon / ampLat must be numbers`);
    }
    const size = (s.size === 'small' || s.size === 'large') ? s.size : 'small';
    return { type, size, ampLon, ampLat, duration };
  }
  throw new Error(`ステップ ${n}: 不明な type / Step ${n}: unknown type: ${type}`);
}

function renderCameraSteps() {
  const list = document.getElementById('camera-step-list');
  const countEl = document.getElementById('camera-step-count');
  list.innerHTML = '';

  state.cameraSteps.forEach((step, idx) => {
    const li = document.createElement('li');
    li.className = 'camera-step-item';
    li.dataset.stepId = String(step.id);
    li.draggable = false; // mousedown でグリップ上に限って true にする

    const grip = document.createElement('span');
    grip.className = 'camera-step-grip';
    grip.title = 'ドラッグで並び替え / Drag to reorder';
    grip.setAttribute('aria-label', 'ドラッグで並び替え / Drag to reorder');
    grip.textContent = '⠿';

    // グリップ上での mousedown だけを DnD の対象にする
    li.addEventListener('mousedown', (e) => {
      li.draggable = !!e.target.closest('.camera-step-grip');
    });
    li.addEventListener('dragstart', (e) => {
      if (!li.draggable) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', li.dataset.stepId);
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', () => {
      li.draggable = false;
      li.classList.remove('is-dragging');
      clearDropIndicators();
    });

    const indexSpan = document.createElement('span');
    indexSpan.className = 'camera-step-index';
    indexSpan.textContent = String(idx + 1);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'camera-step-label';
    labelSpan.innerHTML = formatCameraStepLabel(step);

    const durationWrap = document.createElement('span');
    durationWrap.className = 'camera-step-duration';
    const durInput = document.createElement('input');
    durInput.type = 'number';
    durInput.min = '0.1';
    durInput.step = '0.5';
    durInput.value = String(step.duration);
    durInput.title = '所要時間（秒） / Duration (sec)';
    durInput.addEventListener('change', () => {
      const v = parseFloat(durInput.value);
      if (!Number.isFinite(v) || v <= 0) {
        durInput.value = String(step.duration);
        return;
      }
      step.duration = v;
      durInput.value = String(v);
      updateCameraStepTotal();
    });
    // ホイールで数値が変わるのを防ぐ（UX 的に意図しない変更になりやすい）
    durInput.addEventListener('wheel', (e) => { if (document.activeElement === durInput) e.preventDefault(); }, { passive: false });
    const unitSpan = document.createElement('span');
    unitSpan.className = 'unit';
    unitSpan.textContent = '秒';
    durationWrap.append(durInput, unitSpan);

    const reorder = document.createElement('span');
    reorder.className = 'camera-step-reorder';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.dataset.move = 'up';
    upBtn.textContent = '▲';
    upBtn.title = '上へ / Move up';
    upBtn.disabled = idx === 0;
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.dataset.move = 'down';
    downBtn.textContent = '▼';
    downBtn.title = '下へ / Move down';
    downBtn.disabled = idx === state.cameraSteps.length - 1;
    reorder.append(upBtn, downBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'camera-step-remove';
    removeBtn.textContent = '×';
    removeBtn.title = '削除 / Remove';

    li.append(grip, indexSpan, labelSpan, durationWrap, reorder, removeBtn);
    list.appendChild(li);
  });

  countEl.textContent = String(state.cameraSteps.length);
  updateCameraStepTotal();
  updateDurationEnabledState();
  // VR180 はステップの有無でパタパタ欄の表示が変わる
  updateConvertUI();
}

function moveCameraStepTo(draggedId, targetId, after) {
  const fromIdx = state.cameraSteps.findIndex((s) => s.id === draggedId);
  if (fromIdx < 0) return;
  const [moved] = state.cameraSteps.splice(fromIdx, 1);
  let targetIdx = state.cameraSteps.findIndex((s) => s.id === targetId);
  if (targetIdx < 0) {
    // 取り逃したら元に戻す
    state.cameraSteps.splice(fromIdx, 0, moved);
    return;
  }
  if (after) targetIdx += 1;
  state.cameraSteps.splice(targetIdx, 0, moved);
  renderCameraSteps();
  flashCameraStepRows([draggedId]);
}

function clearDropIndicators() {
  document
    .querySelectorAll('#camera-step-list .drop-before, #camera-step-list .drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}

function flashCameraStepRows(ids) {
  const list = document.getElementById('camera-step-list');
  for (const id of ids) {
    const el = list.querySelector(`li[data-step-id="${id}"]`);
    if (!el) continue;
    el.classList.remove('is-swapped');
    // 直前に同じクラスが付いていた場合にもアニメを再トリガーさせるため reflow
    void el.offsetWidth;
    el.classList.add('is-swapped');
    el.addEventListener('animationend', () => el.classList.remove('is-swapped'), { once: true });
  }
}

function updateCameraStepTotal() {
  const totalEl = document.getElementById('camera-step-total');
  const total = state.cameraSteps.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  totalEl.textContent = (Math.round(total * 10) / 10).toString();
}

function formatCameraStepLabel(step) {
  if (step.type === 'pause') {
    return `<span class="camera-step-pause">停止 / Pause</span>`;
  }
  if (step.type === 'rotate') {
    const abs = Math.abs(step.delta);
    let dirLabel;
    if (step.axis === 'lon') {
      dirLabel = step.delta < 0 ? `← 左 ${abs}° / Left ${abs}°` : `→ 右 ${abs}° / Right ${abs}°`;
    } else {
      dirLabel = step.delta > 0 ? `↑ 上 ${abs}° / Up ${abs}°` : `↓ 下 ${abs}° / Down ${abs}°`;
    }
    return `<span class="camera-step-arrow">${dirLabel}</span> 回転 / Rotate`;
  }
  if (step.type === 'zoom') {
    const label = step.direction === 'in' ? '＋ ズームイン / Zoom In' : '− ズームアウト / Zoom Out';
    return `<span class="camera-step-zoom">${label}</span>`;
  }
  if (step.type === 'figure8') {
    const label = step.size === 'large' ? '∞ 大きく / Large' : '∞ 小さく / Small';
    return `<span class="camera-step-fig8">${label}</span>`;
  }
  return '';
}

function updateDurationEnabledState() {
  const durationInput = document.getElementById('duration');
  const label = durationInput.closest('label');
  const useSteps = isUsingCameraSteps();
  durationInput.disabled = useSteps;
  if (label) label.classList.toggle('is-disabled', useSteps);
}

function isUsingCameraSteps() {
  // spatial はカメラワーク非対応（平面ステレオなので意味がない）
  if (state.format === 'spatial') return false;
  return state.cameraSteps.length > 0;
}

async function handleConvert() {
  if (!state.image) return;
  if (state.viewer.isRecording()) {
    alert('録画中は変換できません。録画を停止してください / Cannot convert while recording. Please stop recording first.');
    return;
  }

  const button = document.getElementById('convert-button');
  const progressEl = document.getElementById('progress');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const recStart = document.getElementById('record-start');

  button.disabled = true;
  if (recStart) recStart.disabled = true;
  progressEl.hidden = false;
  progressBar.value = 0;
  resetDownload();

  try {
    let frames;
    let fps;
    let quality;
    const isSpatial = state.format === 'spatial';
    const is180 = state.format.endsWith('180');
    const isFisheyeMono = state.format === 'fisheyeMono180';
    const isFisheyeSbs = state.format === 'fisheyeSbs180';
    const useCameraWork = isUsingCameraSteps();
    // 魚眼モノラルはステレオペアを持たないのでパタパタ不可 → 非パタパタで回転フォールバック
    const isPataPata = (is180 && !useCameraWork && !isFisheyeMono) || isSpatial;

    if (isPataPata) {
      const cycles = parseInt(document.getElementById('cycles').value, 10) || 5;
      const interval = parseFloat(document.getElementById('interval').value) || 0.3;
      quality = parseInt(document.getElementById('quality180').value, 10) || 75;
      fps = 30;

      progressText.textContent = 'パタパタフレーム生成中... / Generating pata-pata frames...';
      // 空間写真と魚眼 SBS は SBS 合成済みとして sbs180 レイアウトで処理
      const layout = (isSpatial || isFisheyeSbs) ? 'sbs180' : state.format;
      const pataImage = isFisheyeSbs ? state.displayImage : state.image;
      const result = await captureVR180PataPata(pataImage, layout, {
        cycles, interval, fps,
      });
      frames = result.frames;
      progressBar.value = 0.4;
    } else {
      fps = parseInt(document.getElementById('fps').value, 10) || 30;
      const [w, h] = document.getElementById('resolution').value.split(',').map(Number);
      quality = parseInt(document.getElementById('quality').value, 10) || 75;

      // ステップ未設定時のデフォルト: 360° 系は一回転、魚眼 mono 180° は水平スイープ
      const defaultDelta = isFisheyeMono ? -170 : -360;
      const steps = state.cameraSteps.length > 0
        ? state.cameraSteps
        : [{
            type: 'rotate',
            axis: 'lon',
            delta: defaultDelta,
            duration: parseFloat(document.getElementById('duration').value) || 5,
          }];

      const isCustom = state.cameraSteps.length > 0;
      progressText.textContent = isCustom
        ? 'カメラワークからフレーム生成中... / Generating frames from camera work...'
        : '360° 回転フレーム生成中... / Generating 360° rotation frames...';

      // 再生中なら止めてから
      state.viewer.stopCameraPlayback();

      // カメラワーク時は開始位置から、未指定時は初期位置から
      const startView = isCustom
        ? state.cameraStart
        : { lon: 0, lat: 0, fov: 75 };

      const result = await state.viewer.captureCameraSequence({
        steps,
        start: startView,
        width: w,
        height: h,
        fps,
        onProgress: (p) => {
          progressBar.value = p * 0.4;
          const prefix = isCustom ? 'カメラワーク / Camera work' : '360° 回転 / 360° rotation';
          progressText.textContent = `${prefix} フレーム生成中 / Generating frames... ${Math.round(p * 100)}%`;
        },
      });
      frames = result.frames;
    }

    const outputFormat = document.getElementById('output-format').value || 'webp';
    const formatLabel = outputFormat === 'mp4' ? 'MP4' : 'WebP';

    const outBlob = await framesToVideo(
      frames,
      fps,
      quality,
      outputFormat,
      (p) => {
        progressBar.value = 0.4 + p * 0.6;
        progressText.textContent = `${formatLabel} エンコード中 / Encoding... ${Math.round(p * 100)}%`;
      },
      (msg) => {
        progressText.textContent = msg;
      }
    );

    progressBar.value = 1;
    progressText.textContent = `完了 / Done: ${(outBlob.size / 1024).toFixed(0)} KB / ${frames.length} フレーム / frames`;

    const link = document.getElementById('download-link');
    const url = URL.createObjectURL(outBlob);
    link.href = url;
    let prefix;
    if (isFisheyeMono) prefix = useCameraWork ? 'fisheye180_mono_camera' : 'fisheye180_mono';
    else if (isFisheyeSbs) prefix = useCameraWork ? 'fisheye180_sbs_camera' : 'fisheye180_sbs_patapata';
    else if (useCameraWork && is180) prefix = 'vr180_camera';
    else if (isSpatial) prefix = 'spatial_patapata';
    else if (is180) prefix = 'vr180_patapata';
    else prefix = 'rotation360';
    link.download = `${prefix}_${timestamp()}.${outputFormat}`;
    link.textContent = `ダウンロード / Download (${(outBlob.size / 1024).toFixed(0)} KB)`;
    link.hidden = false;
    link.dataset.kind = outputFormat === 'mp4' ? 'video' : 'image';
    document.getElementById('preview-button').hidden = false;
  } catch (err) {
    console.error(err);
    progressText.textContent = 'エラー / Error: ' + err.message;
  } finally {
    button.disabled = false;
    if (recStart) recStart.disabled = state.format === 'spatial';
  }
}

// ===== ジャイロ UI =====

function initGyroUI() {
  const btn = document.getElementById('gyro-toggle');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (state.viewer.isGyroActive()) {
      state.viewer.stopGyroscope();
      updateGyroButtonState(false);
      return;
    }
    try {
      await state.viewer.startGyroscope();
      updateGyroButtonState(true);
    } catch (err) {
      alert(err.message);
      updateGyroButtonState(false);
    }
  });
  updateGyroButtonVisibility();
}

function updateGyroButtonVisibility() {
  const btn = document.getElementById('gyro-toggle');
  if (!btn) return;
  const supported = state.viewer && state.viewer.isGyroSupported();
  const isSpatial = state.format === 'spatial';
  // DeviceOrientationEvent 非対応環境（多くのデスクトップ）や spatial では隠す
  btn.hidden = !supported || isSpatial;
  // ジャイロが ON の状態でフォーマット切替されたら停止
  if (isSpatial && state.viewer && state.viewer.isGyroActive()) {
    state.viewer.stopGyroscope();
    updateGyroButtonState(false);
  }
}

function updateGyroButtonState(active) {
  const btn = document.getElementById('gyro-toggle');
  if (!btn) return;
  btn.classList.toggle('is-active', active);
  btn.textContent = active ? '📱 ジャイロ OFF / Gyro OFF' : '📱 ジャイロ ON / Gyro ON';
}

// ===== 録画 UI =====

function initRecorderUI() {
  const startBtn = document.getElementById('record-start');
  const stopBtn = document.getElementById('record-stop');
  const elapsedEl = document.getElementById('record-elapsed');

  startBtn.addEventListener('click', () => {
    if (!state.image) {
      alert('画像を読み込んでから録画を開始してください / Please load an image before starting recording');
      return;
    }
    if (state.viewer.isPlayingSequence && state.viewer.isPlayingSequence()) {
      alert('カメラワーク再生中は録画できません。停止してから再試行してください / Cannot record while camera work is playing. Please stop it first.');
      return;
    }
    try {
      state.viewer.startRecording();
    } catch (err) {
      alert(err.message);
      return;
    }
    setRecordingUILocked(true);
    startBtn.hidden = true;
    stopBtn.hidden = false;
    document.getElementById('record-indicator').hidden = false;
    elapsedEl.textContent = '0.0s';

    const tick = () => {
      if (!state.viewer.isRecording()) return;
      const sec = state.viewer.getRecordingElapsed();
      elapsedEl.textContent = sec.toFixed(1) + 's';
      state.recordTimerRaf = requestAnimationFrame(tick);
    };
    state.recordTimerRaf = requestAnimationFrame(tick);
  });

  stopBtn.addEventListener('click', async () => {
    if (state.recordTimerRaf) {
      cancelAnimationFrame(state.recordTimerRaf);
      state.recordTimerRaf = 0;
    }
    const result = state.viewer.stopRecording();
    startBtn.hidden = false;
    stopBtn.hidden = true;
    document.getElementById('record-indicator').hidden = true;

    if (!result || result.duration < 0.5 || !result.samples || result.samples.length < 2) {
      alert('録画が短すぎます（0.5 秒以上録画してください） / Recording too short (please record at least 0.5 seconds)');
      setRecordingUILocked(false);
      return;
    }

    await runRecordConvert(result.samples);
    setRecordingUILocked(false);
  });
}

function cancelRecording() {
  if (state.recordTimerRaf) {
    cancelAnimationFrame(state.recordTimerRaf);
    state.recordTimerRaf = 0;
  }
  if (state.viewer && state.viewer.isRecording()) {
    state.viewer.stopRecording();
  }
  document.getElementById('record-start').hidden = false;
  document.getElementById('record-stop').hidden = true;
  document.getElementById('record-indicator').hidden = true;
  setRecordingUILocked(false);
}

function updateRecorderUI() {
  const startBtn = document.getElementById('record-start');
  const stopBtn = document.getElementById('record-stop');
  const hint = document.getElementById('record-hint');
  if (!startBtn) return;
  const isSpatial = state.format === 'spatial';

  if (isSpatial) {
    // 録画中に spatial に切替された場合も想定して cancel
    if (state.viewer && state.viewer.isRecording()) cancelRecording();
    startBtn.hidden = true;
    stopBtn.hidden = true;
    if (hint) {
      hint.textContent = '空間写真（平面ステレオ）は「フリー作成」非対応です / Spatial photos (planar stereo) do not support Free mode recording';
      hint.hidden = false;
    }
  } else {
    if (!state.viewer || !state.viewer.isRecording()) {
      startBtn.hidden = false;
      stopBtn.hidden = true;
    }
    if (hint) {
      hint.textContent = '';
      hint.hidden = true;
    }
  }
  updateGyroButtonVisibility();
}

function setRecordingUILocked(locked) {
  // 録画中は他の操作（変換／カメラワーク編集／フォーマット切替／ジャイロ切替）をロック
  document.getElementById('convert-button').disabled = locked;
  document.querySelectorAll('input[name="format"]').forEach((r) => { r.disabled = locked; });
  const editBtns = document.querySelectorAll(
    '.camera-add-btn, .camera-add-pause-btn, .camera-add-zoom-btn, .camera-add-fig8-btn'
  );
  editBtns.forEach((b) => { b.disabled = locked; });
  document.getElementById('camera-preview-play').disabled = locked;
  document.getElementById('camera-preview-stop').disabled = locked;
  document.getElementById('camera-set-start').disabled = locked;
  document.getElementById('camera-steps-clear').disabled = locked;
  const gyroBtn = document.getElementById('gyro-toggle');
  if (gyroBtn) gyroBtn.disabled = locked;
  if (!locked) {
    // ロック解除時は開始位置の有無に応じた本来の状態を再適用
    updateCameraButtonsEnabled();
    document.getElementById('camera-set-start').disabled = false;
  }
}

async function runRecordConvert(samples) {
  const progressEl = document.getElementById('progress');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');
  const convertBtn = document.getElementById('convert-button');

  convertBtn.disabled = true;
  progressEl.hidden = false;
  progressBar.value = 0;
  resetDownload();

  try {
    const fps = parseInt(document.getElementById('fps').value, 10) || 30;
    const [w, h] = document.getElementById('resolution').value.split(',').map(Number);
    const quality = parseInt(document.getElementById('quality').value, 10) || 75;

    progressText.textContent = '録画フレーム生成中... / Generating frames from recording...';

    const { frames } = await state.viewer.captureRecordedSequence({
      samples,
      width: w,
      height: h,
      fps,
      onProgress: (p) => {
        progressBar.value = p * 0.4;
        progressText.textContent = `録画フレーム生成中 / Generating frames from recording... ${Math.round(p * 100)}%`;
      },
    });

    const outputFormat = document.getElementById('output-format').value || 'webp';
    const formatLabel = outputFormat === 'mp4' ? 'MP4' : 'WebP';

    const outBlob = await framesToVideo(
      frames, fps, quality, outputFormat,
      (p) => {
        progressBar.value = 0.4 + p * 0.6;
        progressText.textContent = `${formatLabel} エンコード中 / Encoding... ${Math.round(p * 100)}%`;
      },
      (msg) => { progressText.textContent = msg; }
    );

    progressBar.value = 1;
    progressText.textContent = `完了 / Done: ${(outBlob.size / 1024).toFixed(0)} KB / ${frames.length} フレーム / frames`;

    const link = document.getElementById('download-link');
    const url = URL.createObjectURL(outBlob);
    link.href = url;
    const is180 = state.format.endsWith('180');
    let prefix;
    if (state.format === 'fisheyeMono180') prefix = 'recording_fisheye180_mono';
    else if (state.format === 'fisheyeSbs180') prefix = 'recording_fisheye180_sbs';
    else if (is180) prefix = 'recording_vr180';
    else prefix = 'recording_360';
    link.download = `${prefix}_${timestamp()}.${outputFormat}`;
    link.textContent = `ダウンロード / Download (${(outBlob.size / 1024).toFixed(0)} KB)`;
    link.hidden = false;
    link.dataset.kind = outputFormat === 'mp4' ? 'video' : 'image';
    document.getElementById('preview-button').hidden = false;

    // 結果が見えるようにスクロール
    document.getElementById('result-actions').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    console.error(err);
    progressText.textContent = 'エラー / Error: ' + err.message;
  } finally {
    convertBtn.disabled = false;
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

// PWA: Service Worker 登録（オフライン動作 / インストール対応）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service Worker 登録に失敗:', err);
    });
  });
}
