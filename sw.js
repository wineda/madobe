/* madobe — Service Worker
 *
 * 役割：
 *   - インストール時にアプリ本体（HTML・JS・マニフェスト・アイコン）をキャッシュする
 *   - 同一オリジンのファイルはネットワーク優先（更新をすぐ反映）、失敗時はキャッシュ
 *   - CDN（three.js）と Google Fonts はキャッシュ優先（一度読めばオフラインでも動く）
 *
 * ファイルを増やしたら APP_FILES に足し、中身を変えたら VERSION を上げる（古いキャッシュを捨てるため）。
 */
const VERSION = 'madobe-v3';
const APP_CACHE = VERSION + '-app';
const RUNTIME_CACHE = VERSION + '-runtime';
const APP_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/app.js',
  './src/scenes/night-rain.js',
  './src/scenes/dusk-rain.js',
  './src/scenes/campfire.js',
  './src/scenes/windy-meadow.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];
const RUNTIME_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('madobe-') && k !== APP_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // ナビゲーション（ページ本体）はハッシュ違いでも同じ index.html
    const key = req.mode === 'navigate' ? './index.html' : req;
    event.respondWith(networkFirst(key, req, APP_CACHE));
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
  }
});

async function networkFirst(key, req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}
