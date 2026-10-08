// Кеш для быстрой загрузки:
//   аватарки Telegram — сразу из кеша, в фоне обновляются (новая аватарка видна со следующего раза);
//   файлы сборки /assets/* (хеш в имени) — из кеша;
//   страница — из сети, без сети — из кеша. Запросы к /api не кешируются.
// Поменять версию — старые кеши удалятся при активации.
const STATIC = 'kkmt-static-v1';
const AVATARS = 'kkmt-avatars-v1';
const MAX_AVATARS = 300;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== STATIC && k !== AVATARS) await caches.delete(k);
    await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin === location.origin) {
        if (url.pathname.startsWith('/api/')) return;
        if (url.pathname.startsWith('/assets/')) return e.respondWith(cacheFirst(req));
        if (req.mode === 'navigate') return e.respondWith(networkFirst(req));
        return;
    }
    if (req.destination === 'image') e.respondWith(staleWhileRevalidate(req, e));
});

async function cacheFirst(req) {
    const cache = await caches.open(STATIC);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
}

async function networkFirst(req) {
    const cache = await caches.open(STATIC);
    try {
        const res = await fetch(req);
        if (res.ok) cache.put('/', res.clone());
        return res;
    } catch {
        return (await cache.match('/')) ?? Response.error();
    }
}

// Картинка с другого сайта приходит «непрозрачной» (opaque) — её тоже можно хранить и показывать.
async function staleWhileRevalidate(req, e) {
    const cache = await caches.open(AVATARS);
    const hit = await cache.match(req);
    const update = fetch(req).then(async res => {
        if (res.ok || res.type === 'opaque') {
            await cache.put(req, res.clone());
            const keys = await cache.keys();
            for (const k of keys.slice(0, Math.max(0, keys.length - MAX_AVATARS))) await cache.delete(k);
        }
        return res;
    });
    if (hit) { e.waitUntil(update.catch(() => {})); return hit; }
    return update;
}
