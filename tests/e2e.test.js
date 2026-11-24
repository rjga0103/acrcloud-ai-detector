import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'acr-e2e-'));

const sampleResults = {
  ai_detection: [
    {
      start: 0,
      end: 120,
      prediction: 'ai_generated',
      likely_source: 'Suno',
      ai_probability: 88.5,
      duration: 120,
      stem: 'original',
      source_probabilities: [
        { source: 'Suno', probability: 88 },
        { source: 'Udio', probability: 4 }
      ]
    }
  ]
};

let polls = 0;
let presignCalls = 0;
let metadataCalls = 0;

const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };

  if (req.method === 'POST' && url.pathname === '/api/fs-containers') {
    return send(201, { data: { id: 777, region: 'eu-west-1', name: 'ACRCloud AI Detector' } });
  }
  if (req.method === 'GET' && url.pathname === '/api/fs-containers') {
    return send(200, { data: [], meta: { current_page: 1, last_page: 1, total: 0 } });
  }
  if (req.method === 'GET' && url.pathname === '/api/fs-containers/777/presigned-upload') {
    presignCalls += 1;
    return send(200, { url: `http://127.0.0.1:${fake.address().port}/s3/put`, key: 'fs/queue/x.mp3', file_id: 'file-1', expires_in: 900 });
  }
  if (req.method === 'PUT' && url.pathname === '/s3/put') {
    for await (const _chunk of req) { /* drena */ }
    res.writeHead(200).end();
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/fs-containers/777/files') {
    metadataCalls += 1;
    for await (const _chunk of req) { /* drena */ }
    return send(200, { data: { id: 'file-1', name: 'prueba.mp3' } });
  }
  if (req.method === 'GET' && url.pathname === '/api/fs-containers/777/files/file-1') {
    polls += 1;
    if (polls === 1) return send(200, { data: [{ id: 'file-1', state: 0 }] });
    return send(200, { data: [{ id: 'file-1', state: 1, duration: 120, results: sampleResults }] });
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/fs-containers/')) {
    res.writeHead(204).end();
    return;
  }
  send(404, { status: { msg: 'not found' } });
});

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${fake.address().port}`;

process.env.DATA_DIR = path.join(tmp, 'data');
process.env.ACR_API_ROOT = base;
process.env.ACR_REGION_ROOT = base;

const { setConfig, ensureDirs } = await import('../lib/config.js');
ensureDirs();
setConfig({ token: 'token-test', demo: false, pollMs: 50, timeoutMs: 15000, concurrency: 1, buckets: [1] });

const store = await import('../lib/store.js');
const { runFile } = await import('../lib/pipeline.js');
store.load();

const audioPath = path.join(tmp, 'prueba.mp3');
fs.writeFileSync(audioPath, Buffer.from('ID3fake-mp3-bytes-for-upload'));

store.addFile({
  id: 'rec-1',
  name: 'prueba.mp3',
  storedName: 'prueba.mp3',
  path: audioPath,
  size: fs.statSync(audioPath).size,
  mime: 'audio/mpeg',
  batchId: 'b-test',
  status: 'queued',
  progress: 0,
  attempts: 0,
  createdAt: new Date().toISOString()
});

test('flujo completo: contenedor, S3 prefirmado, metadata, poll y resumen', async () => {
  const rec = store.getFile('rec-1');
  await runFile(rec);

  const done = store.getFile('rec-1');
  assert.equal(done.status, 'done');
  assert.equal(done.acrFileId, 'file-1');
  assert.equal(done.summary.found, true);
  assert.equal(done.summary.prediction, 'ai_generated');
  assert.equal(done.summary.aiProbability, 88.5);
  assert.equal(done.summary.likelySource, 'Suno');
  assert.equal(presignCalls, 1);
  assert.equal(metadataCalls, 1);
  assert.ok(polls >= 2);
  assert.equal(store.state.container.id, 777);
});

test.after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
  await new Promise((resolve) => fake.close(resolve));
});
