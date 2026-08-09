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
 * @param {AbortSignal} [signal] Bricht den Lauf ab — vor allem die Bewertung,
 *   die je nach Anzahl der Videos Minuten dauern kann.
 */
export async function run(onProgress = () => {}, signal = undefined) {
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

  // --- 2b. Entdecken: Vorschläge außerhalb der Abos ---
  let discovered = 0;
  if (settings.discoveryEnabled && settings.discoveryQueries?.length) {
    const heute = new Date().toISOString().slice(0, 10);
    let zustand = await db.kvGet('discovery', null);
    if (!zustand || zustand.day !== heute) {
      zustand = { day: heute, searches: 0, cursor: zustand?.cursor || 0 };
    }

    const queries = settings.discoveryQueries;
    const anzahl = Math.min(
      Math.max(0, settings.discoverySearchesPerDay - zustand.searches),
      queries.length,
    );

    if (anzahl > 0) {
      onProgress({ phase: 'discovery', done: 0, total: anzahl });
      const publishedAfter = new Date(Date.now() - settings.maxAgeDays * DAY_MS).toISOString();
      const sprache = settings.languages?.[0] || 'de';
      const blockiert = new Set(await db.kvGet('blockedChannels', []));
      const bekannt = new Set(await db.allKeys('videos'));
      const kandidaten = new Set();

      for (let i = 0; i < anzahl; i++) {
        if (signal?.aborted) break;
        // Der Cursor wandert, damit über die Tage alle Themen drankommen und
        // nicht immer nur die ersten sechs.
        const q = queries[(zustand.cursor + i) % queries.length];
        try {
          const ids = await yt.searchVideos(q, settings.ytKey, { publishedAfter, language: sprache });
          for (const id of ids) if (!bekannt.has(id)) kandidaten.add(id);
        } catch (e) {
          note(`Suche „${q}": ${e.message}`, 'error');
          if (/quota/i.test(e.reason || '')) break;
        }
        zustand.searches += 1;
        onProgress({ phase: 'discovery', done: i + 1, total: anzahl });
      }
      zustand.cursor = (zustand.cursor + anzahl) % queries.length;
      await db.kvSet('discovery', zustand);

      if (kandidaten.size) {
        const details = await yt.fetchVideoDetails([...kandidaten], settings.ytKey);
        const behalten = [];
        const abonniert = new Set(await db.allKeys('channels'));
        for (const v of details) {
          if (blockiert.has(v.channelId)) continue;
          // Kanäle, die du ohnehin abonniert hast, brauchen keinen
          // „Entdeckt"-Umweg — ihre Uploads kommen über den normalen Weg.
          if (abonniert.has(v.channelId)) continue;
          if (new Date(v.publishedAt).getTime() < cutoff) continue;
          // Die Suche liefert massenweise Shorts und es gibt hier keine
          // Playlist, die sie schon aussortiert hätte — also über die Dauer.
          v.isShort = isShort(v, settings, { useDuration: true });
          if (v.isShort) continue;
          v.source = 'discovery';
          behalten.push(v);
        }
        await db.putMany('videos', behalten);
        discovered = behalten.length;
      }
      note(`Entdecken: ${anzahl} Suchen, ${discovered} Videos zur Auswahl.`);
    }
  }

  // --- 3. Aufräumen ---
  const purgeBefore = Date.now() - settings.keepDays * DAY_MS;
  const alleKanalIds = new Set(await db.allKeys('channels'));
  const all = await db.getAll('videos');

  // Gemerkte Videos überleben jedes Aufräumen — die Merkliste ist genau für
  // „später ansehen" da, und später kann nach keepDays liegen.
  const stale = all.filter((v) => !v.saved && new Date(v.publishedAt).getTime() < purgeBefore);
  for (const v of stale) await db.del('videos', v.id);
  if (stale.length) note(`${stale.length} alte Videos aus der Datenbank entfernt.`);

  // Videos entfernter Kanäle. Der Feed blendet sie ohnehin aus, aber liegen
  // lassen würde die Datenbank unnötig aufblähen.
  // Entdeckte Videos ausnehmen — deren Kanäle sind absichtlich nicht abonniert.
  const waisen = all.filter((v) => !v.saved && v.source !== 'discovery' && !alleKanalIds.has(v.channelId));
  for (const v of waisen) await db.del('videos', v.id);
  if (waisen.length) note(`${waisen.length} Videos entfernter Kanäle aufgeräumt.`);

  // Ab hier ist der Feed vollständig. Die Bewertung darunter kann Minuten
  // dauern — die Videos sollen aber jetzt schon sichtbar sein.
  onProgress({ phase: 'ingested' });

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

    const batches = [];
    for (let i = 0; i < pending.length; i += settings.batchSize) {
      batches.push(pending.slice(i, i + settings.batchSize));
    }

    let erledigt = 0;
    let fehler = 0;
    let stopp = false;
    onProgress({ phase: 'scoring', done: 0, total: pending.length });

    // Drei Anfragen gleichzeitig. Nacheinander dauerte das bei ~190 Videos gut
    // fünf Minuten — jede Anfrage muss 25 Begründungen schreiben.
    await mapLimit(batches, 3, async (batch) => {
      if (stopp || signal?.aborted) return;
      try {
        const { results } = await ai.scoreBatch(batch, {
          apiKey: settings.anthropicKey,
          model: settings.model,
          manifest,
          examples,
          budgetUsd: settings.dailyBudgetUsd,
          signal,
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
      } catch (e) {
        if (e instanceof ai.BudgetExceeded) {
          if (!stopp) note(`${e.message} Bewertung pausiert, der Feed läuft chronologisch weiter.`, 'warn');
          stopp = true;
        } else if (signal?.aborted) {
          stopp = true;
        } else {
          // Ein Aussetzer ist kein Grund aufzuhören; ein dauerhafter schon.
          note(`Bewertung fehlgeschlagen: ${e.message}`, ++fehler >= 2 ? 'error' : 'warn');
          if (fehler >= 2) stopp = true;
        }
      } finally {
        erledigt += batch.length;
        onProgress({ phase: 'scoring', done: Math.min(erledigt, pending.length), total: pending.length });
      }
    });

    if (scored) note(`${scored} Videos bewertet.`);
    const offen = pending.length - scored;
    if (offen > 0 && !signal?.aborted) {
      note(`${offen} Videos noch ohne Bewertung — kommen beim nächsten Lauf dran.`, 'warn');
    }
  }

  const summary = {
    at: new Date().toISOString(),
    added, scored, discovered, droppedOld, droppedShort,
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
