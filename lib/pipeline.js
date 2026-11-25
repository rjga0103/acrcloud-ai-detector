import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { getConfig } from './config.js';
import * as store from './store.js';
import * as acr from './acr.js';
import { summarize } from './parse.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let running = 0;
let loop = null;
let lastTick = 0;

export function wake() {
  lastTick = 0;
}

function activeCount() {
  return store.state.files.filter((f) => f.status === 'uploading' || f.status === 'processing').length;
}

function nextQueued() {
  const queued = store.state.files.filter((f) => f.status === 'queued');
  queued.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return queued[0] || null;
}

function containerKey(cfg) {
  return [cfg.region, cfg.engine, cfg.audioType, (cfg.buckets || []).map(String).join('|')].join('::');
}

function saveContainer(id, key) {
  store.state.container = { id: Number(id), key, name: acr.CONTAINER_NAME, since: new Date().toISOString() };
  store.save();
}

async function reuseRemote(cfg) {
  try {
    const list = await acr.listContainers(cfg);
    return (
      list.find(
        (c) =>
          acr.isOwnContainer(c.name) &&
          c.region === cfg.region &&
          Number(c.engine) === Number(cfg.engine)
      ) || null
    );
  } catch {
    return null;
  }
}

function uniqueContainerName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const salt = Math.random().toString(36).slice(2, 6);
  return `${acr.CONTAINER_NAME} ${stamp}-${salt}`;
}

async function tryCreate(cfg, key) {
  const created = await acr.createContainer(cfg, { name: uniqueContainerName() });
  saveContainer(created.id, key);
  return Number(created.id);
}

async function createSharedContainer(cfg, key) {
  try {
    return await tryCreate(cfg, key);
  } catch (err) {
    if (err.code === 'CONTAINER_NAME_TAKEN') {
      // el nombre puede quedar reservado tras borrar: reutiliza lo que haya o usa otro nombre
      const remote = await reuseRemote(cfg);
      if (remote) {
        saveContainer(remote.id, key);
        return Number(remote.id);
      }
      return tryCreate(cfg, key);
    }
    if (err.code !== 'CONTAINER_LIMIT') throw err;

    // Plan lleno: libera los contenedores de esta app y reintenta una vez.
    await acr.purgeContainers(cfg, { all: false });
    const remote = await reuseRemote(cfg);
    if (remote) {
      saveContainer(remote.id, key);
      return Number(remote.id);
    }
    try {
      return await tryCreate(cfg, key);
    } catch (err2) {
      if (err2.code !== 'CONTAINER_LIMIT') throw err2;
      let list = [];
      try {
        list = await acr.listContainers(cfg);
      } catch {
        /* sin lista */
      }
      const foreign = list.filter((c) => !acr.isOwnContainer(c.name));
      throw new Error(
        `Límite de contenedores del plan ACRCloud alcanzado (${list.length} contenedor(es) en la cuenta` +
          (foreign.length ? `, ${foreign.length} ajeno(s) a esta app` : '') +
          '). Borra contenedores en Ajustes → "Borrar contenedores remotos" o en la consola de ACRCloud, y reintenta.'
      );
    }
  }
}

async function recreateContainer(cfg) {
  store.state.container = null;
  store.save();
  return ensureContainer(cfg);
}

/**
 * Rota el contenedor: el plan limita el tamaño acumulado (segundos) y borrar
 * archivos no lo reduce. Se elimina el contenedor lleno y se crea otro.
 */
async function rotateContainer(cfg) {
  const current = store.state.container;
  store.state.container = null;
  store.save();
  if (current?.id) {
    try {
      await acr.deleteContainer(cfg, current.id);
    } catch {
      /* pudo borrarse ya */
    }
  }
  return createSharedContainer(cfg, containerKey(cfg));
}

/**
 * Un único contenedor por configuración (región + engine + buckets).
 * Se reutiliza entre lotes y entre reinicios para no gastar el límite del plan.
 */
async function ensureContainer(cfg) {
  const key = containerKey(cfg);
  const current = store.state.container;
  if (current?.id && current.key === key) return Number(current.id);
  if (current?.id) {
    // cambió la configuración: libera el contenedor anterior
    try {
      await acr.deleteContainer(cfg, current.id);
    } catch {
      /* ya no existe o sin permisos */
    }
    store.state.container = null;
    store.save();
  }
  const remote = await reuseRemote(cfg);
  if (remote) {
    saveContainer(remote.id, key);
    return Number(remote.id);
  }
  return createSharedContainer(cfg, key);
}

function fakeSummary(name) {
  const hash = crypto.createHash('sha1').update(name).digest();
  const base = (hash[0] * 256 + hash[1]) % 100;
  const isAi = base >= 50;
  const aiProbability = Math.round((isAi ? 55 + (base - 50) * 0.9 : base * 0.9) * 100) / 100;
  const sources = ['Suno', 'Udio', 'Sonauto', 'Mureka', 'Riffusion', 'ElevenLabs', 'Humano'];
  const likely = isAi ? sources[hash[2] % 5] : 'Humano';
  return {
    found: true,
    prediction: isAi ? 'ai_generated' : 'human',
    aiProbability,
    humanProbability: Math.round((100 - aiProbability) * 100) / 100,
    likelySource: likely,
    duration: 120 + (hash[3] % 120),
    stems: [
      {
        stem: 'original',
        prediction: isAi ? 'ai_generated' : 'human',
        aiProbability,
        duration: 120 + (hash[3] % 120),
        weight: 120 + (hash[3] % 120),
        likelySource: likely,
        sources: sources.slice(0, 5).map((s, i) => ({ source: s, probability: Math.max(0.1, 100 - i * 18) })),
        segments: [],
        modelId: 'demo'
      }
    ],
    sources: sources.slice(0, 5).map((s, i) => ({ source: s, probability: Math.max(0.1, 100 - i * 18) })),
    segments: [
      { start: 0, end: 45, prediction: isAi ? 'ai_generated' : 'human', likelySource: likely, aiProbability },
      { start: 45, end: 90, prediction: isAi ? 'ai_generated' : 'human', likelySource: likely, aiProbability: Math.min(99, aiProbability + 2) }
    ],
    modelId: 'demo',
    confidence: 'alta'
  };
}

async function runDemo(rec) {
  store.updateFile(rec.id, { status: 'processing', progress: 20 });
  await sleep(700);
  if (store.getFile(rec.id)?.status === 'canceled') return;
  store.updateFile(rec.id, { progress: 65 });
  await sleep(900);
  const current = store.getFile(rec.id);
  if (!current || current.status === 'canceled') return;
  store.updateFile(rec.id, {
    status: 'done',
    progress: 100,
    finishedAt: new Date().toISOString(),
    demo: true,
    summary: fakeSummary(current.name)
  });
}

async function pollUntilDone(cfg, rec, containerId, fileId) {
  const deadline = Date.now() + cfg.timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const live = store.getFile(rec.id);
    if (!live) return null;
    if (live.status === 'canceled') return null;

    let file = null;
    try {
      const files = await acr.getFiles(cfg, containerId, fileId);
      file = files.find((x) => String(x.id) === String(fileId)) || files[0] || null;
    } catch (err) {
      if (acr.isContainerGone(err)) {
        // contenedor borrado: se recrea en el siguiente intento
        store.state.container = null;
        store.save();
        throw new Error('El contenedor de ACRCloud ya no existe (¿borrado en la consola?)');
      }
      if (err.status === 401) throw err;
      // error transitorio: seguimos esperando
    }

    if (file) {
      lastState = Number(file.state);
      const progress = Math.min(92, 40 + Math.round(((Date.now() - (deadline - cfg.timeoutMs)) / cfg.timeoutMs) * 50));
      store.updateFile(rec.id, { progress, acrState: lastState });
      if (lastState === 1 || lastState === -1 || lastState <= -2) {
        return { file, state: lastState };
      }
    }
    await sleep(cfg.pollMs);
  }
  throw new Error(`ACRCloud no terminó en ${Math.round(cfg.timeoutMs / 1000)} s`);
}

export async function rotateContainerForUser() {
  return rotateContainer(getConfig());
}

export async function runFile(rec) {
  const cfg = getConfig();
  const started = Date.now();

  if (store.getFile(rec.id)?.status === 'canceled') return;
  store.updateFile(rec.id, { startedAt: new Date().toISOString(), error: null, attempts: (rec.attempts || 0) + 1 });

  if (cfg.demo) {
    await runDemo(store.getFile(rec.id));
    return;
  }

  let containerId = await ensureContainer(cfg);
  store.updateFile(rec.id, { status: 'uploading', progress: 10, containerId });
  const mime = rec.mime || 'audio/mpeg';
  let fileId;
  try {
    fileId = await acr.uploadFile(cfg, containerId, rec.path, rec.name, mime);
  } catch (err) {
    if (acr.isQuotaExhausted(err)) {
      throw new Error(
        'Cuota de audio agotada en ACRCloud. El plan no admite más segundos de análisis en este ciclo ' +
          '(la API lo llama "container size", pero es capacidad de la cuenta). No es un fallo de la app: ' +
          'revisa Billing/Usage en la consola, espera la renovación del ciclo o amplía el plan.'
      );
    }
    if (!acr.isContainerGone(err)) throw err;
    // contenedor borrado o inválido: se recrea y se reintenta una vez
    containerId = await recreateContainer(cfg);
    store.updateFile(rec.id, { containerId });
    fileId = await acr.uploadFile(cfg, containerId, rec.path, rec.name, mime);
  }
  if (!fileId) throw new Error('ACRCloud no devolvió id de archivo tras la subida');

  store.updateFile(rec.id, { status: 'processing', progress: 35, acrFileId: fileId });
  const { file, state } = await pollUntilDone(cfg, rec, containerId, fileId);
  if (!file) return; // cancelado

  if (state === -1) {
    throw new Error('ACRCloud no obtuvo resultados del audio (state -1)');
  }
  if (state <= -2) {
    throw new Error(`ACRCloud devolvió error de procesado (state ${state}${file.detail ? `: ${String(file.detail).slice(0, 140)}` : ''})`);
  }

  const results = file.results ?? file.result ?? file.metadata ?? file;
  const summary = summarize(results);
  if (!summary.found) {
    throw new Error(
      'Respuesta sin bloque "ai_detection". Revisa que el proyecto tenga AI Music Detection habilitado y engine = 5.'
    );
  }

  store.updateFile(rec.id, {
    status: 'done',
    progress: 100,
    finishedAt: new Date().toISOString(),
    acrDuration: Number(file.duration) || null,
    summary,
    error: null,
    elapsedMs: Date.now() - started
  });

  if (!cfg.demo && !store.getFile(rec.id)?.counted) {
    // ledger local para estimar el consumo del plan (ACRCloud no expone la cuota)
    store.recordUsage(new Date(), summary.duration || Number(file.duration) || 0);
    store.updateFile(rec.id, { counted: true });
  }
}

async function execute(rec) {
  running += 1;
  try {
    await runFile(rec);
  } catch (err) {
    const live = store.getFile(rec.id);
    if (!live) return;
    if (live.status === 'canceled') return;
    store.updateFile(rec.id, {
      status: 'error',
      progress: 100,
      finishedAt: new Date().toISOString(),
      error: err.message || String(err)
    });
  } finally {
    running -= 1;
    wake();
  }
}

export function startWorker() {
  if (loop) return loop;
  loop = setInterval(() => {
    const cfg = getConfig();
    const now = Date.now();
    if (now - lastTick < 300) return;
    lastTick = now;
    const limit = cfg.concurrency || 3;
    while (activeCount() + running < limit) {
      const rec = nextQueued();
      if (!rec) break;
      store.updateFile(rec.id, { status: 'uploading', progress: 5, error: null });
      execute(store.getFile(rec.id));
    }
  }, 500);
  loop.unref?.();
  return loop;
}

export function queueIds(ids) {
  let queued = 0;
  for (const id of ids) {
    const rec = store.getFile(id);
    if (!rec) continue;
    if (!['staged', 'error', 'canceled'].includes(rec.status)) continue;
    store.updateFile(id, { status: 'queued', error: null, progress: 0 });
    queued += 1;
  }
  wake();
  return queued;
}

export async function cleanupFile(rec) {
  if (!rec?.path) return;
  try {
    await fs.unlink(rec.path);
  } catch {
    /* ya no existe */
  }
}
