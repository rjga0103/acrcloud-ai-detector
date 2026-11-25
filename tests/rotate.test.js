import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'acr-rotate-'));

const results = {
  ai_detection: [{ stem: 'original', prediction: 'ai_generated', ai_probability: 77, duration: 20 }]
};

const stats = { creates: 0, deletes: 0, current: null, mode: 'quota' };

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end();
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function reject(res) {
  if (stats.mode === 'quota') {
    return send(res, 400, {
      error: "Your container's size exceeds limits, Please contact Support for more resources"
    });
  }
  return send(res, 400, { error: 'Invalid Container' });
}

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/fs-containers') {
    return send(res, 200, { data: [], meta: { last_page: 1, total: 0 } });
  }
  if (req.method === 'POST' && url.pathname === '/api/fs-containers') {
    stats.creates += 1;
    stats.current = 500 + stats.creates;
    return send(res, 201, { data: { id: stats.current, region: 'eu-west-1', engine: 5 } });
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/fs-containers/')) {
    stats.deletes += 1;
    return send(res, 204);
  }
  if (req.method === 'GET' && /\/presigned-upload$/.test(url.pathname)) {
    const cid = Number(url.pathname.split('/')[3]);
    if (cid === 501) return reject(res);
    return send(res, 200, {
      data: {
        presigned_url: `http://127.0.0.1:${fake.address().port}/s3/put`,
        key: 'k',
        file_id: 'f2',
        method: 'PUT',
        headers: { 'Content-Type': 'audio/mpeg' }
      }
    });
  }
  if (req.method === 'POST' && /\/api\/fs-containers\/\d+\/files$/.test(url.pathname)) {
    for await (const _chunk of req) { /* drena */ }
    const cid = Number(url.pathname.split('/')[3]);
    if (cid === 501) return reject(res);
    return send(res, 200, { data: { id: 'f2' } });
  }
  if (req.method === 'PUT' && url.pathname === '/s3/put') {
    for await (const _chunk of req) { /* drena */ }
    return send(res, 200);
  }
  if (req.method === 'GET' && /\/api\/fs-containers\/\d+\/files\/f2$/.test(url.pathname)) {
    return send(res, 200, { data: [{ id: 'f2', state: 1, duration: 20, results }] });
  }
  send(res, 404, { status: { msg: 'not found' } });
});

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;

process.env.DATA_DIR = path.join(tmp, 'data');
process.env.ACR_API_ROOT = base;
process.env.ACR_REGION_ROOT = base;

const { setConfig, ensureDirs } = await import('../lib/config.js');
ensureDirs();
setConfig({ token: 'token-test', demo: false, pollMs: 50, timeoutMs: 10000, concurrency: 1, buckets: [1], engine: 5 });

const store = await import('../lib/store.js');
const { runFile } = await import('../lib/pipeline.js');
store.load();

function makeRecord(id, name) {
  const audioPath = path.join(tmp, name);
  fs.writeFileSync(audioPath, Buffer.from('ID3-fake'));
  const rec = {
    id,
    name,
    storedName: name,
    path: audioPath,
    size: fs.statSync(audioPath).size,
    mime: 'audio/mpeg',
    batchId: 'b-x',
    status: 'queued',
    progress: 0,
    attempts: 0,
    createdAt: new Date().toISOString()
  };
  store.addFile(rec);
  return rec;
}

test('capacidad de audio agotada: error claro y sin rotar contenedor', async () => {
  stats.mode = 'quota';
  makeRecord('rec-quota', 'quota.mp3');
  await assert.rejects(() => runFile(store.getFile('rec-quota')), /Capacidad de almacenamiento/i);
  assert.equal(stats.creates, 1, 'solo el contenedor inicial');
  assert.equal(stats.deletes, 0, 'no borra contenedores inútilmente');
  assert.equal(store.state.container.id, 501);
});

test('contenedor inválido: se recrea y reintenta', async () => {
  stats.mode = 'invalid';
  makeRecord('rec-invalid', 'invalid.mp3');
  await runFile(store.getFile('rec-invalid'));
  const done = store.getFile('rec-invalid');
  assert.equal(done.status, 'done');
  assert.equal(done.summary.aiProbability, 77);
  assert.equal(stats.creates, 2, 'crea 502 tras el contenedor inválido');
  assert.equal(store.state.container.id, 502);
});

test.after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
  await new Promise((r) => fake.close(r));
});
