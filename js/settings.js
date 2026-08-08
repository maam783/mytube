import * as db from './db.js';

export const DEFAULTS = {
  ytKey: '',
  anthropicKey: '',

  // Stufe 0 — dein Kernproblem
  maxAgeDays: 14,          // härtester Filter: nichts Älteres kommt in den Feed
  minDurationSec: 120,     // kürzer als 2 Min fliegt raus
  maxDurationSec: 0,       // 0 = kein Limit
  shortsMaxSec: 185,       // Shorts dürfen bis 3 Min lang sein
  languages: [],           // leer = alle Sprachen

  // Ranking
  sortMode: 'newest',      // 'newest' | 'ai'
  halfLifeDays: 5,
  explorationEvery: 10,

  // KI-Filter
  aiEnabled: false,
  model: 'claude-haiku-4-5',
  batchSize: 25,
  dailyBudgetUsd: 0.50,   // Anthropic rechnet in USD ab

  // Sync
  concurrency: 5,
  itemsPerChannel: 15,
  keepDays: 30,            // älter wird beim Aufräumen gelöscht
};

export const DEFAULT_MANIFEST = `## Was ich sehen will
- Tiefe technische Erklärungen, auch wenn sie 40 Minuten dauern
- Handwerk und Fertigung, wo man jemandem echt bei der Arbeit zusieht

## Was ich nicht sehen will
- Reaction-Videos, Drama, Kommentare zu anderen Kanälen
- "SHOCKING", "You won't believe", übertriebene Thumbnails
- News-Kommentierung ohne eigenen Rechercheanteil

## Kontext über mich
- Deutsch und Englisch; anderes nur mit guten Untertiteln
- Abends eher lang und ruhig, mittags eher kurz

## Grenzfälle
- Sponsor-Segmente stören nicht, wenn der Rest gut ist
- Bei Musik gilt das alles nicht`;

// Bewusst ohne Lese-Cache: Die Einstellungen sind ein einziger winziger
// Datensatz, und ein veralteter Cache wäre unterwegs nicht zu diagnostizieren
// (zwei offene Tabs, eingespielte Sicherung — und plötzlich läuft die App mit
// Werten, die nirgends mehr stehen). `peek()` gibt es nur für den Fall, dass
// synchron gelesen werden muss.
let last = { ...DEFAULTS };

export async function load() {
  const stored = await db.kvGet('settings', {});
  last = { ...DEFAULTS, ...stored };
  return last;
}

export async function save(patch) {
  const current = await load();
  last = { ...current, ...patch };
  await db.kvSet('settings', last);
  return last;
}

export function peek() {
  return last;
}

export async function getManifest() {
  return db.kvGet('manifest', DEFAULT_MANIFEST);
}

export async function setManifest(text) {
  return db.kvSet('manifest', text);
}

export function isConfigured(s) {
  return Boolean(s.ytKey);
}
