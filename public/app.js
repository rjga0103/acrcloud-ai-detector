const els = {
  tbody: document.getElementById('tbody'),
  empty: document.getElementById('empty'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('fileInput'),
  statusChip: document.getElementById('statusChip'),
  demoBanner: document.getElementById('demoBanner'),
  footerConfig: document.getElementById('footerConfig'),
  search: document.getElementById('search'),
  filter: document.getElementById('filter'),
  uploadStatus: document.getElementById('uploadStatus'),
  uploadLabel: document.getElementById('uploadLabel'),
  uploadCount: document.getElementById('uploadCount'),
  uploadBar: document.getElementById('uploadBar'),
  stats: {
    total: document.getElementById('statTotal'),
    queued: document.getElementById('statQueued'),
    active: document.getElementById('statActive'),
    human: document.getElementById('statHuman'),
    ai: document.getElementById('statAi'),
    error: document.getElementById('statError')
  }
};

const settingsDialog = document.getElementById('settingsDialog');
const helpDialog = document.getElementById('helpDialog');
const detailDialog = document.getElementById('detailDialog');
const detailBody = document.getElementById('detailBody');
const settingsMsg = document.getElementById('settingsMsg');

const app = {
  config: null,
  files: [],
  counts: {},
  uploads: { active: 0, total: 0, loaded: 0, size: 0, ok: 0, failed: 0 }
};

const MAX_UPLOAD = 1024 * 1024 * 1024;

/* ---------- utilidades ---------- */

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtPct = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `${Number(n).toFixed(2)} %`);

function fmtDur(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (!b) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'hace un momento';
  if (diff < 3600) return `hace ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.round(diff / 3600)} h`;
  return new Date(iso).toLocaleDateString();
}

let toastTimer = null;
function toast(message, kind = 'info') {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.style.cssText =
      'position:fixed;right:20px;bottom:20px;z-index:80;padding:11px 15px;border-radius:10px;font-size:13px;' +
      'background:#1b2232;border:1px solid #2b3550;color:#e8ecf5;box-shadow:0 12px 30px rgba(0,0,0,.45);max-width:360px;';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.style.borderColor = kind === 'error' ? 'rgba(255,107,129,.5)' : kind === 'ok' ? 'rgba(66,211,146,.45)' : '#2b3550';
  node.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.style.opacity = '0';
  }, 4200);
}

/* ---------- estado ---------- */

async function refresh() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const changed =
      JSON.stringify(data.counts) !== JSON.stringify(app.counts) ||
      JSON.stringify(data.files.map((f) => [f.id, f.status, f.progress, f.summary?.aiProbability, f.error])) !==
        JSON.stringify(app.files.map((f) => [f.id, f.status, f.progress, f.summary?.aiProbability, f.error]));
    app.config = data.config;
    app.files = data.files;
    app.counts = data.counts;
    renderChrome();
    if (changed) renderTable();
  } catch (err) {
    els.statusChip.textContent = 'Sin conexión con el servidor';
    els.statusChip.className = 'chip bad';
  }
}

function renderChrome() {
  const c = app.config;
  if (!c) return;
  if (c.demo) {
    els.statusChip.textContent = 'Modo demo';
    els.statusChip.className = 'chip demo';
    els.demoBanner.classList.remove('hidden');
  } else if (c.hasToken) {
    els.statusChip.textContent = `ACRCloud conectado · ${c.region}`;
    els.statusChip.className = 'chip ok';
    els.demoBanner.classList.add('hidden');
  } else {
    els.statusChip.textContent = 'Falta el API token';
    els.statusChip.className = 'chip bad';
    els.demoBanner.classList.add('hidden');
  }
  els.footerConfig.textContent = `Región ${c.region} · engine ${c.engine} · paralelo ${c.concurrency}.`;

  const active = (app.counts.uploading || 0) + (app.counts.processing || 0);
  els.stats.total.textContent = app.files.length;
  els.stats.queued.textContent = app.counts.queued || 0;
  els.stats.active.textContent = active;
  els.stats.human.textContent = app.counts.human || 0;
  els.stats.ai.textContent = app.counts.ai || 0;
  els.stats.error.textContent = app.counts.error || 0;
}

function statusBadge(file) {
  switch (file.status) {
    case 'staged':
      return '<span class="badge">Listo para analizar</span>';
    case 'queued':
      return '<span class="badge work">En cola</span>';
    case 'uploading':
      return `<span class="badge work">Subiendo ${Math.min(99, file.progress || 0)}%</span>`;
    case 'processing':
      return `<span class="badge work">Analizando ${Math.min(99, file.progress || 0)}%</span>`;
    case 'done':
      return file.summary?.prediction === 'ai_generated'
        ? '<span class="badge ai">Analizado</span>'
        : file.summary?.prediction === 'human'
          ? '<span class="badge human">Analizado</span>'
          : '<span class="badge warnb">Analizado</span>';
    case 'error':
      return '<span class="badge err">Error</span>';
    case 'canceled':
      return '<span class="badge">Cancelado</span>';
    default:
      return `<span class="badge">${esc(file.status)}</span>`;
  }
}

function predictionCell(summary) {
  if (!summary || summary.found === false) return '<span class="muted">—</span>';
  if (summary.prediction === 'ai_generated') return '<span class="badge ai">IA generada</span>';
  if (summary.prediction === 'human') return '<span class="badge human">Humana</span>';
  return '<span class="badge warnb">Sin voz</span>';
}

function aiCell(summary, status) {
  if (!summary || !summary.found) {
    return `<div class="ai-cell"><span class="ai-num muted">${status === 'error' ? '—' : '…'}</span></div>`;
  }
  const pct = Number(summary.aiProbability) || 0;
  const cls = summary.prediction === 'ai_generated' ? 'ai' : 'human';
  return `
    <div class="ai-cell">
      <span class="ai-num" style="color:${cls === 'ai' ? 'var(--bad)' : 'var(--good)'}">${fmtPct(pct)}</span>
      <div class="ai-bar"><i class="${cls}" style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>
    </div>`;
}

function visibleFiles() {
  const term = els.search.value.trim().toLowerCase();
  const mode = els.filter.value;
  return app.files.filter((f) => {
    if (term && !f.name.toLowerCase().includes(term)) return false;
    if (mode === 'ai') return f.status === 'done' && f.summary?.prediction === 'ai_generated';
    if (mode === 'human') return f.status === 'done' && f.summary?.prediction === 'human';
    if (mode === 'active') return ['queued', 'uploading', 'processing', 'staged'].includes(f.status);
    if (mode === 'error') return f.status === 'error';
    return true;
  });
}

function renderTable() {
  const files = visibleFiles();
  els.empty.classList.toggle('hidden', files.length > 0);
  els.tbody.innerHTML = files
    .map((f) => {
      const s = f.summary;
      const meta = [fmtSize(f.size), f.demo ? 'demo' : '', f.finishedAt ? timeAgo(f.finishedAt) : timeAgo(f.createdAt)]
        .filter(Boolean)
        .join(' · ');
      return `
      <tr data-id="${f.id}">
        <td class="col-file">
          <div class="fname">${esc(f.name)}</div>
          <div class="fmeta">${esc(meta)}</div>
          ${f.error ? `<div class="errtext">${esc(f.error)}</div>` : ''}
        </td>
        <td>${statusBadge(f)}</td>
        <td class="col-ai">${aiCell(s, f.status)}</td>
        <td>${predictionCell(s)}</td>
        <td>${s?.found ? esc(s.likelySource) : '<span class="muted">—</span>'}</td>
        <td class="dur">${s?.found ? fmtDur(s.duration) : '<span class="muted">—</span>'}</td>
        <td class="col-actions"><button class="icon-btn" data-del="${f.id}" title="Quitar de la lista">✕</button></td>
      </tr>`;
    })
    .join('');
}

/* ---------- detalle ---------- */

function openDetail(id) {
  const file = app.files.find((f) => f.id === id);
  if (!file) return;
  const s = file.summary;
  const pct = s?.found ? Number(s.aiProbability) : 0;
  const color = !s?.found ? '#8d96ab' : s.prediction === 'ai_generated' ? '#ff5c78' : '#42d392';
  const sources = (s?.sources || [])
    .filter((x) => !/humano/i.test(x.source))
    .slice(0, 6)
    .map(
      (x) => `
      <div class="src-row">
        <span>${esc(x.source)}</span>
        <div class="src-track"><i style="width:${Math.max(1, Math.min(100, x.probability))}%"></i></div>
        <span class="pct">${Number(x.probability).toFixed(2)} %</span>
      </div>`
    )
    .join('');
  const segments = (s?.segments || [])
    .slice(0, 40)
    .map(
      (seg) => `
      <tr>
        <td>${fmtDur(seg.start)} – ${fmtDur(seg.end)}</td>
        <td>${Number(seg.aiProbability).toFixed(2)} %</td>
        <td>${seg.prediction === 'ai_generated' ? '<span class="badge ai">IA</span>' : seg.prediction === 'human' ? '<span class="badge human">Humana</span>' : '<span class="badge warnb">Sin voz</span>'}</td>
        <td>${esc(seg.likelySource || '—')}</td>
      </tr>`
    )
    .join('');
  const stems = (s?.stems || [])
    .map(
      (st) => `<tr>
        <td>${esc(st.stem)}</td>
        <td>${Number(st.aiProbability).toFixed(2)} %</td>
        <td>${esc(st.likelySource || '—')}</td>
        <td>${fmtDur(st.duration)}</td>
      </tr>`
    )
    .join('');

  detailBody.innerHTML = `
    <header class="dialog-head">
      <h2>${esc(file.name)}</h2>
      <button class="icon-btn" value="cancel" aria-label="Cerrar">✕</button>
    </header>
    <div class="detail-hero">
      <div class="gauge" style="--p:${Math.max(0, Math.min(100, pct))};--gauge-color:${color}">
        <b>${s?.found ? `${Math.round(pct)}%` : '—'}</b>
      </div>
      <div class="detail-title">
        <div>${predictionCell(s)}</div>
        <div class="kv">
          <span>Probabilidad IA: <b>${s?.found ? fmtPct(pct) : '—'}</b></span>
          <span>Confianza: <b>${esc(s?.confidence || '—')}</b></span>
          <span>Duración: <b>${s?.found ? fmtDur(s.duration) : '—'}</b></span>
        </div>
        <div class="kv">
          <span>Estado: <b>${esc(file.status)}</b></span>
          ${file.acrFileId ? `<span>ACRCloud id: <b>${esc(file.acrFileId)}</b></span>` : ''}
          ${file.demo ? '<span><b>demo</b></span>' : ''}
        </div>
        ${file.error ? `<div class="errtext">${esc(file.error)}</div>` : ''}
      </div>
    </div>
    ${sources ? `<div class="section-title">Fuentes probables</div><div class="sources">${sources}</div>` : ''}
    ${stems ? `<div class="section-title">Stems</div><div class="table-wrap"><table class="seg-table"><thead><tr><th>Stem</th><th>IA</th><th>Fuente</th><th>Duración</th></tr></thead><tbody>${stems}</tbody></table></div>` : ''}
    ${segments ? `<div class="section-title">Segmentos</div><div class="table-wrap" style="max-height:260px;overflow:auto"><table class="seg-table"><thead><tr><th>Tramo</th><th>IA</th><th>Predicción</th><th>Fuente</th></tr></thead><tbody>${segments}</tbody></table></div>` : ''}
    ${!s?.found ? '<p class="muted">Sin datos de detección todavía. Espera a que termine el análisis.</p>' : ''}
  `;
  detailDialog.showModal();
}

/* ---------- subida ---------- */

function setUploadUi(visible) {
  els.uploadStatus.classList.toggle('hidden', !visible);
}

async function uploadFile(file, batchId) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}&batch=${encodeURIComponent(batchId)}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      app.uploads.loaded += event.loaded - (file._sent || 0);
      file._sent = event.loaded;
      const total = app.uploads.size || 1;
      els.uploadBar.style.width = `${Math.min(100, (app.uploads.loaded / total) * 100)}%`;
      els.uploadCount.textContent = `${app.uploads.ok + app.uploads.failed} / ${app.uploads.total}`;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        app.uploads.ok += 1;
      } else {
        app.uploads.failed += 1;
        let msg = `Error ${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {
          /* ignore */
        }
        toast(`${file.name}: ${msg}`, 'error');
      }
      app.uploads.loaded += (file.size || 0) - (file._sent || 0);
      file._sent = file.size || 0;
      resolve();
    };
    xhr.onerror = () => {
      app.uploads.failed += 1;
      toast(`${file.name}: fallo de red al subir`, 'error');
      resolve();
    };
    xhr.send(file);
  });
}

async function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const tooBig = files.filter((f) => f.size > MAX_UPLOAD);
  for (const f of tooBig) toast(`${f.name}: supera 1 GB`, 'error');
  const valid = files.filter((f) => f.size <= MAX_UPLOAD && f.size > 0);
  if (!valid.length) return;

  const batchId = `b-${Date.now()}`;
  app.uploads = {
    active: 0,
    total: valid.length,
    loaded: 0,
    size: valid.reduce((acc, f) => acc + f.size, 0),
    ok: 0,
    failed: 0
  };
  els.uploadBar.style.width = '0%';
  els.uploadLabel.textContent = `Subiendo ${valid.length} archivo(s)…`;
  els.uploadCount.textContent = `0 / ${valid.length}`;
  setUploadUi(true);

  const queue = [...valid];
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length) {
      const file = queue.shift();
      if (!file) break;
      await uploadFile(file, batchId);
    }
  });
  await Promise.all(workers);

  els.uploadLabel.textContent = `Subida terminada · ${app.uploads.ok} correcta(s)${app.uploads.failed ? ` · ${app.uploads.failed} con error` : ''}`;
  els.uploadBar.style.width = '100%';
  app.uploads.active = 0;
  setTimeout(() => setUploadUi(false), 2600);
  await refresh();
}

/* ---------- ajustes ---------- */

function fillSettings() {
  const c = app.config || {};
  document.getElementById('setToken').value = '';
  document.getElementById('setToken').placeholder = c.hasToken
    ? `Token guardado (${c.tokenHint}) — deja vacío para no cambiarlo`
    : 'Pega el token de Consola → Account → Developer';
  document.getElementById('setRegion').value = c.region || 'eu-west-1';
  document.getElementById('setEngine').value = String(c.engine || 5);
  document.getElementById('setBuckets').value = (c.buckets || []).join(', ');
  document.getElementById('setConcurrency').value = c.concurrency || 3;
  document.getElementById('setPoll').value = c.pollMs || 2500;
  document.getElementById('setTimeout').value = Math.round((c.timeoutMs || 600000) / 60000);
  document.getElementById('setAutoQueue').checked = Boolean(c.autoQueue);
  document.getElementById('setDemo').checked = Boolean(c.demo);
  settingsMsg.textContent = '';
  settingsMsg.className = 'settings-msg';
}

async function saveSettings(event) {
  if (event.submitter && event.submitter.value === 'cancel') return; // botón ✕: cierra sin guardar
  event.preventDefault();
  const payload = {
    region: document.getElementById('setRegion').value,
    engine: Number(document.getElementById('setEngine').value),
    buckets: document.getElementById('setBuckets').value,
    concurrency: Number(document.getElementById('setConcurrency').value),
    pollMs: Number(document.getElementById('setPoll').value),
    timeoutMs: Number(document.getElementById('setTimeout').value) * 60000,
    autoQueue: document.getElementById('setAutoQueue').checked,
    demo: document.getElementById('setDemo').checked
  };
  const token = document.getElementById('setToken').value.trim();
  if (token) payload.token = token;

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    app.config = data.config;
    settingsDialog.close();
    toast('Ajustes guardados', 'ok');
    await refresh();
  } catch (err) {
    settingsMsg.textContent = err.message;
    settingsMsg.className = 'settings-msg bad';
  }
}

async function testConnection() {
  settingsMsg.textContent = 'Probando…';
  settingsMsg.className = 'settings-msg';
  try {
    const res = await fetch('/api/test', { method: 'POST' });
    const data = await res.json();
    settingsMsg.textContent = data.message || (data.ok ? 'Token válido' : 'Fallo');
    settingsMsg.className = `settings-msg ${data.ok ? 'ok' : 'bad'}`;
  } catch (err) {
    settingsMsg.textContent = err.message;
    settingsMsg.className = 'settings-msg bad';
  }
}

/* ---------- acciones ---------- */

async function postJson(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function queueAll() {
  try {
    const data = await postJson('/api/queue', {});
    toast(data.queued ? `${data.queued} archivo(s) a la cola` : 'Nada pendiente en cola', data.queued ? 'ok' : 'info');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function retryFailed() {
  try {
    const data = await postJson('/api/retry', {});
    toast(data.queued ? `${data.queued} archivo(s) reencolados` : 'No hay fallidos que reintentar', 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function clearFinished() {
  if (!confirm('¿Quitar de la lista los archivos terminados y borrar las copias locales?')) return;
  try {
    const data = await postJson('/api/clear', { mode: 'done' });
    toast(`${data.removed} archivo(s) quitados`, 'ok');
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- eventos ---------- */

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') els.fileInput.click();
});
els.fileInput.addEventListener('change', () => {
  handleFiles(els.fileInput.files);
  els.fileInput.value = '';
});

for (const evt of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag');
  });
}
for (const evt of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
  });
}
els.dropzone.addEventListener('drop', (e) => {
  const files = e.dataTransfer?.files;
  if (files?.length) handleFiles(files);
});

els.tbody.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/files/${del.dataset.del}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('No se pudo quitar');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }
  const row = e.target.closest('tr[data-id]');
  if (row) openDetail(row.dataset.id);
});

els.search.addEventListener('input', renderTable);
els.filter.addEventListener('change', renderTable);
document.getElementById('btnQueue').addEventListener('click', queueAll);
document.getElementById('btnRetry').addEventListener('click', retryFailed);
document.getElementById('btnClear').addEventListener('click', clearFinished);
document.getElementById('btnSettings').addEventListener('click', () => {
  fillSettings();
  settingsDialog.showModal();
});
document.getElementById('btnHelp').addEventListener('click', () => helpDialog.showModal());
document.getElementById('settingsForm').addEventListener('submit', saveSettings);
document.getElementById('btnTest').addEventListener('click', testConnection);
document.getElementById('btnResetContainers').addEventListener('click', async () => {
  if (!confirm('¿Borrar los contenedores de File Scanning creados por esta app en ACRCloud?')) return;
  settingsMsg.textContent = 'Borrando…';
  try {
    const data = await postJson('/api/container/reset', {});
    const ok = data.results.filter((r) => r.deleted).length;
    settingsMsg.textContent = `${ok} contenedor(es) borrados`;
    settingsMsg.className = 'settings-msg ok';
  } catch (err) {
    settingsMsg.textContent = err.message;
    settingsMsg.className = 'settings-msg bad';
  }
});

refresh();
setInterval(refresh, 1200);
