#!/usr/bin/env node
/**
 * Локальный микро-прокси для обхода браузерного CORS при вызове Yandex Cloud API с GitHub Pages.
 * Запускается ТОЛЬКО на компьютере ведущего (0 зависимостей, стандартный Node.js 18+):
 *   node yandex-bridge.mjs
 */
import http from 'node:http';

const PORT = process.env.PORT || 31337;
const YANDEX_OPENAI_URL = 'https://llm.api.cloud.yandex.net/v1/chat/completions';

const server = http.createServer(async (req, res) => {
  // Разрешаем запросы с GitHub Pages и localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Yandex-Key, X-Folder-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'party-sync-yandex-bridge' }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;

    const apiKey = req.headers['x-yandex-key'] || process.env.YC_API_KEY || '';
    const folderId = req.headers['x-folder-id'] || process.env.YC_FOLDER_ID || '';

    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Не передан API-ключ Yandex Cloud' }));
      return;
    }

    try {
      const authHeader = apiKey.startsWith('t1.') ? `Bearer ${apiKey}` : `Api-Key ${apiKey}`;
      const upstream = await fetch(YANDEX_OPENAI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          ...(folderId ? { 'x-folder-id': folderId } : {})
        },
        body
      });

      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 YandexGPT Local Bridge запущен на http://127.0.0.1:${PORT}`);
  console.log(`✅ Теперь GitHub Pages может обращаться к Yandex Cloud API без ошибок CORS!\n`);
});
