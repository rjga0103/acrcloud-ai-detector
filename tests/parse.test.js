import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, toCsv } from '../lib/parse.js';

const docSample = {
  ai_detection: [
    {
      start: 0,
      end: 168.68,
      prediction: 'ai_generated',
      likely_source: 'Suno',
      ai_probability: 97.61,
      duration: 168.68,
      stem: 'original',
      source_probabilities: [
        { source: 'Suno', probability: 96 },
        { source: 'Udio', probability: 0.6 },
        { source: 'Sonauto', probability: 0.2 },
        { source: 'Mureka', probability: 0.8 },
        { source: 'riffusion', probability: 0.2 }
      ],
      model_id: 'lv1axtcv'
    }
  ]
};

test('resumen del ejemplo oficial de ACRCloud', () => {
  const s = summarize(docSample);
  assert.equal(s.found, true);
  assert.equal(s.prediction, 'ai_generated');
  assert.equal(s.aiProbability, 97.61);
  assert.equal(s.humanProbability, 2.39);
  assert.equal(s.likelySource, 'Suno');
  assert.equal(s.duration, 168.68);
  assert.equal(s.sources[0].source, 'Suno');
  assert.equal(s.sources[0].probability, 96);
  assert.equal(s.confidence, 'alta');
});

test('prefiere stem original y pondera por duración', () => {
  const results = {
    metadata: {
      ai_detection: [
        { stem: 'vocals', ai_probability: 90, duration: 100, prediction: 'ai_generated' },
        { stem: 'original', ai_probability: 20, duration: 60, prediction: 'human' },
        { stem: 'accompaniment', ai_probability: 60, duration: 60, prediction: 'ai_generated' }
      ]
    }
  };
  const s = summarize(results);
  assert.equal(s.stems.length, 1);
  assert.equal(s.aiProbability, 20);
  assert.equal(s.prediction, 'human');
  assert.equal(s.duration, 60);
});

test('pondera segmentos por longitud cuando no hay ai_probability global', () => {
  const results = {
    ai_detection: [
      {
        stem: 'original',
        duration: 100,
        likely_source: 'Human',
        segments: [
          { start: 0, end: 90, ai_probability: 10, prediction: 'human' },
          { start: 90, end: 100, ai_probability: 100, prediction: 'ai_generated' }
        ]
      }
    ]
  };
  const s = summarize(results);
  assert.equal(s.aiProbability, 19);
  assert.equal(s.prediction, 'human');
  assert.equal(s.segments.length, 2);
});

test('sin bloque ai_detection no inventa resultados', () => {
  const s = summarize({ music: [{ result: { title: 'x' } }] });
  assert.equal(s.found, false);
});

test('umbral 50 % decide la predicción binaria', () => {
  const s = summarize({ ai_detection: [{ ai_probability: 50, prediction: 'ai_generated', stem: 'original', duration: 10 }] });
  assert.equal(s.prediction, 'ai_generated');
  const h = summarize({ ai_detection: [{ ai_probability: 49.99, prediction: 'human', stem: 'original', duration: 10 }] });
  assert.equal(h.prediction, 'human');
});

test('csv con cabecera y filas escapadas', () => {
  const csv = toCsv([
    {
      name: 'canción, "rara".mp3',
      status: 'done',
      acrFileId: 'abc',
      createdAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      summary: {
        ...summarize(docSample),
        sources: [{ source: 'Humano', probability: 1 }, { source: 'Suno', probability: 96 }]
      }
    }
  ]);
  const lines = csv.split('\r\n');
  assert.match(lines[0], /^Archivo,Estado,Prediccion/);
  assert.match(lines[0], /IA %/);
  assert.match(lines[1], /^"canción, ""rara"".mp3"/);
});
