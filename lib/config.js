import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const REGIONS = ['eu-west-1', 'us-west-2', 'ap-southeast-1'];

export const DEFAULTS = {
  token: '',
  region: 'eu-west-1',
  engine: 5, // 5 = AI Music Detection only, 1 = fingerprinting (+ ai_detection flag)
  buckets: [], // ids o nombres de bucket del proyecto
  audioType: 'linein',
  concurrency: 3,
  pollMs: 2500,
  timeoutMs: 600000,
  demo: false,
  autoQueue: true,
  retainUploads: true,
  planQuotaMinutes: 0, // 0 = sin cuota configurada
  cycleDay: 1,
  autoRegionFailover: false // si una región se llena, prueba la siguiente
};

let cfg = null;

export function ensureDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function normalize(input) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === 'buckets') {
      const list = Array.isArray(value) ? value : String(value || '').split(',');
      out.buckets = list
        .map((v) => (typeof v === 'string' ? v.trim() : v))
        .filter((v) => v !== '' && v != null)
        .map((v) => (/^\d+$/.test(String(v)) ? Number(v) : v));
    } else if (key === 'region') {
      out.region = REGIONS.includes(value) ? value : DEFAULTS.region;
    } else if (key === 'engine') {
      out.engine = Number(value) === 1 ? 1 : 5;
    } else if (key === 'token') {
      out.token = String(value || '').trim();
    } else if (key === 'audioType') {
      out.audioType = value === 'recorded' ? 'recorded' : 'linein';
    } else if (key === 'planQuotaMinutes') {
      const n = Number(value);
      out.planQuotaMinutes = Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : DEFAULTS.planQuotaMinutes;
    } else if (key === 'cycleDay') {
      const n = Math.round(Number(value));
      out.cycleDay = n >= 1 && n <= 28 ? n : DEFAULTS.cycleDay;
    } else if (typeof DEFAULTS[key] === 'number') {
      const n = Number(value);
      out[key] = Number.isFinite(n) && n > 0 ? n : DEFAULTS[key];
    } else if (typeof DEFAULTS[key] === 'boolean') {
      out[key] = value === true || value === 'true' || value === 1 || value === '1';
    } else {
      out[key] = value;
    }
  }
  out.concurrency = Math.min(Math.max(Math.round(out.concurrency), 1), 8);
  out.pollMs = Math.min(Math.max(Math.round(out.pollMs), 500), 60000);
  out.timeoutMs = Math.min(Math.max(Math.round(out.timeoutMs), 30000), 3600000);
  return out;
}

export function loadConfig() {
  ensureDirs();
  if (cfg) return cfg;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  cfg = normalize(raw);
  const envToken = process.env.ACRCLOUD_TOKEN;
  if (envToken && !cfg.token) cfg.token = envToken.trim();
  return cfg;
}

export function getConfig() {
  return cfg || loadConfig();
}

export function setConfig(patch = {}) {
  const current = getConfig();
  const next = normalize({ ...current, ...patch });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  cfg = next;
  return cfg;
}

export function sanitizeConfig(c = getConfig()) {
  return {
    region: c.region,
    engine: c.engine,
    buckets: c.buckets,
    audioType: c.audioType,
    concurrency: c.concurrency,
    pollMs: c.pollMs,
    timeoutMs: c.timeoutMs,
    demo: c.demo,
    autoQueue: c.autoQueue,
    retainUploads: c.retainUploads,
    planQuotaMinutes: c.planQuotaMinutes,
    cycleDay: c.cycleDay,
    autoRegionFailover: c.autoRegionFailover,
    hasToken: Boolean(c.token),
    tokenHint: c.token ? `••••${c.token.slice(-4)}` : ''
  };
}
