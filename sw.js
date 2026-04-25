// Service Worker for spatial2flip PWA
//
// 戦略:
//   - install: App Shell（同一オリジン静的ファイル）を事前キャッシュ
//   - activate: 古いキャッシュの掃除 + クライアント取得 + 主要 CDN/WASM を
//     バックグラウンドで事前取得（ユーザー操作を待たずにオフライン準備）
//   - fetch: cache-first で応答、ネットワーク取得時は自動でキャッシュ追加
//
// バージョン変更時は CACHE_VERSION を上げると古いキャッシュが掃除される。

const CACHE_VERSION = 'v4';
const CACHE_NAME = `spatial2flip-${CACHE_VERSION}`;

// 同一オリジンの App Shell。install 時に確実にキャッシュする。
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/viewer.js',
  './js/converter.js',
  './js/heic.js',
  './js/fisheye.js',
  './icons/favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/screenshot-wide.png',
  './icons/screenshot-narrow.png',
];

// CDN 上の大物（Three.js / ffmpeg.wasm / libheif）。activate 後にバックグラウンド取得。
// CDN の URL は converter.js / heic.js / index.html の importmap と一致させる。
const OFFLINE_CDN = [
  'https://unpkg.com/three@0.162.0/build/three.module.js',
  'https://unpkg.com/three@0.162.0/examples/jsm/webxr/VRButton.js',
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js',
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js',
  'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js',
  'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm',
  'https://unpkg.com/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // App Shell は個別 add で失敗時に他を潰さないように
    await Promise.all(APP_SHELL.map((u) =>
      cache.add(u).catch((e) => console.warn('[sw] app-shell cache failed:', u, e))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
  // Activate 完了をブロックしないバックグラウンド事前取得
  event.waitUntil(prefetchCDN());
});

async function prefetchCDN() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(OFFLINE_CDN.map(async (url) => {
    try {
      // 既にキャッシュ済みならスキップ
      const hit = await cache.match(url);
      if (hit) return;
      // CORS モードでリクエスト（unpkg は CORS 対応）
      const req = new Request(url, { mode: 'cors', credentials: 'omit' });
      const resp = await fetch(req);
      if (resp && (resp.ok || resp.type === 'opaque')) {
        await cache.put(url, resp.clone());
      }
    } catch (e) {
      console.warn('[sw] prefetch failed:', url, e);
    }
  }));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // ページ遷移（SPA の navigation）は専用分岐（オフライン時に index.html を返す）
  if (req.mode === 'navigate') {
    event.respondWith(navigationHandler(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && (fresh.ok || fresh.type === 'opaque')) {
      // Response は一度しか読めないので clone してキャッシュ
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    // オフライン + 未キャッシュ → 失敗（ページの上位で握る）
    throw err;
  }
}

async function navigationHandler(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (err) {
    // オフラインなら App Shell の index.html にフォールバック
    const cache = await caches.open(CACHE_NAME);
    const fallback = await cache.match('./index.html') || await cache.match('./');
    if (fallback) return fallback;
    throw err;
  }
}
