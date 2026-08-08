// Der Sync-Lauf. Läuft beim Öffnen der App, nicht nachts auf einem Server —
// das ist der Preis dafür, dass es keinen Server gibt.
//
// Grundsatz: alles degradiert, nichts stürzt ab. Jede Degradation wird
// sichtbar geloggt, damit du im Urlaub siehst, was schiefgeht.

import * as db from './db.js';
import * as yt from './youtube.js';
import * as ai from './ai.js';
import * as settingsModule from './settings.js';
import { DAY_MS, ageDays, isShort } from './rank.js';

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {(ev: {phase:string, done?:number, total?:number, message?:string, level?:string}) => void} onProgress
 */
export async function run(onProgress = () => {}) {
  const log = [];
  const note = (message, level = 'info') => {
    log.push({ at: new Date().toISOString(), level, message });
    onProgress({ phase: 'log', message, level });
  };

  const settings = await settingsModule.load();
  if (!settings.ytKey) throw new Error('Kein YouTube-API-Key hinterlegt.');

  const channels = (await db.getAll('channels')).filter((c) => c.active !== false);
  if (!channels.length) throw new Error('Noch keine Kanäle importiert.');

  const knownIds = new Set(await db.allKeys('videos'));
  const cutoff = Date.now() - settings.maxAgeDays * DAY_MS;

  // --- 1. Neue Video-IDs pro Kanal ---
  onProgress({ phase: 'channels', done: 0, total: channels.length });
  let done = 0;
  const freshIds = new Set();
  const touchedChannels = [];

  await mapLimit(channels, Math.max(1, settings.concurrency), async (channel) => {
    try {
      const res = await yt.fetchNewVideoIds(channel, settings.ytKey, {
        known: knownIds,
        itemsPerChannel: settings.itemsPerChannel,
      });
      for (const n of res.notes) note(n, 'warn');
      for (const id of res.ids) freshIds.add(id);
      touchedChannels.push({
        ...channel,
        playlistMode: res.mode,
        lastPolledAt: new Date().toISOString(),
        lastStatus: 'ok',
      });
    } catch (e) {
      note(`Kanal „${channel.title}": ${e.message}`, 'error');
      touchedChannels.push({
        ...channel,
        lastPolledAt: new Date().toISOString(),
        lastStatus: `Fehler: ${e.message}`,
      });
      if (e.reason && /quota/i.test(e.reason)) throw e; // weiterlaufen wäre sinnlos
    } finally {
      onProgress({ phase: 'channels', done: ++done, total: channels.length });
    }
  });

  await db.putMany('channels', touchedChannels);

  // --- 2. Metadaten ---
  let added = 0;
  let droppedOld = 0;
  let droppedShort = 0;

  if (freshIds.size) {
    onProgress({ phase: 'details', done: 0, total: freshIds.size });
    const details = await yt.fetchVideoDetails([...freshIds], settings.ytKey);
    // Nur wo die Langform-Playlist versagt hat, muss die Dauer-Heuristik ran.
    const fallbackChannels = new Set(
      touchedChannels.filter((c) => c.playlistMode === 'uploads').map((c) => c.id));

    const keep = [];
    for (const v of details) {
      // Hartes Alterslimit schon beim Ingest: was zu alt ist, landet gar nicht
      // erst in der Datenbank.
      if (new Date(v.publishedAt).getTime() < cutoff) { droppedOld++; continue; }
      v.isShort = isShort(v, settings, { useDuration: fallbackChannels.has(v.channelId) });
      if (v.isShort) { droppedShort++; continue; }
      keep.push(v);
    }
    await db.putMany('videos', keep);
    added = keep.length;
    onProgress({ phase: 'details', done: freshIds.size, total: freshIds.size });
  }

  note(`${added} neue Videos übernommen`
    + (droppedOld ? `, ${droppedOld} zu alt` : '')
    + (droppedShort ? `, ${droppedShort} Shorts` : '')
    + '.');

  // --- 3. Aufräumen ---
  const purgeBefore = Date.now() - settings.keepDays * DAY_MS;
  const all = await db.getAll('videos');
  const stale = all.filter((v) => new Date(v.publishedAt).getTime() < purgeBefore);
  for (const v of stale) await db.del('videos', v.id);
  if (stale.length) note(`${stale.length} alte Videos aus der Datenbank entfernt.`);

  // --- 4. KI-Bewertung (optional) ---
  let scored = 0;
  if (settings.aiEnabled && settings.anthropicKey) {
    const manifest = await settingsModule.getManifest();
    const examples = await ai.recentExamples(15);
    const channelsById = new Map((await db.getAll('channels')).map((c) => [c.id, c]));

    const pending = (await db.getAll('videos'))
      .filter((v) => v.score == null && !v.dismissed && !v.watched)
      .filter((v) => ageDays(v) <= settings.maxAgeDays)
      .filter((v) => channelsById.get(v.channelId)?.active !== false)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

    onProgress({ phase: 'scoring', done: 0, total: pending.length });

    for (let i = 0; i < pending.length; i += settings.batchSize) {
      const batch = pending.slice(i, i + settings.batchSize);
      try {
        const { results } = await ai.scoreBatch(batch, {
          apiKey: settings.anthropicKey,
          model: settings.model,
          manifest,
          examples,
          budgetUsd: settings.dailyBudgetUsd,
        });
        const updates = [];
        for (const v of batch) {
          const r = results.get(v.id);
          if (!r) continue;
          updates.push({
            ...v,
            score: r.score,
            reason: r.reason,
            scoreTags: r.tags,
            scoredAt: new Date().toISOString(),
          });
        }
        await db.putMany('videos', updates);
        scored += updates.length;
        if (updates.length < batch.length) {
          note(`${batch.length - updates.length} Videos ohne Ergebnis — kommen beim nächsten Lauf erneut dran.`, 'warn');
        }
      } catch (e) {
        if (e instanceof ai.BudgetExceeded) {
          note(`${e.message} Bewertung pausiert, der Feed läuft chronologisch weiter.`, 'warn');
          break;
        }
        note(`Bewertung fehlgeschlagen: ${e.message}`, 'error');
        break; // Rest bleibt score=null und wird beim nächsten Lauf nachgeholt
      }
      onProgress({ phase: 'scoring', done: Math.min(i + settings.batchSize, pending.length), total: pending.length });
    }
    if (scored) note(`${scored} Videos bewertet.`);
  }

  const summary = {
    at: new Date().toISOString(),
    added, scored, droppedOld, droppedShort,
    purged: stale.length,
    channels: channels.length,
    quota: await yt.getQuota(),
    spend: await ai.getSpend(),
    log,
  };
  await db.kvSet('lastSync', summary);
  onProgress({ phase: 'done' });
  return summary;
}
