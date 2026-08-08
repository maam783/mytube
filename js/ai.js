// Bewertung der Videos mit Claude Haiku — direkt vom iPad aus.
//
// Der Key liegt in IndexedDB auf deinem Gerät und geht ausschließlich an
// api.anthropic.com. Das ist der Punkt, an dem `dangerouslyAllowBrowser`
// vertretbar ist: Ein-Nutzer-App, eigenes Gerät, selbst eingetragener Key.

import { Anthropic } from './anthropic.js';
import * as db from './db.js';

// Haiku 4.5: $1 / Mio. Input-Token, $5 / Mio. Output-Token
const PRICE_IN_PER_TOKEN = 1 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 5 / 1_000_000;

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Die video_id aus der Eingabe' },
          score: { type: 'integer', description: '0-100, wie gut das Video zum Manifest passt' },
          reason: { type: 'string', description: 'Ein kurzer deutscher Satz, warum' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'score', 'reason', 'tags'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

const SYSTEM = `Du bewertest YouTube-Videos für genau eine Person, anhand ihres persönlichen Manifests.

Du bekommst das Manifest, optional Beispiele früherer Bewertungen dieser Person, und eine Liste von Videos mit Metadaten.

Für jedes Video vergibst du:
- score: 0-100. 0 = die Person will das definitiv nicht sehen, 100 = genau ihr Ding. Nutze die ganze Skala, nicht nur 40-60.
- reason: EIN kurzer deutscher Satz, der erklärt, warum. Dieser Satz wird der Person direkt unter dem Video angezeigt — schreibe ihn für sie, nicht als Debug-Ausgabe. Keine Floskeln wie "Dieses Video ist...", komm direkt zur Sache.
- tags: 1-4 kurze Schlagworte zum Inhalt.

Du bewertest nach dem Manifest, nicht nach allgemeiner Qualität. Ein handwerklich gutes Video, das die Person laut Manifest nicht sehen will, bekommt einen niedrigen Score.

Gib für jedes Video aus der Eingabe genau ein Ergebnis zurück, mit exakt der video_id aus der Eingabe.`;

export class BudgetExceeded extends Error {
  constructor(spent, budget) {
    super(`Tagesbudget erreicht ($${spent.toFixed(3)} von $${budget.toFixed(2)}).`);
    this.name = 'BudgetExceeded';
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function getSpend() {
  const s = await db.kvGet('spend', null);
  if (!s || s.day !== today()) {
    return { day: today(), usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
  }
  return s;
}

// Läufe können parallel sein; Lesen-Ändern-Schreiben auf demselben Datensatz
// muss trotzdem nacheinander passieren, sonst gehen Kosten verloren.
let spendLock = Promise.resolve();

async function addSpend(usage) {
  const run = spendLock.then(() => addSpendUnsafe(usage), () => addSpendUnsafe(usage));
  spendLock = run.catch(() => {});
  return run;
}

async function addSpendUnsafe(usage) {
  const s = await getSpend();
  const inTok = (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0)
    + (usage?.cache_creation_input_tokens || 0);
  const outTok = usage?.output_tokens || 0;
  s.inputTokens += inTok;
  s.outputTokens += outTok;
  s.usd += inTok * PRICE_IN_PER_TOKEN + outTok * PRICE_OUT_PER_TOKEN;
  s.calls += 1;
  await db.kvSet('spend', s);
  return s;
}

function client(apiKey) {
  return new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    // Bewusst knapp: 3 Versuche à 60 s begrenzen eine hängende Anfrage auf drei
    // Minuten. Mit den vorherigen Werten (4 × 90 s) konnte ein einziger Batch
    // sechs Minuten blockieren, ohne dass irgendetwas kaputt war.
    maxRetries: 2,
    timeout: 60_000,
  });
}

function videoLine(v) {
  const mins = Math.round(v.durationSec / 60);
  const parts = [
    `video_id: ${v.id}`,
    `titel: ${v.title}`,
    `kanal: ${v.channelTitle}`,
    `dauer: ${mins} min`,
    `veröffentlicht: ${v.publishedAt.slice(0, 10)}`,
  ];
  if (v.viewCount) parts.push(`aufrufe: ${v.viewCount}`);
  if (v.lang) parts.push(`sprache: ${v.lang}`);
  if (v.tags?.length) parts.push(`tags: ${v.tags.slice(0, 8).join(', ')}`);
  if (v.liveStatus) parts.push(`live: ${v.liveStatus}`);
  const desc = (v.description || '').replace(/\s+/g, ' ').slice(0, 500);
  if (desc) parts.push(`beschreibung: ${desc}`);
  return parts.join('\n');
}

function examplesBlock(examples) {
  if (!examples.length) return '';
  const lines = examples.map((e) =>
    `- [${e.value > 0 ? 'MOCHTE ICH' : 'MOCHTE ICH NICHT'}] „${e.title}" (${e.channelTitle})`);
  return `\n\n## Frühere Bewertungen dieser Person\n${lines.join('\n')}`;
}

/**
 * Bewertet einen Batch Videos. Wirft BudgetExceeded, bevor Kosten entstehen.
 * Gibt { results, usage, spend } zurück; results ist nach video_id gemappt.
 */
export async function scoreBatch(videos, { apiKey, model, manifest, examples = [], budgetUsd, signal }) {
  if (!videos.length) return { results: new Map(), spend: await getSpend() };

  const spendBefore = await getSpend();
  if (budgetUsd > 0 && spendBefore.usd >= budgetUsd) {
    throw new BudgetExceeded(spendBefore.usd, budgetUsd);
  }

  const prompt = `## Manifest dieser Person\n${manifest}${examplesBlock(examples)}\n\n`
    + `## Zu bewertende Videos (${videos.length})\n\n`
    + videos.map(videoLine).join('\n---\n');

  const res = await client(apiKey).messages.create({
    model,
    // Die Ausgabe ist durch das Schema hart begrenzt (kurzer Satz + Tags je
    // Video), deshalb reicht hier deutlich weniger als der Standardwert.
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
  }, { signal });

  const spend = await addSpend(res.usage);

  if (res.stop_reason === 'refusal') {
    throw new Error('Claude hat die Bewertung abgelehnt. Prüfe das Manifest auf problematische Formulierungen.');
  }
  if (res.stop_reason === 'max_tokens') {
    throw new Error('Antwort wurde abgeschnitten — bitte die Batch-Größe in den Einstellungen verkleinern.');
  }

  const text = res.content.find((b) => b.type === 'text')?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Claude hat kein gültiges JSON geliefert.');
  }

  const results = new Map();
  for (const r of parsed.results || []) {
    if (!r?.id) continue;
    results.set(r.id, {
      // Structured Outputs kennt keine numerischen Grenzen — hier klemmen.
      score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))),
      reason: String(r.reason || '').slice(0, 300),
      tags: Array.isArray(r.tags) ? r.tags.slice(0, 4).map(String) : [],
    });
  }

  return { results, usage: res.usage, spend };
}

/** Die zuletzt bewerteten Videos als Few-Shot-Beispiele fürs nächste Prompt. */
export async function recentExamples(limit = 15) {
  const [feedback, videos] = await Promise.all([db.getAll('feedback'), db.getAll('videos')]);
  const byId = new Map(videos.map((v) => [v.id, v]));
  const thumbs = feedback
    .filter((f) => f.type === 'thumb')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const out = [];
  const pos = [];
  const neg = [];
  for (const f of thumbs) {
    const v = byId.get(f.videoId);
    if (!v) continue;
    const target = f.value > 0 ? pos : neg;
    if (target.length < limit) target.push({ ...f, title: v.title, channelTitle: v.channelTitle });
    if (pos.length >= limit && neg.length >= limit) break;
  }
  out.push(...pos, ...neg);
  return out;
}
