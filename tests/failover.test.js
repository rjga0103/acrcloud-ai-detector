import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'acr-failover-'));

const results = {
  ai_detection: [{ stem: 'original', prediction: 'human', ai_probability: 12, duration: 10 }]
};

const stats = { creates: 0, mode: 'once' };

function send(res, status, body) {
  if (body === undefined) return res.writeHead(status).end();
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function blocked(cid) {
  return stats.mode === 'always' || (stats.mode === 'once' && cid === 601);
}

const quotaError = { error: "Your container's size exceeds limits, Please contact Support for more resources" };

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/fs-containers') {
    return send(res, 200, { data: [], meta: { last_page: 1, total: 0 } });
  }
  if (req.method === 'POST' && url.pathname === '/api/fs-containers') {
    stats.creates += 1;
    return send(res, 201, { data: { id: 600 + stats.creates, region: 'eu-west-1', engine: 5 } });
  }
  if (req.method === 'GET' && /\/presigned-upload$/.test(url.pathname)) {
    const cid = Number(url.pathname.split('/')[3]);
    if (blocked(cid)) return send(res, 400, quotaError);
    return send(res, 200, {
      data: {
        presigned_url: `http://127.0.0.1:${fake.address().port}/s3/put`,
        key: 'k',
        file_id: 'f3',
        method: 'PUT',
        headers: { 'Content-Type': 'audio/mpeg' }
      }
    });
  }
  if (req.method === 'POST' && /\/api\/fs-containers\/\d+\/files$/.test(url.pathname)) {
    for await (const _chunk of req) { /* drena */ }
    const cid = Number(url.pathname.split('/')[3]);
    if (blocked(cid)) return send(res, 400, quotaError);
    return send(res, 200, { data: { id: 'f3' } });
  }
  if (req.method === 'PUT' && url.pathname === '/s3/put') {
    for await (const _chunk of req) { /* drena */ }
    return send(res, 200);
  }
  if (req.method === 'GET' && /\/api\/fs-containers\/\d+\/files\/f3$/.test(url.pathname)) {
    return send(res, 200, { data: [{ id: 'f3', state: 1, duration: 10, results }] });
  }
  send(res, 404, { status: { msg: 'not found' } });
});

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;

process.env.DATA_DIR = path.join(tmp, 'data');
process.env.ACR_API_ROOT = base;
process.env.ACR_REGION_ROOT = base;

const { setConfig, ensureDirs, getConfig } = await import('../lib/config.js');
ensureDirs();
setConfig({
  token: 'token-test',
  demo: false,
  pollMs: 50,
  timeoutMs: 10000,
  concurrency: 1,
  buckets: [1],
  engine: 5,
  region: 'eu-west-1',
  autoRegionFailover: true
});

const store = await import('../lib/store.js');
const { runFile } = await import('../lib/pipeline.js');
store.load();

function makeRecord(id, name) {
  const audioPath = path.join(tmp, name);
  fs.writeFileSync(audioPath, Buffer.from('ID3-fake'));
  store.addFile({
    id,
    name,
    storedName: name,
    path: audioPath,
    size: fs.statSync(audioPath).size,
    mime: 'audio/mpeg',
    batchId: 'b-fo',
    status: 'queued',
    progress: 0,
    attempts: 0,
    createdAt: new Date().toISOString()
  });
}

test('agota región y pasa a la siguiente automáticamente', async () => {
  makeRecord('rec-fo', 'fo.mp3');
  await runFile(store.getFile('rec-fo'));

  const done = store.getFile('rec-fo');
  assert.equal(done.status, 'done');
  assert.equal(done.summary.aiProbability, 12);
  assert.equal(getConfig().region, 'us-west-2', 'configuración pasa a la siguiente región');
  assert.equal(stats.creates, 2, 'contenedor 601 bloqueado y 602 válido');
  assert.equal(store.state.container.id, 602);
  assert.ok(store.state.failedRegions['eu-west-1'], 'marca la región agotada');
});

test('sin failover, el error es claro y no cambia de región', async () => {
  stats.mode = 'always';
  setConfig({ region: 'eu-west-1', autoRegionFailover: false });
  makeRecord('rec-no-fo', 'no-fo.mp3');
  await assert.rejects(() => runFile(store.getFile('rec-no-fo')), /agotada en eu-west-1/i);
  assert.equal(getConfig().region, 'eu-west-1');
});

test.after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
  await new Promise((r) => fake.close(r));
});
