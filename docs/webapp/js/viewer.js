import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

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
      this.renderer.render(this.scene, this.camera);
    });
  }

  _setupControls() {
    const canvas = this.renderer.domElement;
    this._lon = 0;
    this._lat = 0;
    this._pointerDown = false;
    this._pointerStart = { x: 0, y: 0 };
    this._startLonLat = { lon: 0, lat: 0 };

    canvas.addEventListener('pointerdown', (e) => {
      if (this.renderer.xr.isPresenting) return;
      if (this.format === 'spatial') return; // 平面ステレオは視点回転なし
      this._pointerDown = true;
      this._pointerStart = { x: e.clientX, y: e.clientY };
      this._startLonLat = { lon: this._lon, lat: this._lat };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this._pointerDown) return;
      const dx = e.clientX - this._pointerStart.x;
      const dy = e.clientY - this._pointerStart.y;
      this._lon = this._startLonLat.lon - dx * 0.2;
      this._lat = this._startLonLat.lat + dy * 0.2;

      if (this.format && this.format.endsWith('180')) {
        this._lon = Math.max(-85, Math.min(85, this._lon));
      }
      this._lat = Math.max(-85, Math.min(85, this._lat));
    });

    const release = () => {
      this._pointerDown = false;
      canvas.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener('wheel', (e) => {
      if (this.renderer.xr.isPresenting) return;
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
    const lon = THREE.MathUtils.degToRad(this._lon);
    const lat = THREE.MathUtils.degToRad(this._lat);
    const cosLat = Math.cos(lat);
    const tx = Math.sin(lon) * cosLat;
    const ty = Math.sin(lat);
    const tz = -Math.cos(lon) * cosLat;
    this.camera.lookAt(tx, ty, tz);
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
   */
  async captureRotation({ width, height, duration, fps, onProgress }) {
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

    const offCamera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1100);
    offCamera.layers.enable(1);
    offCamera.position.set(0, 0, 0);

    const totalFrames = Math.max(1, Math.round(duration * fps));
    const frames = [];

    try {
      for (let i = 0; i < totalFrames; i++) {
        const angle = (i / totalFrames) * Math.PI * 2;
        offCamera.rotation.set(0, angle, 0);
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

  dispose() {
    this.clear();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    window.removeEventListener('resize', this._onResize);
    if (this._resizeObserver) this._resizeObserver.disconnect();
  }
}
