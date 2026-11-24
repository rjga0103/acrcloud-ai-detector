import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  getConfig,
  setConfig,
  sanitizeConfig,
  ensureDirs,
  UPLOAD_DIR
} from './lib/config.js';
import * as store from './lib/store.js';
import { startWorker, wake, queueIds, cleanupFile } from './lib/pipeline.js';
import * as acr from './lib/acr.js';
import * as usageMeter from './lib/usage.js';
import { toCsv } from './lib/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD = 1024 * 1024 * 1024;

const AUDIO_EXT = new Set([
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.alac', '.amr',
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi'
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Cuerpo de petición demasiado grande');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeName(raw) {
  const base = path.basename(String(raw || '').replaceAll('\\', '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return base.slice(0, 180) || `audio-${Date.now()}.mp3`;
}

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a' || ext === '.aac') return 'audio/mp4';
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  return 'audio/mpeg';
}

async function handleUpload(req, res, url) {
  const name = safeName(url.searchParams.get('name'));
  const batchId = String(url.searchParams.get('batch') || `b-${Date.now()}`);
  const ext = path.extname(name).toLowerCase();
  if (!AUDIO_EXT.has(ext)) {
    return fail(res, 415, `Formato no soportado: ${ext || 'sin extensión'}`);
  }

  const id = crypto.randomUUID();
  const target = path.join(UPLOAD_DIR, `${id}${ext}`);
  const expected = Number(req.headers['content-length'] || 0);
  if (expected > MAX_UPLOAD) return fail(res, 413, 'Archivo demasiado grande (máx. 1 GB)');

  let written = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target);
      req.on('data', (chunk) => {
        written += chunk.length;
        if (written > MAX_UPLOAD) {
          req.destroy();
          reject(new Error('Archivo demasiado grande (máx. 1 GB)'));
        }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
  } catch (err) {
    await fsp.rm(target, { force: true });
    return fail(res, 400, err.message);
  }

  if (!written) {
    await fsp.rm(target, { force: true });
    return fail(res, 400, 'Archivo vacío');
  }

  const cfg = getConfig();
  const record = {
    id,
    name,
    storedName: path.basename(target),
    path: target,
    size: written,
    mime: mimeFor(name),
    batchId,
    status: cfg.autoQueue ? 'queued' : 'staged',
    progress: 0,
    error: null,
    attempts: 0,
    acrFileId: null,
    containerId: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    summary: null,
    demo: false
  };

  const container = store.state.containers[batchId];
  if (container) record.containerId = container;
  store.addFile(record);
  wake();
  sendJson(res, 201, { file: store.publicFile(record), autoQueue: cfg.autoQueue });
}

async function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return fail(res, 403, 'Ruta no permitida');
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return fail(res, 404, 'No encontrado');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    fail(res, 404, 'No encontrado');
  }
}

const routes = [
  ['GET', /^\/api\/state$/, async (req, res) => {
    const cfg = getConfig();
    let billing = {};
    if (cfg.token && !cfg.demo) {
      try {
        billing = await acr.getBilling(cfg);
      } catch {
        billing = {};
      }
    }
    const bounds = usageMeter.cycleBounds(billing.nextBillDate, cfg.cycleDay);
    const totals = usageMeter.windowTotals(store.state.usage, bounds.start, bounds.end);
    const quotaSeconds = Math.max(0, Number(cfg.planQuotaMinutes) || 0) * 60;
    const avgSeconds = totals.files ? Math.round((totals.seconds / totals.files) * 10) / 10 : 0;
    const remainingSeconds = quotaSeconds > 0 ? Math.max(0, quotaSeconds - totals.seconds) : null;
    const usage = {
      cycleStart: usageMeter.dayKey(bounds.start),
      cycleEnd: usageMeter.dayKey(bounds.end),
      daysLeft: usageMeter.daysLeft(bounds.end),
      seconds: totals.seconds,
      files: totals.files,
      avgSeconds,
      quotaSeconds,
      remainingSeconds,
      remainingFiles: usageMeter.estimateRemaining(remainingSeconds, avgSeconds),
      percent: quotaSeconds > 0 ? Math.min(100, Math.round((totals.seconds / quotaSeconds) * 1000) / 10) : null,
      nextBillDate: billing.nextBillDate || null,
      credits: billing.availableCredits ?? null,
      billingError: billing.error || null
    };
    sendJson(res, 200, {
      config: sanitizeConfig(cfg),
      files: store.state.files.map(store.publicFile),
      counts: store.countByStatus(),
      container: store.state.container,
      containers: store.state.containers,
      usage,
      uptime: process.uptime()
    });
  }],

  ['POST', /^\/api\/config$/, async (req, res) => {
    const patch = await readJson(req);
    const before = getConfig();
    const next = setConfig(patch);
    if (patch.token != null && patch.token !== before.token) {
      store.state.containers = {};
      store.save();
    }
    sendJson(res, 200, { config: sanitizeConfig(next) });
  }],

  ['POST', /^\/api\/test$/, async (req, res) => {
    try {
      const result = await acr.testConnection(getConfig());
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { ok: false, message: err.message });
    }
  }],

  ['POST', /^\/api\/upload$/, handleUpload],

  ['POST', /^\/api\/queue$/, async (req, res) => {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) && body.ids.length
      ? body.ids
      : store.state.files.filter((f) => f.status === 'staged').map((f) => f.id);
    sendJson(res, 200, { queued: queueIds(ids) });
  }],

  ['POST', /^\/api\/retry$/, async (req, res) => {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) && body.ids.length
      ? body.ids
      : store.state.files.filter((f) => f.status === 'error' || f.status === 'canceled').map((f) => f.id);
    sendJson(res, 200, { queued: queueIds(ids) });
  }],

  ['POST', /^\/api\/cancel$/, async (req, res) => {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    let canceled = 0;
    for (const id of ids) {
      const rec = store.getFile(id);
      if (!rec) continue;
      if (['queued', 'uploading', 'processing'].includes(rec.status)) {
        store.updateFile(id, { status: 'canceled', error: 'Cancelado por el usuario', progress: 100 });
        canceled += 1;
      }
    }
    wake();
    sendJson(res, 200, { canceled });
  }],

  ['DELETE', /^\/api\/files\/([\w-]+)$/, async (req, res, url, m) => {
    const rec = store.getFile(m[1]);
    if (!rec) return fail(res, 404, 'Archivo no encontrado');
    store.removeFile(rec.id);
    await cleanupFile(rec);
    sendJson(res, 200, { ok: true });
  }],

  ['GET', /^\/api\/files\/([\w-]+)\/detail$/, async (req, res, url, m) => {
    const rec = store.getFile(m[1]);
    if (!rec) return fail(res, 404, 'Archivo no encontrado');
    sendJson(res, 200, { file: store.publicFile(rec) });
  }],

  ['POST', /^\/api\/clear$/, async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const mode = body.mode === 'all' ? 'all' : 'done';
    const keep = [];
    let removed = 0;
    for (const rec of store.state.files) {
      const finished = ['done', 'error', 'canceled'].includes(rec.status);
      if (mode === 'all' ? finished : rec.status === 'done') {
        removed += 1;
        await cleanupFile(rec);
      } else {
        keep.push(rec);
      }
    }
    store.state.files = keep;
    store.save();
    sendJson(res, 200, { removed });
  }],

  ['POST', /^\/api\/container\/reset$/, async (req, res) => {
    const body = await readJson(req).catch(() => ({}));
    const cfg = getConfig();
    const keepId = store.state.container?.id ?? null;
    const result = await acr.purgeContainers(cfg, { all: body.all === true, keepId });
    const removedActive =
      store.state.container && result.deleted.some((d) => String(d.id) === String(store.state.container.id));
    if (removedActive) {
      store.state.container = null;
      store.save();
    }
    if (result.remaining.length === 0) {
      store.state.container = null;
      store.state.containers = {};
      store.save();
    }
    sendJson(res, 200, {
      total: result.total,
      deleted: result.deleted.length,
      failed: result.failed,
      remaining: result.remaining.map((c) => ({ id: c.id, name: c.name }))
    });
  }],

  ['GET', /^\/api\/export\.csv$/, async (req, res) => {
    const csv = `\ufeff${toCsv(store.state.files)}`;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="acrcloud-ai-${stamp}.csv"`,
      'Content-Length': Buffer.byteLength(csv)
    });
    res.end(csv);
  }],

  ['GET', /^\/api\/health$/, async (req, res) => {
    sendJson(res, 200, { ok: true, node: process.version, demo: getConfig().demo });
  }]
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) {
    return handleStatic(req, res, pathname);
  }

  for (const [method, pattern, handler] of routes) {
    if (req.method !== method) continue;
    const match = pattern.exec(pathname);
    if (!match) continue;
    try {
      await handler(req, res, url, match);
    } catch (err) {
      console.error(`[api] ${method} ${pathname}:`, err.message);
      if (!res.headersSent) fail(res, 500, err.message || 'Error interno');
    }
    return;
  }

  fail(res, 404, 'Endpoint no encontrado');
});

ensureDirs();
const cfg = getConfig();
store.load();
startWorker();

server.listen(PORT, HOST, () => {
  const mode = cfg.demo ? 'MODO DEMO (sin llamadas a ACRCloud)' : cfg.token ? 'conectado con token' : 'sin token';
  console.log('');
  console.log('  ACRCloud AI Detector');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  Estado: ${mode}`);
  console.log('');
});

process.on('SIGINT', () => {
  store.saveNow();
  process.exit(0);
});
process.on('SIGTERM', () => {
  store.saveNow();
  process.exit(0);
});
