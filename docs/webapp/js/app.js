import { Viewer } from './viewer.js';
import { captureVR180PataPata, framesToVideo } from './converter.js';
import { loadSpatialHeic } from './heic.js';

const state = {
  image: null,
  imageUrl: null,
  format: 'mono360',
  viewer: null,
  cameraSteps: [],
  cameraStepIdSeq: 0,
  cameraStart: null, // { lon, lat, fov } — 開始位置を設定されるまで null
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

  initCameraWorkUI();

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
      previewBtn.textContent = '■ プレビューを閉じる';
    } else {
      previewContainer.hidden = true;
      previewImg.removeAttribute('src');
      previewVideo.pause();
      previewVideo.removeAttribute('src');
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
  const previewVideo = document.getElementById('preview-video');
  previewBtn.hidden = true;
  previewContainer.hidden = true;
  previewImg.removeAttribute('src');
  previewVideo.pause();
  previewVideo.removeAttribute('src');
  previewBtn.textContent = '▶ プレビュー';
}

function updateConvertUI() {
  const isSpatial = state.format === 'spatial';
  const is180 = state.format.endsWith('180');
  const hasSteps = state.cameraSteps.length > 0;
  const useCameraWork = !isSpatial && hasSteps;

  // convert-360-options は spatial 以外（= mono360/sbs360/ou360/sbs180/ou180）で表示
  document.getElementById('convert-360-options').hidden = isSpatial;
  // パタパタ設定は spatial 常時 or VR180 でカメラワーク未設定時のみ
  document.getElementById('convert-180-options').hidden =
    !isSpatial && !(is180 && !useCameraWork);

  // 「回転時間」は 360° 系のみ意味がある（VR180 フォールバックはパタパタなので非表示）
  const durationLabel = document.getElementById('duration').closest('label');
  if (durationLabel) durationLabel.hidden = is180;

  // カメラワーク summary のフォールバックヒント
  const fallbackHint = document.getElementById('camera-work-fallback-hint');
  if (fallbackHint) {
    fallbackHint.textContent = is180
      ? '（未設定時はパタパタアニメ）'
      : '（未設定時は「回転時間」で左 360° 回転）';
  }

  // カメラワーク内のオーバーライドヒント
  const overrideHint = document.getElementById('camera-work-hint-override');
  if (overrideHint) {
    overrideHint.textContent = is180
      ? 'ステップを 1 つ以上追加すると、パタパタではなくこの設定に従って動画を生成します'
      : 'ステップを 1 つ以上追加すると、上の「回転時間」は使われずこの設定に従って動画を生成します';
  }

  if (isSpatial) {
    state.viewer?.stopCameraPlayback();
  }
  updateDurationEnabledState();
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
    if (!confirm('カメラワークの全ステップを削除しますか？')) return;
    state.cameraSteps = [];
    renderCameraSteps();
  });

  playBtn.addEventListener('click', async () => {
    if (!state.cameraStart) return;
    if (state.cameraSteps.length === 0) {
      alert('ステップを追加してください');
      return;
    }
    playBtn.hidden = true;
    stopBtn.hidden = false;

    // ブラウザ表示位置の都合でビューアが隠れていたら、再生前に可視領域へスクロール
    await ensureViewerVisible();

    // スクロール待ちの間に停止ボタンが押された可能性
    if (stopBtn.hidden) return;

    state.viewer.playCameraSequence(state.cameraSteps, {
      start: state.cameraStart,
      onEnd: () => {
        playBtn.hidden = false;
        stopBtn.hidden = true;
      },
    });
  });

  stopBtn.addEventListener('click', () => {
    state.viewer.stopCameraPlayback();
    playBtn.hidden = false;
    stopBtn.hidden = true;
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
    setStartBtn.textContent = '① 開始位置を更新';
    statusEl.classList.add('is-set');
    statusEl.textContent = `保存済み: 左右 ${s.lon.toFixed(1)}° / 上下 ${s.lat.toFixed(1)}° / FOV ${s.fov.toFixed(1)}°`;
  } else {
    setStartBtn.textContent = '① 開始位置を設定';
    statusEl.classList.remove('is-set');
    statusEl.textContent = '未設定 — ビューアで視点／ズームを合わせてボタンを押してください';
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
    grip.title = 'ドラッグで並び替え';
    grip.setAttribute('aria-label', 'ドラッグで並び替え');
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
    durInput.title = '所要時間（秒）';
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
    upBtn.title = '上へ';
    upBtn.disabled = idx === 0;
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.dataset.move = 'down';
    downBtn.textContent = '▼';
    downBtn.title = '下へ';
    downBtn.disabled = idx === state.cameraSteps.length - 1;
    reorder.append(upBtn, downBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'camera-step-remove';
    removeBtn.textContent = '×';
    removeBtn.title = '削除';

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
    return `<span class="camera-step-pause">停止</span>`;
  }
  if (step.type === 'rotate') {
    const abs = Math.abs(step.delta);
    let dirLabel;
    if (step.axis === 'lon') {
      dirLabel = step.delta < 0 ? `← 左 ${abs}°` : `→ 右 ${abs}°`;
    } else {
      dirLabel = step.delta > 0 ? `↑ 上 ${abs}°` : `↓ 下 ${abs}°`;
    }
    return `<span class="camera-step-arrow">${dirLabel}</span> 回転`;
  }
  if (step.type === 'zoom') {
    const label = step.direction === 'in' ? '＋ ズームイン' : '− ズームアウト';
    return `<span class="camera-step-zoom">${label}</span>`;
  }
  if (step.type === 'figure8') {
    const label = step.size === 'large' ? '∞ 大きく' : '∞ 小さく';
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
    const useCameraWork = isUsingCameraSteps();
    const isPataPata = (is180 && !useCameraWork) || isSpatial;

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
      fps = parseInt(document.getElementById('fps').value, 10) || 30;
      const [w, h] = document.getElementById('resolution').value.split(',').map(Number);
      quality = parseInt(document.getElementById('quality').value, 10) || 75;

      // ステップ未設定時は従来どおり「n秒で左 360° 回転」
      const steps = state.cameraSteps.length > 0
        ? state.cameraSteps
        : [{
            type: 'rotate',
            axis: 'lon',
            delta: -360,
            duration: parseFloat(document.getElementById('duration').value) || 5,
          }];

      const isCustom = state.cameraSteps.length > 0;
      progressText.textContent = isCustom
        ? 'カメラワークからフレーム生成中...'
        : '360° 回転フレーム生成中...';

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
          const prefix = isCustom ? 'カメラワーク' : '360° 回転';
          progressText.textContent = `${prefix}フレーム生成中... ${Math.round(p * 100)}%`;
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
        progressText.textContent = `${formatLabel} エンコード中... ${Math.round(p * 100)}%`;
      },
      (msg) => {
        progressText.textContent = msg;
      }
    );

    progressBar.value = 1;
    progressText.textContent = `完了: ${(outBlob.size / 1024).toFixed(0)} KB / ${frames.length} フレーム`;

    const link = document.getElementById('download-link');
    const url = URL.createObjectURL(outBlob);
    link.href = url;
    let prefix;
    if (useCameraWork && is180) prefix = 'vr180_camera';
    else if (isSpatial) prefix = 'spatial_patapata';
    else if (is180) prefix = 'vr180_patapata';
    else prefix = 'rotation360';
    link.download = `${prefix}_${timestamp()}.${outputFormat}`;
    link.textContent = `ダウンロード (${(outBlob.size / 1024).toFixed(0)} KB)`;
    link.hidden = false;
    link.dataset.kind = outputFormat === 'mp4' ? 'video' : 'image';
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
