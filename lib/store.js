import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDirs } from './config.js';
import { addUsage } from './usage.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');

export const state = {
  files: [],
  container: null, // contenedor compartido: { id, key, name, since }
  containers: {}, // histórico batchId -> container id (versiones antiguas)
  usage: {}, // 'YYYY-MM-DD' -> { seconds, files } (ledger de audio facturable)
  createdAt: new Date().toISOString()
};

let timer = null;

export function load() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    state.files = Array.isArray(raw.files) ? raw.files : [];
    state.containers = raw.containers && typeof raw.containers === 'object' ? raw.containers : {};
    state.container = raw.container && raw.container.id ? raw.container : null;
    state.usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  } catch {
    // primer arranque
  }
  for (const rec of state.files) {
    // procesos que quedaron a medias en un cierre anterior
    if (['uploading', 'processing'].includes(rec.status)) {
      rec.status = 'queued';
      rec.progress = 0;
      rec.error = null;
    }
  }
  return state;
}

export function saveNow() {
  ensureDirs();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({ files: state.files, container: state.container, containers: state.containers, usage: state.usage }), 'utf8');
  } catch (err) {
    console.error('[store] no se pudo guardar db.json:', err.message);
  }
}

export function save() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saveNow();
  }, 400);
  timer.unref?.();
}

export function addFile(rec) {
  state.files.unshift(rec);
  save();
  return rec;
}

export function getFile(id) {
  return state.files.find((f) => f.id === id) || null;
}

export function updateFile(id, patch) {
  const rec = getFile(id);
  if (!rec) return null;
  Object.assign(rec, patch);
  save();
  return rec;
}

export function removeFile(id) {
  const index = state.files.findIndex((f) => f.id === id);
  if (index < 0) return null;
  const [rec] = state.files.splice(index, 1);
  save();
  return rec;
}

export function countByStatus() {
  const counts = { queued: 0, staged: 0, uploading: 0, processing: 0, done: 0, error: 0, canceled: 0, ai: 0, human: 0, unknown: 0 };
  for (const f of state.files) {
    if (counts[f.status] != null) counts[f.status] += 1;
    if (f.status === 'done') {
      const p = f.summary?.prediction;
      if (p === 'ai_generated') counts.ai += 1;
      else if (p === 'human') counts.human += 1;
      else counts.unknown += 1;
    }
  }
  return counts;
}

/** Suma audio facturable al ledger local (una entrada por archivo analizado). */
export function recordUsage(when, seconds) {
  const slot = addUsage(state.usage, when || new Date(), seconds);
  save();
  return slot;
}

export function publicFile(f) {  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    batchId: f.batchId,
    status: f.status,
    progress: f.progress || 0,
    error: f.error || null,
    attempts: f.attempts || 0,
    createdAt: f.createdAt,
    startedAt: f.startedAt || null,
    finishedAt: f.finishedAt || null,
    acrFileId: f.acrFileId || null,
    demo: Boolean(f.demo),
    summary: f.summary || null
  };
}
