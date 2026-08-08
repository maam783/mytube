// YouTube Data API v3 — direkt vom iPad, nur mit API-Key.
//
// Bewusst NICHT dabei: OAuth, Cookies, Stream-Extraktion, Scraping.
// Deshalb ist dein YouTube-Account an keiner Stelle beteiligt und kann
// durch diese App auch nicht gesperrt werden. Nur der API-Key wird benutzt,
// und der hängt am Google-Cloud-Projekt, nicht am Konto.

import * as db from './db.js';

const API = 'https://www.googleapis.com/youtube/v3';

export const QUOTA_COST = {
  playlistItems: 1,
  videos: 1,
  channels: 1,
  search: 100,
};

export class YouTubeError extends Error {
  constructor(message, { status = 0, reason = '', retryable = false } = {}) {
    super(message);
    this.name = 'YouTubeError';
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

// --- Quota-Buchhaltung (rein lokal, zur Anzeige) ---

function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function getQuota() {
  const q = await db.kvGet('quota', null);
  if (!q || q.day !== today()) return { day: today(), units: 0, searchCalls: 0 };
  return q;
}

async function chargeQuota(units, isSearch = false) {
  const q = await getQuota();
  q.units += units;
  if (isSearch) q.searchCalls += 1;
  await db.kvSet('quota', q);
}

// --- Low-Level-Request mit Backoff ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(endpoint, params, key, { cost = 1, retries = 3 } = {}) {
  if (!key) throw new YouTubeError('Kein YouTube-API-Key hinterlegt.', { reason: 'noKey' });

  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  url.searchParams.set('key', key);

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.random() * 300);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      // Netzwerkfehler — im Hotel-WLAN der Normalfall. Weiter versuchen.
      lastErr = new YouTubeError(`Netzwerkfehler: ${e.message}`, { retryable: true });
      continue;
    }

    if (res.ok) {
      await chargeQuota(cost, endpoint === 'search');
      return res.json();
    }

    let body = null;
    try { body = await res.json(); } catch { /* leere Fehlerantwort */ }
    const reason = body?.error?.errors?.[0]?.reason || '';
    const message = body?.error?.message || res.statusText;

    // Quota-Fehler zählen trotzdem als verbraucht.
    if (res.status === 403 && /quota/i.test(reason)) {
      await chargeQuota(cost, endpoint === 'search');
      throw new YouTubeError(`Tages-Quota erschöpft: ${message}`, { status: 403, reason });
    }
    if (res.status === 404 || (res.status === 400 && reason === 'playlistNotFound')) {
      throw new YouTubeError(message, { status: res.status, reason: reason || 'notFound' });
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new YouTubeError(message, { status: res.status, reason, retryable: true });
      continue;
    }
    throw new YouTubeError(message, { status: res.status, reason });
  }
  throw lastErr || new YouTubeError('Unbekannter Fehler.');
}

// --- Playlist-IDs aus der Kanal-ID ableiten ---
// UC… -> UU… (alle Uploads), UULF… (nur Langform), UUSH… (nur Shorts)
// UULF/UUSH sind undokumentiert. Wenn sie verschwinden, greift der Fallback
// in fetchNewVideoIds() und wird sichtbar geloggt.

export const uploadsPlaylist = (channelId) => 'UU' + channelId.slice(2);
export const longformPlaylist = (channelId) => 'UULF' + channelId.slice(2);
export const shortsPlaylist = (channelId) => 'UUSH' + channelId.slice(2);

// --- Kanäle auflösen ---

const RE_CHANNEL_ID = /^UC[\w-]{22}$/;

/** Nimmt Kanal-ID, @handle oder eine YouTube-URL und macht eine Kanal-ID daraus. */
export async function resolveChannel(input, key) {
  const raw = String(input).trim();
  if (!raw) return null;

  if (RE_CHANNEL_ID.test(raw)) return fetchChannel(raw, key);

  let handle = null;
  const urlMatch = raw.match(/youtube\.com\/(channel\/(UC[\w-]{22})|@([\w.\-]+)|(?:c|user)\/([\w.\-]+))/i);
  if (urlMatch) {
    if (urlMatch[2]) return fetchChannel(urlMatch[2], key);
    if (urlMatch[3]) handle = urlMatch[3];
    else if (urlMatch[4]) return fetchChannelByUsername(urlMatch[4], key);
  } else if (raw.startsWith('@')) {
    handle = raw.slice(1);
  } else {
    handle = raw;
  }

  const data = await request('channels', {
    part: 'snippet,contentDetails',
    forHandle: '@' + handle,
  }, key, { cost: QUOTA_COST.channels });

  const item = data.items?.[0];
  if (!item) throw new YouTubeError(`Kanal nicht gefunden: ${raw}`, { reason: 'notFound' });
  return toChannel(item);
}

async function fetchChannel(id, key) {
  const data = await request('channels', { part: 'snippet,contentDetails', id }, key,
    { cost: QUOTA_COST.channels });
  const item = data.items?.[0];
  if (!item) throw new YouTubeError(`Kanal nicht gefunden: ${id}`, { reason: 'notFound' });
  return toChannel(item);
}

async function fetchChannelByUsername(username, key) {
  const data = await request('channels', { part: 'snippet,contentDetails', forUsername: username }, key,
    { cost: QUOTA_COST.channels });
  const item = data.items?.[0];
  if (!item) throw new YouTubeError(`Kanal nicht gefunden: ${username}`, { reason: 'notFound' });
  return toChannel(item);
}

/** Mehrere Kanal-IDs auf einmal (50er-Batches) — für den CSV-Import. */
export async function fetchChannels(ids, key) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await request('channels', {
      part: 'snippet,contentDetails',
      id: ids.slice(i, i + 50),
      maxResults: 50,
    }, key, { cost: QUOTA_COST.channels });
    for (const item of data.items || []) out.push(toChannel(item));
  }
  return out;
}

function toChannel(item) {
  return {
    id: item.id,
    title: item.snippet?.title || item.id,
    thumb: item.snippet?.thumbnails?.default?.url || '',
    active: true,
    weight: 1.0,
    addedAt: new Date().toISOString(),
    lastPolledAt: null,
    lastStatus: null,
    playlistMode: null, // 'longform' | 'uploads' — wird beim ersten Poll gesetzt
  };
}

// --- Neue Videos eines Kanals holen ---

async function listPlaylist(playlistId, key, maxResults) {
  const data = await request('playlistItems', {
    part: 'contentDetails',
    playlistId,
    maxResults,
  }, key, { cost: QUOTA_COST.playlistItems });
  return (data.items || [])
    .map((i) => i.contentDetails?.videoId)
    .filter(Boolean);
}

/**
 * Liefert die IDs neuer Videos eines Kanals.
 *
 * Primärweg: UULF-Playlist (Uploads ohne Shorts). Fällt die weg, wird auf
 * UU + UUSH-Ausschlussliste umgestellt — und das wird als Degradation gemeldet,
 * nicht still geschluckt.
 */
export async function fetchNewVideoIds(channel, key, { known, itemsPerChannel = 15 } = {}) {
  const notes = [];
  let mode = channel.playlistMode;
  let ids = [];
  let shortIds = new Set();

  if (mode !== 'uploads') {
    try {
      ids = await listPlaylist(longformPlaylist(channel.id), key, itemsPerChannel);
      mode = 'longform';
    } catch (e) {
      if (e.reason === 'playlistNotFound' || e.status === 404) {
        notes.push(`UULF-Playlist fehlt für „${channel.title}" — Fallback auf UU + Shorts-Ausschluss.`);
        mode = 'uploads';
      } else {
        throw e;
      }
    }
  }

  if (mode === 'uploads') {
    ids = await listPlaylist(uploadsPlaylist(channel.id), key, itemsPerChannel);
    try {
      const shorts = await listPlaylist(shortsPlaylist(channel.id), key, itemsPerChannel);
      shortIds = new Set(shorts);
    } catch (e) {
      if (e.reason !== 'playlistNotFound' && e.status !== 404) throw e;
      notes.push(`Auch UUSH fehlt für „${channel.title}" — Shorts nur noch per Dauer-Heuristik.`);
    }
  }

  // Neueste zuerst: beim ersten bekannten Video abbrechen spart nichts an
  // Quota (der Call ist schon bezahlt), aber es hält die Metadaten-Batches klein.
  const fresh = [];
  for (const id of ids) {
    if (known.has(id)) break;
    if (shortIds.has(id)) continue;
    fresh.push(id);
  }

  return { ids: fresh, mode, knownShorts: shortIds, notes };
}

// --- Metadaten ---

export async function fetchVideoDetails(ids, key) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await request('videos', {
      // part=status kostet nichts extra und entscheidet über die Darstellung
      part: 'snippet,contentDetails,status,statistics,liveStreamingDetails',
      id: ids.slice(i, i + 50),
      maxResults: 50,
    }, key, { cost: QUOTA_COST.videos });
    for (const item of data.items || []) out.push(toVideo(item));
  }
  return out;
}

/** ISO-8601-Dauer -> Sekunden. `P0D` (Livestream/Premiere) -> 0. */
export function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (+d || 0) * 86400 + (+h || 0) * 3600 + (+min || 0) * 60 + Math.round(+s || 0);
}

function toVideo(item) {
  const sn = item.snippet || {};
  const cd = item.contentDetails || {};
  const st = item.status || {};
  const live = item.liveStreamingDetails || null;
  const durationSec = parseDuration(cd.duration);

  return {
    id: item.id,
    channelId: sn.channelId,
    channelTitle: sn.channelTitle || '',
    title: sn.title || '',
    description: (sn.description || '').slice(0, 800),
    publishedAt: sn.publishedAt || new Date().toISOString(),
    durationSec,
    liveStatus: sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none'
      ? sn.liveBroadcastContent
      : (live ? 'was_live' : null),
    scheduledStartAt: live?.scheduledStartTime || null,
    lang: sn.defaultAudioLanguage || sn.defaultLanguage || '',
    tags: (sn.tags || []).slice(0, 12),
    // status.embeddable sagt vorab, ob der Player überhaupt darf
    embeddable: st.embeddable !== false,
    madeForKids: Boolean(st.madeForKids),
    ageRestricted: cd.contentRating?.ytRating === 'ytAgeRestricted',
    regionBlocked: cd.regionRestriction?.blocked || null,
    regionAllowed: cd.regionRestriction?.allowed || null,
    viewCount: Number(item.statistics?.viewCount || 0),
    thumb: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
    // zur Laufzeit gelernt
    embedFailed: false,
    watched: false,
    dismissed: false,
    ingestedAt: new Date().toISOString(),
    score: null,
    reason: null,
    scoreTags: null,
    scoredAt: null,
  };
}
