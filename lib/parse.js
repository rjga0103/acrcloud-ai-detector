const AI_KEY = 'ai_detection';

const SOURCE_LABELS = {
  human: 'Humano',
  suno: 'Suno',
  udio: 'Udio',
  sonauto: 'Sonauto',
  treblo: 'Treblo',
  mureka: 'Mureka',
  riffusion: 'Riffusion',
  seedmusic: 'Seedmusic',
  minimax: 'Minimax',
  elevenlabs: 'ElevenLabs',
  lyria: 'Lyria',
  boomy: 'Boomy'
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function span(entry) {
  const direct = num(entry.end) - num(entry.start);
  if (direct > 0) return direct;
  const dur = num(entry.duration);
  return dur > 0 ? dur : 1;
}

function weighted(items, weightOf) {
  let wsum = 0;
  let total = 0;
  for (const item of items) {
    const w = Math.max(weightOf(item), 0.001);
    total += num(item.value ?? item) * w;
    wsum += w;
  }
  return wsum ? total / wsum : 0;
}

export function sourceLabel(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'Desconocido';
  return SOURCE_LABELS[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Recorre el JSON de ACRCloud y devuelve todos los bloques `ai_detection`. */
export function findAiEntries(node, depth = 0, out = []) {
  if (!node || depth > 8 || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findAiEntries(item, depth + 1, out);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === AI_KEY && Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object') out.push(item);
      continue;
    }
    if (value && typeof value === 'object') findAiEntries(value, depth + 1, out);
  }
  return out;
}

function mergeSources(entries) {
  const totals = new Map();
  for (const entry of entries) {
    const list = Array.isArray(entry.source_probabilities) ? entry.source_probabilities : [];
    for (const item of list) {
      if (!item || item.source == null) continue;
      const key = sourceLabel(item.source);
      const w = span(entry);
      const slot = totals.get(key) || { weight: 0, value: 0 };
      slot.value += num(item.probability) * w;
      slot.weight += w;
      totals.set(key, slot);
    }
  }
  return [...totals.entries()]
    .map(([source, slot]) => ({ source, probability: round(slot.value / (slot.weight || 1), 2) }))
    .sort((a, b) => b.probability - a.probability);
}

export function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round((Number(n) || 0) * p) / p;
}

function entryStats(entry) {
  const segments = (Array.isArray(entry.segments) ? entry.segments : []).filter(
    (s) => s && s.ai_probability != null
  );
  let aiProbability;
  let duration;
  if (segments.length) {
    aiProbability = weighted(
      segments.map((s) => ({ value: s.ai_probability, w: span(s) })),
      (x) => x.w
    );
    duration = segments.reduce((acc, s) => acc + span(s), 0);
  } else {
    aiProbability = num(entry.ai_probability);
    duration = span(entry);
  }
  const sources = Array.isArray(entry.source_probabilities)
    ? entry.source_probabilities
        .filter((s) => s && s.source != null)
        .map((s) => ({ source: sourceLabel(s.source), probability: round(num(s.probability), 2) }))
        .sort((a, b) => b.probability - a.probability)
    : [];
  return {
    stem: String(entry.stem || 'original').toLowerCase(),
    prediction: normalizePrediction(entry.prediction, aiProbability),
    aiProbability: round(aiProbability, 2),
    duration: round(duration, 2),
    weight: Math.max(duration, 0.001),
    likelySource: sourceLabel(entry.likely_source || sources[0]?.source || ''),
    sources,
    segments: segments.slice(0, 200).map((s) => ({
      start: round(num(s.start), 2),
      end: round(num(s.end), 2),
      prediction: normalizePrediction(s.prediction, num(s.ai_probability)),
      likelySource: sourceLabel(s.likely_source || ''),
      aiProbability: round(num(s.ai_probability), 2)
    })),
    modelId: entry.model_id || null
  };
}

function normalizePrediction(prediction, aiProbability) {
  const p = String(prediction || '').toLowerCase();
  if (['ai_generated', 'human', 'no_vocals'].includes(p)) return p;
  return aiProbability >= 50 ? 'ai_generated' : 'human';
}

/**
 * Convierte el JSON de resultados de File Scanning en un resumen de negocio.
 * Prefiere los stems "original" y pondera por duración.
 */
export function summarize(results) {
  const entries = findAiEntries(results);
  if (!entries.length) return { found: false };
  const originals = entries.filter((e) => !e.stem || /original/i.test(String(e.stem)));
  const base = originals.length ? originals : entries;
  const stems = base.map(entryStats);
  const primary = stems.reduce((a, b) => (b.weight > a.weight ? b : a));
  const aiProbability = round(
    weighted(
      stems.map((s) => ({ value: s.aiProbability, w: s.weight })),
      (x) => x.w
    ),
    2
  );
  const sources = mergeSources(base);
  const prediction =
    primary.prediction === 'no_vocals' && aiProbability >= 50
      ? 'no_vocals'
      : normalizePrediction(primary.prediction, aiProbability);
  const confidence =
    Math.abs(aiProbability - 50) >= 25 ? 'alta' : Math.abs(aiProbability - 50) >= 10 ? 'media' : 'baja';
  return {
    found: true,
    prediction,
    aiProbability,
    humanProbability: round(100 - aiProbability, 2),
    likelySource: primary.likelySource,
    duration: round(primary.weight, 2),
    stems,
    sources,
    segments: primary.segments,
    modelId: primary.modelId,
    confidence
  };
}

export function predictionLabel(prediction) {
  switch (prediction) {
    case 'ai_generated':
      return 'IA generada';
    case 'human':
      return 'Humana';
    case 'no_vocals':
      return 'Sin voz / instrumental';
    default:
      return 'Sin resultados';
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",;\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(files) {
  const header = [
    'Archivo',
    'Estado',
    'Prediccion',
    'IA %',
    'Humano %',
    'Fuente probable',
    'Confianza',
    'Duracion (s)',
    'Top fuentes IA',
    'Stems',
    'ACRCloud file id',
    'Error',
    'Creado',
    'Terminado'
  ];
  const rows = files.map((f) => {
    const s = f.summary || {};
    return [
      f.name,
      f.status,
      s.found ? predictionLabel(s.prediction) : '',
      s.found ? s.aiProbability : '',
      s.found ? s.humanProbability : '',
      s.likelySource || '',
      s.confidence || '',
      s.duration || '',
      (s.sources || [])
        .filter((x) => x.source !== 'Humano')
        .slice(0, 3)
        .map((x) => `${x.source} ${x.probability}%`)
        .join(' | '),
      (s.stems || []).map((x) => `${x.stem} ${x.aiProbability}%`).join(' | '),
      f.acrFileId || '',
      f.error || '',
      f.createdAt || '',
      f.finishedAt || ''
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
