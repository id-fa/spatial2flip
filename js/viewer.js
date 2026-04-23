import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

// ===== ジャイロ計算用の使い回しオブジェクト =====
// Three.js 旧 DeviceOrientationControls のロジックを踏襲
const _GYRO_Q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _GYRO_ZEE = new THREE.Vector3(0, 0, 1);
const _gyroEuler = new THREE.Euler();
const _gyroQuat = new THREE.Quaternion();
const _gyroTmp = new THREE.Quaternion();
const _gyroOutEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function _getScreenOrientAngle() {
  if (typeof screen !== 'undefined') {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
  }
  if (typeof window !== 'undefined' && typeof window.orientation === 'number') {
    return window.orientation;
  }
  return 0;
}

/**
 * 360°/VR/平面ステレオ画像のビューア。
 * レイヤ構成:
 *   layer 0 = モノラル（両眼共通）
 *   layer 1 = 左目用
 *   layer 2 = 右目用
 * 非 VR 時はメインカメラが layer 0+1 を見る（= 左目のみ表示）。
 * VR 時は左目カメラが 0+1、右目カメラが 0+2 を見る。
 *
 * 画像タイプ別ジオメトリ:
 *   mono360 / sbs360 / ou360 → 全球 (SphereGeometry)
 *   sbs180 / ou180           → 前方半球 (SphereGeometry 部分)
 *   spatial                  → 平面ステレオ (PlaneGeometry × 2, Apple 空間写真)
 */
export class Viewer {
  constructor(container) {
    this.container = container;
    this.format = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    this._baseFov = 75;
    this._minFov = 25;
    this._maxFov = 100;
    this.camera = new THREE.PerspectiveCamera(this._baseFov, 1, 0.1, 1100);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(1); // 左目用コンテンツも見えるようにする

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.xr.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.renderer.xr.addEventListener('sessionstart', () => {
      const xrCam = this.renderer.xr.getCamera();
      if (xrCam.cameras.length >= 2) {
        xrCam.cameras[0].layers.enable(1);
        xrCam.cameras[1].layers.enable(2);
      }
    });

    this.meshes = [];
    this._baseTex = null;

    this._setupControls();
    this._setupResize();
    this.resize();

    this.renderer.setAnimationLoop(() => {
      this._updateCameraRotation();
      if (this._recording && this._recording.active) this._pushRecordingSample();
      this.renderer.render(this.scene, this.camera);
    });
  }

  // ===== ライブ録画 =====
  // ビューア上のドラッグ／ホイール操作を記録し、停止後にオフスクリーンで
  // 同じ lon/lat/fov 軌跡をフレーム列として再レンダーする。
  startRecording() {
    if (this.renderer.xr.isPresenting) {
      throw new Error('VR 表示中は録画できません / Cannot record while in VR');
    }
    if (this.format === 'spatial') {
      throw new Error('空間写真（平面ステレオ）は録画対象外です / Spatial photos (planar stereo) are not supported for recording');
    }
    this.stopCameraPlayback();
    // 録画中は画面回転を無視するため、開始時の画面角度を固定して使う
    this._recordedOrientAngle = _getScreenOrientAngle();
    this._recording = {
      active: true,
      startTime: performance.now(),
      samples: [],
    };
    this._pushRecordingSample();
  }

  _pushRecordingSample() {
    if (!this._recording || !this._recording.active) return;
    const t = (performance.now() - this._recording.startTime) / 1000;
    this._recording.samples.push({
      t,
      lon: this._lon,
      lat: this._lat,
      fov: this.camera.fov,
    });
  }

  stopRecording() {
    if (!this._recording) return null;
    const rec = this._recording;
    rec.active = false;
    const tEnd = (performance.now() - rec.startTime) / 1000;
    // 最終フレームを保険で push（直近フレーム以降に微小な移動があれば拾う）
    const last = rec.samples[rec.samples.length - 1];
    if (!last || tEnd - last.t > 0.005) {
      rec.samples.push({
        t: tEnd,
        lon: this._lon,
        lat: this._lat,
        fov: this.camera.fov,
      });
    }
    this._recording = null;
    return { samples: rec.samples, duration: tEnd };
  }

  isRecording() {
    return !!(this._recording && this._recording.active);
  }

  getRecordingElapsed() {
    if (!this._recording || !this._recording.active) return 0;
    return (performance.now() - this._recording.startTime) / 1000;
  }

  // ===== ジャイロ制御（端末の向きで視点を回す）=====
  // DeviceOrientationControls 相当の実装（Three.js addons の旧コード相当）。
  // alpha/beta/gamma → YXZ Euler → lon/lat に反映。screen.orientation.angle を
  // 考慮して portrait/landscape 両対応。録画中は開始時の angle を固定して使用。
  isGyroSupported() {
    if (typeof window === 'undefined') return false;
    if (!('DeviceOrientationEvent' in window)) return false;
    // デスクトップでも API は存在するが実イベントは飛ばないので、タッチ対応端末に限定。
    const touch = (navigator.maxTouchPoints || 0) > 0;
    const coarse = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
    return touch || coarse;
  }

  isGyroActive() {
    return !!this._gyroActive;
  }

  async startGyroscope() {
    if (!this.isGyroSupported()) {
      throw new Error('この端末はジャイロ非対応です / Gyroscope not supported on this device');
    }
    if (this.format === 'spatial') {
      throw new Error('空間写真では利用できません / Not available for spatial photos');
    }
    // iOS 13+ は明示的な許可が必要（クリックハンドラ内で呼ばれる前提）
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const resp = await DeviceOrientationEvent.requestPermission();
      if (resp !== 'granted') {
        throw new Error('ジャイロへのアクセスが許可されませんでした / Permission to access gyroscope was not granted');
      }
    }
    this.stopCameraPlayback();
    this._gyroActive = true;
    this._gyroYawCaptured = false;
    this._gyroOrientAngle = _getScreenOrientAngle();

    this._gyroListener = (e) => this._handleDeviceOrientation(e);
    window.addEventListener('deviceorientation', this._gyroListener);

    this._gyroOrientListener = () => {
      // 録画中は画面回転を無視（開始時点の angle を使い続ける）
      if (this._recording && this._recording.active) return;
      this._gyroOrientAngle = _getScreenOrientAngle();
      // 画面回転で基準ヨーがずれるので再キャリブレーション
      this._gyroYawCaptured = false;
    };
    window.addEventListener('orientationchange', this._gyroOrientListener);
    if (screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener('change', this._gyroOrientListener);
    }
  }

  stopGyroscope() {
    if (!this._gyroActive) return;
    this._gyroActive = false;
    if (this._gyroListener) {
      window.removeEventListener('deviceorientation', this._gyroListener);
      this._gyroListener = null;
    }
    if (this._gyroOrientListener) {
      window.removeEventListener('orientationchange', this._gyroOrientListener);
      if (screen.orientation && screen.orientation.removeEventListener) {
        screen.orientation.removeEventListener('change', this._gyroOrientListener);
      }
      this._gyroOrientListener = null;
    }
  }

  _handleDeviceOrientation(e) {
    if (!this._gyroActive) return;
    if (this.renderer.xr.isPresenting) return;
    if (e.alpha == null && e.beta == null && e.gamma == null) return;

    const alpha = THREE.MathUtils.degToRad(e.alpha || 0);
    const beta = THREE.MathUtils.degToRad(e.beta || 0);
    const gamma = THREE.MathUtils.degToRad(e.gamma || 0);
    const orientDeg = (this._recording && this._recording.active)
      ? (this._recordedOrientAngle || 0)
      : (this._gyroOrientAngle || 0);
    const orient = THREE.MathUtils.degToRad(orientDeg);

    _gyroEuler.set(beta, alpha, -gamma, 'YXZ');
    _gyroQuat.setFromEuler(_gyroEuler);
    _gyroQuat.multiply(_GYRO_Q1);                                   // camera 向きの補正
    _gyroQuat.multiply(_gyroTmp.setFromAxisAngle(_GYRO_ZEE, -orient)); // 画面回転補正

    _gyroOutEuler.setFromQuaternion(_gyroQuat, 'YXZ');
    let lon = -THREE.MathUtils.radToDeg(_gyroOutEuler.y);
    let lat = THREE.MathUtils.radToDeg(_gyroOutEuler.x);

    // 初回または画面回転後: 現在の向きを基準（scene の 0°）に揃える
    if (!this._gyroYawCaptured) {
      this._gyroYawOffset = lon - this._lon;
      this._gyroYawCaptured = true;
    }
    lon = lon - this._gyroYawOffset;
    while (lon > 180) lon -= 360;
    while (lon <= -180) lon += 360;

    if (this.format && this.format.endsWith('180')) {
      lon = Math.max(-85, Math.min(85, lon));
    }
    lat = Math.max(-85, Math.min(85, lat));

    this._lon = lon;
    this._lat = lat;
  }

  _setupControls() {
    const canvas = this.renderer.domElement;
    this._lon = 0;
    this._lat = 0;

    // モード管理: 'none' | 'drag' | 'pinch' | 'stale'
    //   stale = ピンチから 1 指へ戻ったあと、全指が離れるまでドラッグを抑止
    const pointers = new Map();
    let mode = 'none';
    let dragStart = null;      // { id, sx, sy, lon, lat }
    let pinchLast = null;      // 前フレームの 2 指距離
    this._pointers = pointers;

    canvas.addEventListener('pointerdown', (e) => {
      if (this.renderer.xr.isPresenting) return;
      if (this.format === 'spatial') return; // 平面ステレオは視点回転なし
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch {}

      if (pointers.size === 1) {
        if (this._gyroActive) {
          // ジャイロ中は単指ドラッグを無効化
          mode = 'stale';
          return;
        }
        this.stopCameraPlayback();
        dragStart = {
          id: e.pointerId, sx: e.clientX, sy: e.clientY,
          lon: this._lon, lat: this._lat,
        };
        mode = 'drag';
        canvas.style.cursor = 'grabbing';
      } else if (pointers.size === 2) {
        // 2 指ピンチ開始
        const pts = [...pointers.values()];
        pinchLast = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        mode = 'pinch';
        dragStart = null;
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mode === 'drag' && dragStart && e.pointerId === dragStart.id) {
        const dx = e.clientX - dragStart.sx;
        const dy = e.clientY - dragStart.sy;
        this._lon = dragStart.lon - dx * 0.2;
        this._lat = dragStart.lat + dy * 0.2;
        if (this.format && this.format.endsWith('180')) {
          this._lon = Math.max(-85, Math.min(85, this._lon));
        }
        this._lat = Math.max(-85, Math.min(85, this._lat));
      } else if (mode === 'pinch' && pointers.size === 2) {
        // 録画中は画角変更不可（初期画角決定用）
        if (this.isRecording()) return;
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchLast && dist > 0) {
          // 広がる（dist > pinchLast）= ズームイン → FOV を狭める
          const factor = pinchLast / dist;
          const next = this.camera.fov * factor;
          this.camera.fov = Math.max(this._minFov, Math.min(this._maxFov, next));
          this.camera.updateProjectionMatrix();
        }
        pinchLast = dist;
      }
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        mode = 'none';
        dragStart = null;
        pinchLast = null;
        canvas.style.cursor = 'grab';
      } else if (pointers.size === 1) {
        // ピンチから 1 指に戻った → 全指離れるまで新しいドラッグは始めない
        mode = 'stale';
        dragStart = null;
        pinchLast = null;
      }
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener('wheel', (e) => {
      if (this.renderer.xr.isPresenting) return;
      this.stopCameraPlayback();
      e.preventDefault();
      // deltaY>0（下スクロール）= 縮小 → FOV を広げる
      // deltaY<0（上スクロール）= 拡大 → FOV を狭める
      const factor = Math.exp(e.deltaY * 0.0015);
      const next = this.camera.fov * factor;
      this.camera.fov = Math.max(this._minFov, Math.min(this._maxFov, next));
      this.camera.updateProjectionMatrix();
    }, { passive: false });

    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
  }

  _updateCameraRotation() {
    if (this.renderer.xr.isPresenting) return;
    // YXZ Euler: 先に Y(yaw)、次に X(pitch)。lat=±90° で lookAt が破綻するのを避ける。
    // lon 正 = 右向き（景色は左に流れる）、lat 正 = 上向き。
    const lon = THREE.MathUtils.degToRad(this._lon);
    const lat = THREE.MathUtils.degToRad(this._lat);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(lat, -lon, 0);
  }

  _setupResize() {
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.container);
    }
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  createVRButton() {
    return VRButton.createButton(this.renderer);
  }

  getCurrentView() {
    return {
      lon: this._lon,
      lat: this._lat,
      fov: this.camera.fov,
    };
  }

  getFovBounds() {
    return { min: this._minFov, max: this._maxFov, base: this._baseFov };
  }

  setImage(image, format) {
    this.clear();

    const baseTex = new THREE.Texture(image);
    baseTex.colorSpace = THREE.SRGBColorSpace;
    baseTex.minFilter = THREE.LinearFilter;
    baseTex.magFilter = THREE.LinearFilter;
    baseTex.generateMipmaps = false;
    baseTex.needsUpdate = true;
    this._baseTex = baseTex;

    const makeEye = (offset, repeat) => {
      const t = baseTex.clone();
      t.colorSpace = THREE.SRGBColorSpace;
      t.offset.set(offset[0], offset[1]);
      t.repeat.set(repeat[0], repeat[1]);
      t.needsUpdate = true;
      return t;
    };

    if (format === 'mono360') {
      this._addFullSphere(baseTex, 0);
    } else if (format === 'sbs360') {
      this._addFullSphere(makeEye([0, 0], [0.5, 1]), 1);
      this._addFullSphere(makeEye([0.5, 0], [0.5, 1]), 2);
    } else if (format === 'ou360') {
      // 慣例: 上半分 = 左目（flipY 考慮で v=0.5〜1.0 が上半分）
      this._addFullSphere(makeEye([0, 0.5], [1, 0.5]), 1);
      this._addFullSphere(makeEye([0, 0], [1, 0.5]), 2);
    } else if (format === 'mono180') {
      // 単眼 180° 半球（魚眼 unwarp 済み画像などをそのまま貼る）
      this._addHalfSphere(baseTex, 0);
    } else if (format === 'sbs180') {
      this._addHalfSphere(makeEye([0, 0], [0.5, 1]), 1);
      this._addHalfSphere(makeEye([0.5, 0], [0.5, 1]), 2);
    } else if (format === 'ou180') {
      this._addHalfSphere(makeEye([0, 0.5], [1, 0.5]), 1);
      this._addHalfSphere(makeEye([0, 0], [1, 0.5]), 2);
    } else if (format === 'spatial') {
      // Apple 空間写真: SBS 合成済み画像を平面ステレオとして表示
      const singleEyeAspect = parseFloat(image.dataset?.singleEyeAspect)
        || (image.width / 2) / image.height;
      this._setupPlanarStereo(baseTex, singleEyeAspect);
    }

    this.format = format;

    // フォーマット切替時に視点とズームをリセット
    this._lon = 0;
    this._lat = 0;
    this.camera.fov = this._baseFov;
    this.camera.updateProjectionMatrix();
  }

  _addFullSphere(texture, layer) {
    const geo = new THREE.SphereGeometry(500, 64, 32);
    geo.scale(-1, 1, 1); // 内側から見るための反転
    const mat = new THREE.MeshBasicMaterial({ map: texture });
    const mesh = new THREE.Mesh(geo, mat);
    this._setMeshLayer(mesh, layer);
    this.scene.add(mesh);
    this.meshes.push(mesh);
  }

  _addHalfSphere(texture, layer) {
    // 前方 180° 半球: phi ∈ [-π, 0] は +X → -Z → -X をカバー（カメラの前方）
    const geo = new THREE.SphereGeometry(
      500, 64, 32,
      -Math.PI, Math.PI,
      0, Math.PI
    );
    geo.scale(-1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ map: texture });
    const mesh = new THREE.Mesh(geo, mat);
    this._setMeshLayer(mesh, layer);
    this.scene.add(mesh);
    this.meshes.push(mesh);
  }

  // Apple 空間写真用の平面ステレオ。左右の同位置 Plane を別レイヤに配置。
  // FOV は Apple 仕様の約 65° を想定し、カメラから 1m 前方に配置。
  _setupPlanarStereo(baseTex, aspect) {
    const fov = 65; // 度（Apple 空間写真のおおよその水平 FOV）
    const distance = 1.0;
    const planeHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(fov / 2));
    const planeWidth = planeHeight * aspect;

    const makeEye = (offsetU) => {
      const t = baseTex.clone();
      t.colorSpace = THREE.SRGBColorSpace;
      t.offset.set(offsetU, 0);
      t.repeat.set(0.5, 1);
      t.needsUpdate = true;
      return t;
    };

    const addPlane = (texture, layer) => {
      const geo = new THREE.PlaneGeometry(planeWidth, planeHeight);
      geo.translate(0, 0, -distance);
      const mat = new THREE.MeshBasicMaterial({ map: texture });
      const mesh = new THREE.Mesh(geo, mat);
      this._setMeshLayer(mesh, layer);
      this.scene.add(mesh);
      this.meshes.push(mesh);
    };

    addPlane(makeEye(0), 1);    // 左目 = SBS 左半分
    addPlane(makeEye(0.5), 2);  // 右目 = SBS 右半分
  }

  _setMeshLayer(mesh, layer) {
    if (layer === 0) {
      // モノラルは両目に見せる
      mesh.layers.enable(1);
      mesh.layers.enable(2);
    } else {
      mesh.layers.set(layer);
    }
  }

  clear() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      if (m.material.map && m.material.map !== this._baseTex) {
        m.material.map.dispose();
      }
      m.material.dispose();
    }
    this.meshes = [];
    if (this._baseTex) {
      this._baseTex.dispose();
      this._baseTex = null;
    }
  }

  /**
   * 左目の視点でカメラを Y 軸周りに一回転させ、各フレームを JPEG Blob として収集する。
   * 後方互換用。内部では captureCameraSequence に委譲する。
   */
  async captureRotation({ width, height, duration, fps, onProgress }) {
    const steps = [{ type: 'rotate', axis: 'lon', delta: -360, duration }];
    return this.captureCameraSequence({ steps, width, height, fps, onProgress });
  }

  /**
   * ステップ配列に沿ってカメラを動かし、各フレームを JPEG Blob として収集する。
   * ステップ: { type: 'rotate', axis: 'lon'|'lat', delta: 度, duration: 秒 }
   *          { type: 'pause', duration: 秒 }
   *          { type: 'zoom', factor: 数値, duration: 秒 }
   */
  async captureCameraSequence({ steps, start, width, height, fps, onProgress }) {
    const startView = normalizeStart(start, this._baseFov);
    const timeline = compileCameraSteps(steps, startView, this._minFov, this._maxFov);
    const totalDuration = timeline.totalDuration;
    if (totalDuration <= 0) {
      throw new Error('カメラワークの合計時間が 0 秒です / Camera work total duration is 0 seconds');
    }

    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;

    const offRenderer = new THREE.WebGLRenderer({
      canvas: offCanvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    offRenderer.setSize(width, height, false);
    offRenderer.outputColorSpace = THREE.SRGBColorSpace;

    const offCamera = new THREE.PerspectiveCamera(startView.fov, width / height, 0.1, 1100);
    offCamera.layers.enable(1);
    offCamera.position.set(0, 0, 0);
    offCamera.rotation.order = 'YXZ';

    const totalFrames = Math.max(1, Math.round(totalDuration * fps));
    const frames = [];

    try {
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / (totalFrames - 1 || 1)) * totalDuration;
        const { lon, lat, fov } = evalCameraTimeline(timeline, t);
        offCamera.rotation.set(
          THREE.MathUtils.degToRad(lat),
          THREE.MathUtils.degToRad(-lon),
          0
        );
        offCamera.fov = fov;
        offCamera.updateProjectionMatrix();
        offCamera.updateMatrixWorld();

        offRenderer.render(this.scene, offCamera);

        const blob = await new Promise((resolve, reject) => {
          offCanvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
            'image/jpeg',
            0.92
          );
        });
        frames.push(blob);

        if (onProgress) onProgress((i + 1) / totalFrames);
        if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      offRenderer.dispose();
    }

    return { frames, fps };
  }

  /**
   * 録画したサンプル列（{t, lon, lat, fov}）をオフスクリーンで再レンダーし、
   * 各フレームを JPEG Blob として収集する。サンプル列は概ね 60Hz で密に
   * 入っているため、隣接ペアを線形補間するだけで十分滑らか。
   */
  async captureRecordedSequence({ samples, width, height, fps, onProgress }) {
    if (!samples || samples.length < 2) {
      throw new Error('録画データが短すぎます（0.5 秒以上録画してください） / Recording too short (please record at least 0.5 seconds)');
    }
    const tBase = samples[0].t;
    const totalDuration = samples[samples.length - 1].t - tBase;
    if (totalDuration <= 0) {
      throw new Error('録画の合計時間が 0 秒です / Recording total duration is 0 seconds');
    }

    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;

    const offRenderer = new THREE.WebGLRenderer({
      canvas: offCanvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    offRenderer.setSize(width, height, false);
    offRenderer.outputColorSpace = THREE.SRGBColorSpace;

    const initial = samples[0];
    const offCamera = new THREE.PerspectiveCamera(initial.fov, width / height, 0.1, 1100);
    offCamera.layers.enable(1);
    offCamera.position.set(0, 0, 0);
    offCamera.rotation.order = 'YXZ';

    const totalFrames = Math.max(1, Math.round(totalDuration * fps));
    const frames = [];

    try {
      let cursor = 0; // 線形探索の再開位置
      for (let i = 0; i < totalFrames; i++) {
        const t = (i / (totalFrames - 1 || 1)) * totalDuration + tBase;
        while (cursor < samples.length - 2 && samples[cursor + 1].t < t) cursor++;
        const a = samples[cursor];
        const b = samples[cursor + 1] || a;
        const seg = Math.max(1e-6, b.t - a.t);
        const localT = Math.max(0, Math.min(1, (t - a.t) / seg));
        const lon = a.lon + (b.lon - a.lon) * localT;
        const lat = a.lat + (b.lat - a.lat) * localT;
        const fov = a.fov + (b.fov - a.fov) * localT;

        offCamera.rotation.set(
          THREE.MathUtils.degToRad(lat),
          THREE.MathUtils.degToRad(-lon),
          0
        );
        offCamera.fov = fov;
        offCamera.updateProjectionMatrix();
        offCamera.updateMatrixWorld();

        offRenderer.render(this.scene, offCamera);

        const blob = await new Promise((resolve, reject) => {
          offCanvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
            'image/jpeg',
            0.92
          );
        });
        frames.push(blob);

        if (onProgress) onProgress((i + 1) / totalFrames);
        if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      offRenderer.dispose();
    }

    return { frames, fps };
  }

  /**
   * 現在のビューア上でステップを再生する（動作確認用）。
   * lon/lat/fov を書き換えるだけで、既存のレンダループがそれを拾って描画する。
   */
  playCameraSequence(steps, { onEnd, onTick, start } = {}) {
    this.stopCameraPlayback();

    const startView = normalizeStart(start, this._baseFov);
    const timeline = compileCameraSteps(steps, startView, this._minFov, this._maxFov);
    const totalDuration = timeline.totalDuration;
    if (totalDuration <= 0) {
      if (onEnd) onEnd();
      return;
    }

    // 開始位置にスナップ
    this._lon = startView.lon;
    this._lat = startView.lat;
    this.camera.fov = startView.fov;
    this.camera.updateProjectionMatrix();

    this._playbackActive = true;
    this._playbackStart = performance.now();

    const applyFov = (fov) => {
      if (Math.abs(this.camera.fov - fov) > 0.001) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
    };

    const tick = (now) => {
      if (!this._playbackActive) return;
      const elapsed = (now - this._playbackStart) / 1000;
      if (elapsed >= totalDuration) {
        const last = timeline.segments[timeline.segments.length - 1];
        this._lon = last.endLon;
        this._lat = last.endLat;
        applyFov(last.endFov);
        this._playbackActive = false;
        if (onTick) onTick(1);
        if (onEnd) onEnd();
        return;
      }
      const { lon, lat, fov } = evalCameraTimeline(timeline, elapsed);
      this._lon = lon;
      this._lat = lat;
      applyFov(fov);
      if (onTick) onTick(elapsed / totalDuration);
      this._playbackRaf = requestAnimationFrame(tick);
    };
    this._playbackRaf = requestAnimationFrame(tick);
  }

  stopCameraPlayback() {
    this._playbackActive = false;
    if (this._playbackRaf) {
      cancelAnimationFrame(this._playbackRaf);
      this._playbackRaf = 0;
    }
  }

  isPlayingSequence() {
    return !!this._playbackActive;
  }

  dispose() {
    this.stopCameraPlayback();
    this.clear();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    window.removeEventListener('resize', this._onResize);
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }
}

function normalizeStart(start, baseFov) {
  return {
    lon: Number(start?.lon) || 0,
    lat: Number(start?.lat) || 0,
    fov: Number(start?.fov) || baseFov,
  };
}

/**
 * ステップ配列からタイムライン（各区間の lon/lat/fov 補間情報）を作る。
 * 入力ステップ（app.js 側のスキーマ）:
 *   { type: 'rotate', axis: 'lon'|'lat', delta: 度, duration: 秒 }
 *   { type: 'pause', duration: 秒 }
 *   { type: 'zoom', factor: 数値, duration: 秒 }  // factor<1 でズームイン、>1 でアウト
 *   { type: 'figure8', ampLon: 度, ampLat: 度, duration: 秒 }  // 開始点を中心に横8の字を1周
 */
export function compileCameraSteps(steps, startView = { lon: 0, lat: 0, fov: 75 }, fovMin = 25, fovMax = 100) {
  const segments = [];
  let cursor = 0;
  let lon = startView.lon;
  let lat = startView.lat;
  let fov = startView.fov;
  for (const s of steps) {
    const duration = Math.max(0, Number(s.duration) || 0);
    if (duration <= 0) continue;
    const startLon = lon;
    const startLat = lat;
    const startFov = fov;
    let endLon = lon;
    let endLat = lat;
    let endFov = fov;
    const seg = {
      type: s.type || 'pause',
      startTime: cursor,
      endTime: cursor + duration,
      startLon, startLat, startFov,
    };
    if (s.type === 'rotate') {
      const delta = Number(s.delta) || 0;
      if (s.axis === 'lon') endLon = lon + delta;
      else if (s.axis === 'lat') endLat = lat + delta;
    } else if (s.type === 'zoom') {
      const factor = Number(s.factor) || 1;
      endFov = Math.max(fovMin, Math.min(fovMax, fov * factor));
    } else if (s.type === 'figure8') {
      // 開始点を中心に ∞ を一周。終了時は開始点に戻る（sin(0)=sin(2π)=0）
      seg.ampLon = Number(s.ampLon) || 0;
      seg.ampLat = Number(s.ampLat) || 0;
    }
    seg.endLon = endLon;
    seg.endLat = endLat;
    seg.endFov = endFov;
    segments.push(seg);
    cursor += duration;
    lon = endLon;
    lat = endLat;
    fov = endFov;
  }
  return { segments, totalDuration: cursor };
}

export function evalCameraTimeline(timeline, t) {
  const { segments } = timeline;
  if (segments.length === 0) return { lon: 0, lat: 0, fov: 75 };
  if (t <= 0) {
    const first = segments[0];
    return { lon: first.startLon, lat: first.startLat, fov: first.startFov };
  }
  if (t >= timeline.totalDuration) {
    const last = segments[segments.length - 1];
    return { lon: last.endLon, lat: last.endLat, fov: last.endFov };
  }
  // 線形探索で十分（数十ステップ程度を想定）
  for (const seg of segments) {
    if (t < seg.endTime) {
      const localT = (t - seg.startTime) / Math.max(1e-6, seg.endTime - seg.startTime);
      if (seg.type === 'figure8') {
        // x = A sin(t), y = (B) sin(2t), t ∈ [0, 2π]
        const phase = localT * 2 * Math.PI;
        return {
          lon: seg.startLon + seg.ampLon * Math.sin(phase),
          lat: seg.startLat + seg.ampLat * Math.sin(2 * phase),
          fov: seg.startFov,
        };
      }
      return {
        lon: seg.startLon + (seg.endLon - seg.startLon) * localT,
        lat: seg.startLat + (seg.endLat - seg.startLat) * localT,
        fov: interpFovLog(seg.startFov, seg.endFov, localT),
      };
    }
  }
  const last = segments[segments.length - 1];
  return { lon: last.endLon, lat: last.endLat, fov: last.endFov };
}

// 対数空間で fov を補間すると「一定速度のズーム」に感じられる。
function interpFovLog(a, b, t) {
  if (a === b) return a;
  const la = Math.log(a);
  const lb = Math.log(b);
  return Math.exp(la + (lb - la) * t);
}
