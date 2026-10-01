'use strict';

// Server mode is the real build mode. It intentionally does not modify or load
// any .env file; the hosting panel/environment remains the source of config.
process.env.BUILD_SERVER_MODE = '1';

const http = require('http');
const { bot, localBuildManager, buildRoot } = require('./api/bot');

const PORT = Math.max(1, Number(process.env.PORT || 3000));

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'Raven Build Server',
      mode: 'server',
      uptime: Math.round(process.uptime()),
      queue: localBuildManager.queue.length,
      running: localBuildManager.running.size,
    });
  }

  if (req.method === 'GET' && url.pathname === '/health/flutter') {
    try {
      const result = await localBuildManager.preflight('flutter');
      return json(res, result.ok ? 200 : 503, result);
    } catch (error) {
      return json(res, 500, { ok: false, error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/health/web-apk') {
    try {
      const result = await localBuildManager.preflight('android');
      return json(res, result.ok ? 200 : 503, result);
    } catch (error) {
      return json(res, 500, { ok: false, error: error.message });
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

async function shutdown(signal) {
  console.log(`[SERVER] ${signal} diterima. Menghentikan bot dan HTTP server...`);
  try { await bot.stop(signal); } catch (error) { console.error('[SERVER] bot.stop:', error.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

async function main() {
  await localBuildManager.init();
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    console.log('[SERVER] Webhook dimatikan; mode polling aktif.');
  } catch (error) {
    console.error('[SERVER] Gagal memastikan polling:', error.message);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Raven Build Server aktif di port ${PORT}`);
    console.log(`[SERVER] Build storage: ${buildRoot}`);
    console.log('[SERVER] Health: /health · /health/flutter · /health/web-apk');
  });

  try {
    await bot.launch({ dropPendingUpdates: false });
    console.log('[SERVER] Telegram polling aktif.');
  } catch (error) {
    console.error('[SERVER] Bot launch gagal:', error);
    server.close();
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((error) => {
  console.error('[SERVER] Fatal:', error);
  process.exit(1);
});
