/* Service Worker pour générer et servir un fichier de 400MB hors ligne */
const CACHE_NAME = 'sw-large-file-v1';
const FILE_URL = '/demo-service-worker/bigfile.bin';

self.addEventListener('install', (event) => {
  // Pas de pré-cache. On génère à la demande.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function createZeroStream(totalBytes, onProgress) {
  const CHUNK = 1024 * 1024; // 1MB
  let remaining = totalBytes;
  const chunk = new Uint8Array(CHUNK); // rempli de zéros par défaut
  return new ReadableStream({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const n = Math.min(CHUNK, remaining);
      controller.enqueue(n === CHUNK ? chunk : chunk.slice(0, n));
      remaining -= n;
      if (onProgress) onProgress(totalBytes - remaining, totalBytes);
    }
  });
}

async function putGeneratedFile(size) {
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
    'X-Generated': 'true',
  });
  const stream = createZeroStream(size);
  // Créer une Response qui sera lue une seule fois par Cache.put
  const response = new Response(stream, { headers, status: 200 });
  const cache = await caches.open(CACHE_NAME);
  await cache.put(FILE_URL, response);
  return size;
}

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  const reply = (data) => port && port.postMessage(data);
  const replyErr = (err) => port && port.postMessage({ error: String(err) });

  (async () => {
    const { type, size } = event.data || {};
    if (type === 'GENERATE_AND_CACHE') {
      try {
        const t0 = Date.now();
        const bytes = await putGeneratedFile(size || 400 * 1024 * 1024);
        const ms = Date.now() - t0;
        reply({ ok: true, bytesWritten: bytes, ms });
      } catch (e) {
        replyErr(e);
      }
      return;
    }
    if (type === 'DELETE_CACHED') {
      try {
        const cache = await caches.open(CACHE_NAME);
        const ok = await cache.delete(FILE_URL);
        reply({ ok });
      } catch (e) {
        replyErr(e);
      }
      return;
    }
    replyErr('Type de message non supporté');
  })();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Servir le fichier généré depuis le cache, y compris hors ligne
  if (url.pathname === FILE_URL) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(FILE_URL, { ignoreSearch: true });
        if (hit) return hit;
        // Pas encore généré: 404 explicite
        return new Response('bigfile.bin non disponible. Générez-le d\'abord.', { status: 404 });
      })()
    );
    return;
  }

  // Navigation: network-first avec fallback cache si besoin (optionnel)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(event.request);
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const index = await cache.match('/'); // si jamais vous avez pré-caché l'index
          return index || new Response('<h1>Hors ligne</h1><p>Le contenu demandé n\'est pas en cache.</p>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
      })()
    );
  }
});
