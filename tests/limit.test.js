import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'acr-limit-'));

const results = {
  ai_detection: [
    { stem: 'original', prediction: 'human', ai_probability: 12.5, duration: 30, likely_source: 'Human' }
  ]
};

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

const stats = { creates: 0, deletes: 0, purged: false };

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/fs-containers') {
    const data = stats.purged
      ? []
      : [{ id: 900, name: 'ACRCloud AI Detector', region: 'eu-west-1', engine: 1 }];
    return send(res, 200, { data, meta: { last_page: 1, total: data.length } });
  }
  if (req.method === 'POST' && url.pathname === '/api/fs-containers') {
    stats.creates += 1;
    if (!stats.purged) {
      return send(res, 400, { status: { msg: 'Your containers exceeds limits, Please contact Support for more resources' } });
    }
    return send(res, 201, { data: { id: 901, region: 'eu-west-1', engine: 5, name: 'ACRCloud AI Detector' } });
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/fs-containers/')) {
    stats.deletes += 1;
    stats.purged = true;
    return send(res, 204);
  }
  if (req.method === 'GET' && url.pathname === '/api/fs-containers/901/presigned-upload') {
    return send(res, 200, { url: `http://127.0.0.1:${fake.address().port}/s3/put`, key: 'k', file_id: 'f1' });
  }
  if (req.method === 'PUT' && url.pathname === '/s3/put') {
    for await (const _chunk of req) { /* drena */ }
    return send(res, 200);
  }
  if (req.method === 'POST' && url.pathname === '/api/fs-containers/901/files') {
    for await (const _chunk of req) { /* drena */ }
    return send(res, 200, { data: { id: 'f1' } });
  }
  if (req.method === 'GET' && url.pathname === '/api/fs-containers/901/files/f1') {
    return send(res, 200, { data: [{ id: 'f1', state: 1, duration: 30, results }] });
  }
  if (process.env.FAKE_DEBUG) console.error('404 =>', req.method, url.pathname);
  send(res, 404, { status: { msg: 'not found' } });
});

const foreign = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/fs-containers') {
    return send(res, 200, { data: [{ id: 1, name: 'otra app', region: 'eu-west-1', engine: 1 }], meta: { last_page: 1, total: 1 } });
  }
  if (req.method === 'POST' && url.pathname === '/api/fs-containers') {
    return send(res, 400, { status: { msg: 'Your containers exceeds limits, Please contact Support for more resources' } });
  }
  if (req.method === 'DELETE') return send(res, 204);
  send(res, 404, { status: { msg: 'not found' } });
});

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
const fakeBase = `http://127.0.0.1:${fake.address().port}`;

process.env.DATA_DIR = path.join(tmp, 'data');
process.env.ACR_API_ROOT = fakeBase;
process.env.ACR_REGION_ROOT = fakeBase;

const { setConfig, ensureDirs } = await import('../lib/config.js');
ensureDirs();
setConfig({ token: 'token-test', demo: false, pollMs: 50, timeoutMs: 15000, concurrency: 1, buckets: [1], engine: 5 });

const store = await import('../lib/store.js');
const { runFile } = await import('../lib/pipeline.js');
store.load();

function makeRecord(id) {
  const audioPath = path.join(tmp, `${id}.mp3`);
  if (!fs.existsSync(audioPath)) fs.writeFileSync(audioPath, Buffer.from('ID3fake'));
  return {
    id,
    name: `${id}.mp3`,
    storedName: `${id}.mp3`,
    path: audioPath,
    size: fs.statSync(audioPath).size,
    mime: 'audio/mpeg',
    batchId: 'b-test',
    status: 'queued',
    progress: 0,
    attempts: 0,
    createdAt: new Date().toISOString()
  };
}

test('si el plan está lleno: purga los contenedores de la app y reintenta', async () => {
  store.addFile(makeRecord('rec-limit'));
  await runFile(store.getFile('rec-limit'));

  const done = store.getFile('rec-limit');
  assert.equal(done.status, 'done');
  assert.equal(stats.creates, 2, 'primer create falla por límite, segundo funciona tras purgar');
  assert.equal(stats.deletes, 1);
  assert.equal(store.state.container.id, 901);
});

test('reutiliza el mismo contenedor en lotes siguientes', async () => {
  store.addFile(makeRecord('rec-reuse'));
  await runFile(store.getFile('rec-reuse'));
  assert.equal(store.getFile('rec-reuse').status, 'done');
  assert.equal(stats.creates, 2, 'no crea contenedores nuevos');
  assert.equal(store.state.container.id, 901);
});

test('si no puede liberar espacio, error claro y accionable', async () => {
  process.env.ACR_API_ROOT = `http://127.0.0.1:${foreign.address().port}`;
  process.env.ACR_REGION_ROOT = process.env.ACR_API_ROOT;
  setConfig({ engine: 1 }); // fuerza contenedor nuevo para esta configuración

  store.addFile(makeRecord('rec-blocked'));
  await assert.rejects(() => runFile(store.getFile('rec-blocked')), /límite|limite/i);
  process.env.ACR_API_ROOT = fakeBase;
  process.env.ACR_REGION_ROOT = fakeBase;
});

test.after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
  await new Promise((r) => fake.close(r));
  await new Promise((r) => foreign.close(r));
});
