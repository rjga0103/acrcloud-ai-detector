import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getConfig } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function apiRoot() {
  return (process.env.ACR_API_ROOT || 'https://api-v2.acrcloud.com').replace(/\/$/, '');
}

export function regionRoot(cfg = getConfig()) {
  return (process.env.ACR_REGION_ROOT || `https://api-${cfg.region}.acrcloud.com`).replace(/\/$/, '');
}

export class AcrError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'AcrError';
    this.status = status;
    this.body = body;
  }
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 120000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const msg =
          json?.status?.msg ||
          json?.message ||
          json?.error ||
          (text && text.slice(0, 300)) ||
          res.statusText;
        const err = new AcrError(`HTTP ${res.status}: ${msg}`, res.status, json ?? text);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return json ?? { raw: text };
    } catch (err) {
      lastError = err;
      const retryable = err.retryable !== false && (!err.status || err.retryable);
      if (attempt >= retries || !retryable) break;
      await sleep(800 * 2 ** attempt);
    }
  }
  if (lastError instanceof AcrError) throw lastError;
  if (lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError') {
    throw new AcrError('Tiempo de espera agotado hablando con ACRCloud', 0);
  }
  throw new AcrError(lastError?.message || 'Error de red con ACRCloud', 0);
}

function authHeaders(cfg) {
  return { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' };
}

function requireToken(cfg) {
  if (!cfg.token) {
    throw new AcrError(
      'Falta el token de ACRCloud. Consola ACRCloud > Account > Developer > crea un API token y pégalo en Ajustes.',
      401
    );
  }
}

export const CONTAINER_NAME = 'ACRCloud AI Detector';

/** Nombres usados por esta app (incluye lotes antiguos) para poder limpiarlos. */
export function isOwnContainer(name) {
  const n = String(name || '');
  return n.startsWith(CONTAINER_NAME) || n.startsWith('AI detect');
}

/** Lista los contenedores de File Scanning de la cuenta (paginado). */
export async function listContainers(cfg, { perPage = 100, maxPages = 10 } = {}) {
  requireToken(cfg);
  const all = [];
  let page = 1;
  let lastPage = 1;
  do {
    const json = await request(
      `${apiRoot()}/api/fs-containers?per_page=${perPage}&page=${page}`,
      { headers: authHeaders(cfg), retries: 1 }
    );
    const data = Array.isArray(json?.data) ? json.data : [];
    all.push(...data);
    lastPage = Number(json?.meta?.last_page) || 1;
    page += 1;
  } while (page <= lastPage && page <= maxPages);
  return all;
}

/**
 * Borra contenedores remotos. Por defecto solo los creados por esta app;
 * con all:true borra todos los de File Scanning de la cuenta.
 */
export async function purgeContainers(cfg, { all = false, keepId = null } = {}) {
  requireToken(cfg);
  const list = await listContainers(cfg);
  const targets = all ? list : list.filter((c) => isOwnContainer(c.name));
  const deleted = [];
  const failed = [];
  for (const item of targets) {
    if (keepId != null && String(item.id) === String(keepId)) continue;
    try {
      await deleteContainer(cfg, item.id);
      deleted.push({ id: item.id, name: item.name });
    } catch (err) {
      failed.push({ id: item.id, name: item.name, error: err.message });
    }
  }
  return {
    total: list.length,
    deleted,
    failed,
    remaining: list.filter((c) => !deleted.some((d) => String(d.id) === String(c.id)))
  };
}

/** Crea un contenedor de File Scanning. engine 5 = AI Music Detection. */
export async function createContainer(cfg, { name } = {}) {
  requireToken(cfg);
  const payload = {
    name: name || CONTAINER_NAME,
    region: cfg.region,
    audio_type: cfg.audioType,
    buckets: cfg.buckets,
    engine: cfg.engine,
    policy: { type: 'traverse', interval: 0, rec_length: 10, ai_detection: 1, deepright: false },
    ai_detection: 1,
    music_detection: 0,
    deepright: false,
    callback_url: null
  };
  let json;
  try {
    json = await request(`${apiRoot()}/api/fs-containers`, {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    if (/exceed|limit|quota/i.test(err.message)) {
      err.code = 'CONTAINER_LIMIT';
      err.message =
        'ACRCloud rechaza crear otro contenedor: tu cuenta alcanzó el límite de contenedores del plan. ' +
        'Borra los contenedores que ya no uses (Ajustes → Borrar contenedores) y reintenta.';
    } else if (/already exists/i.test(err.message)) {
      err.code = 'CONTAINER_NAME_TAKEN';
      err.message = 'Ya existe un contenedor con ese nombre en la cuenta ACRCloud.';
    } else if ((err.status === 400 || err.status === 422) && /bucket/i.test(err.message)) {
      err.message = `${err.message} (revisa "buckets" en Ajustes: id/nombre del bucket del proyecto)`;
    }
    throw err;
  }
  const container = json?.data || json;
  const id = Number(container?.id);
  if (!id) throw new AcrError('ACRCloud no devolvió id de contenedor', 0, json);
  return { id, raw: container };
}

export async function deleteContainer(cfg, containerId) {
  requireToken(cfg);
  return request(`${apiRoot()}/api/fs-containers/${containerId}`, {
    method: 'DELETE',
    headers: authHeaders(cfg),
    retries: 0
  });
}

export async function testConnection(cfg) {
  requireToken(cfg);
  const json = await request(`${apiRoot()}/api/fs-containers?per_page=1`, {
    headers: authHeaders(cfg),
    retries: 0
  });
  const total = json?.meta?.total ?? json?.data?.length ?? null;
  return { ok: true, message: total == null ? 'Token válido' : `Token válido · ${total} contenedores` };
}

let billingCache = { at: 0, token: '', data: null };

/**
 * Datos de facturación disponibles (no hay endpoint de cuota restante).
 * Se cachea 10 minutos porque /api/state se consulta con frecuencia.
 */
export async function getBilling(cfg, { force = false } = {}) {
  requireToken(cfg);
  if (
    !force &&
    billingCache.data &&
    billingCache.token === cfg.token &&
    Date.now() - billingCache.at < 10 * 60 * 1000
  ) {
    return billingCache.data;
  }
  const data = {
    nextBillDate: null,
    cycleType: null,
    availableCredits: null,
    fetchedAt: new Date().toISOString(),
    error: null
  };
  const headers = authHeaders(cfg);
  try {
    const next = await request(`${apiRoot()}/api/billing/next-bill-date`, { headers, retries: 0 });
    data.nextBillDate = next?.next_bill_date || null;
  } catch (err) {
    data.error = err.message;
  }
  try {
    const pref = await request(`${apiRoot()}/api/billing/preferences`, { headers, retries: 0 });
    data.cycleType = pref?.data?.billing_cycle_type ?? null;
  } catch {
    /* sin preferencias */
  }
  try {
    const credits = await request(`${apiRoot()}/api/billing/available-credits`, { headers, retries: 0 });
    data.availableCredits = credits?.avaliable ?? credits?.available ?? null; // la API escribe "avaliable"
  } catch {
    /* sin créditos */
  }
  billingCache = { at: Date.now(), token: cfg.token, data };
  return data;
}

function pickId(json) {
  const candidates = [
    json?.data?.id,
    json?.data?.file_id,
    json?.file_id,
    json?.id,
    Array.isArray(json?.data) ? json.data[0]?.id : null,
    Array.isArray(json) ? json[0]?.id : null
  ];
  for (const c of candidates) if (c != null && c !== '') return String(c);
  return null;
}

async function findFileId(cfg, containerId, filename) {
  const json = await request(
    `${regionRoot(cfg)}/api/fs-containers/${containerId}/files?per_page=20&with_result=0&search=${encodeURIComponent(filename)}`,
    { headers: authHeaders(cfg), retries: 1 }
  );
  const list = Array.isArray(json?.data) ? json.data : [];
  const hit =
    list.find((item) => String(item?.name || '').endsWith(filename)) || list.find((item) => item?.name);
  return hit?.id ? String(hit.id) : null;
}

async function directMultipartUpload(cfg, containerId, filePath, filename, mime, timeoutMs) {
  const form = new FormData();
  const blob = typeof fs.openAsBlob === 'function'
    ? await fs.openAsBlob(filePath, { type: mime })
    : new Blob([await fsp.readFile(filePath)], { type: mime });
  form.append('file', blob, filename);
  form.append('data_type', 'audio');
  const json = await request(`${regionRoot(cfg)}/api/fs-containers/${containerId}/files`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${cfg.token}` },
    body: form,
    timeoutMs,
    retries: 1
  });
  return pickId(json) || (await findFileId(cfg, containerId, filename));
}

/**
 * Sube un archivo (URL prefirmada a S3, con fallback multipart) y devuelve el file id.
 */
export async function uploadFile(cfg, containerId, filePath, filename, mime) {
  requireToken(cfg);
  const base = regionRoot(cfg);
  const timeoutMs = 900000;

  try {
    const presign = await request(
      `${base}/api/fs-containers/${containerId}/presigned-upload?filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(mime)}`,
      { headers: authHeaders(cfg), retries: 1 }
    );
    const url = presign?.url || presign?.data?.url;
    const key = presign?.key || presign?.data?.key;
    const presignFileId = presign?.file_id || presign?.data?.file_id || null;
    if (url && key) {
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': mime },
        body: fs.createReadStream(filePath),
        duplex: 'half',
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!put.ok) throw new AcrError(`Subida a S3 falló (HTTP ${put.status})`, put.status);
      const meta = await request(`${base}/api/fs-containers/${containerId}/files`, {
        method: 'POST',
        headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_type: 'audio', key, filename }),
        timeoutMs,
        retries: 1
      });
      return pickId(meta) || presignFileId || (await findFileId(cfg, containerId, filename));
    }
  } catch (err) {
    if (err.status === 401) throw err;
    // sigue con multipart directo
  }

  return directMultipartUpload(cfg, containerId, filePath, filename, mime, timeoutMs);
}

/** Estado y resultados de uno o varios archivos del contenedor. */
export async function getFiles(cfg, containerId, fileIds) {
  requireToken(cfg);
  const ids = Array.isArray(fileIds) ? fileIds.join(',') : String(fileIds);
  const json = await request(
    `${regionRoot(cfg)}/api/fs-containers/${containerId}/files/${ids}`,
    { headers: authHeaders(cfg), retries: 1 }
  );
  if (Array.isArray(json?.data)) return json.data;
  if (json?.data) return [json.data];
  return Array.isArray(json) ? json : [];
}
