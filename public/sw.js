/**
 * BarberApp - Service Worker
 * Ağ öncelikli (Network-first) strateji ve çevrimdışı (offline) önbellekleme
 */

const CACHE_NAME = 'barberapp-v8';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './i18n.js',
  './data.js',
  './manifest.json'
];

// Yükleme aşaması: Temel statik dosyaları önbelleğe al
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Dosyaların tek tek eklenmesi, eksik dosya durumunda diğerlerinin engellenmesini önler
      await Promise.allSettled(
        STATIC_ASSETS.map((asset) =>
          cache.add(asset).catch((err) => {
            console.warn(`[Service Worker] Önbelleğe alma uyarısı (${asset}):`, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Etkinleştirme aşaması: Eski önbellekleri temizle
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[Service Worker] Eski önbellek temizleniyor:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// İstek yakalama aşaması: Network-first (Önce Ağ, Başarısız Olursa Önbellek)
self.addEventListener('fetch', (event) => {
  // Yalnızca GET isteklerini ele al
  if (event.request.method !== 'GET') {
    return;
  }

  // Yalnızca HTTP/HTTPS isteklerini işle (chrome-extension vb. istekleri atla)
  if (!event.request.url.startsWith('http')) {
    return;
  }

  // API ve sağlık kontrolü isteklerini asla önbellekten döndürme
  const url = new URL(event.request.url);
  if (url.pathname === '/health' || url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Ağ isteği başarılıysa yanıtı klonlayıp önbelleğe kaydet
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Ağ bağlantısı yoksa veya başarısız olursa önbellekten getir
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }

          // Sayfa geçişlerinde (navigate) önbellekteki index.html'e geri dön
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html') || caches.match('/');
          }

          return new Response('Ağ bağlantısı yok ve içerik önbellekte bulunamadı.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' })
          });
        });
      })
  );
});
