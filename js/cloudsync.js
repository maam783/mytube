// Geräteabgleich über ein privates GitHub-Repository.
//
// Warum GitHub statt eines Sync-Servers: kein eigener Server (nichts, was im
// Urlaub ausfallen kann), kostenlos, und das Konto existiert schon. Die App
// legt genau eine Datei ab (state.json) — clientseitig verschlüsselt mit
// AES-GCM. GitHub sieht nur Zufallsbytes; deshalb dürfen auch die API-Keys
// mitwandern, was den ganzen Punkt der Übung ausmacht: einmal einrichten,
// überall angemeldet.
//
// Die Zugangsdaten für den Abgleich selbst (Repo, Token, Passwort) wandern
// bewusst NICHT mit — die tippt man pro Gerät einmal ein. Alles andere schon.

import * as db from './db.js';
import * as S from './settings.js';

const API = 'https://api.github.com';
const FILE = 'state.json';

// ---------- Verschlüsselung (WebCrypto, ohne Abhängigkeiten) ----------

const te = new TextEncoder();
const td = new TextDecoder();

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150_000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function encrypt(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  return { format: 'mytube-cloud', v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

async function decrypt(payload, pass) {
  const key = await deriveKey(pass, unb64(payload.salt));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(payload.iv) }, key, unb64(payload.data));
    return JSON.parse(td.decode(plain));
  } catch {
    throw new Error('Entschlüsselung fehlgeschlagen — stimmt das Sync-Passwort?');
  }
}

// ---------- GitHub Contents API ----------

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGet(repo, token) {
  const res = await fetch(`${API}/repos/${repo}/contents/${FILE}`, { headers: ghHeaders(token) });
  if (res.status === 404) return { payload: null, sha: null };
  if (res.status === 401 || res.status === 403) {
    throw new Error('GitHub lehnt das Token ab — Berechtigung „Contents" für dieses Repo nötig.');
  }
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const body = await res.json();
  const text = atob(body.content.replace(/\n/g, ''));
  return { payload: JSON.parse(text), sha: body.sha };
}

async function ghPut(repo, token, payload, sha) {
  const res = await fetch(`${API}/repos/${repo}/contents/${FILE}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `MyTube-Abgleich ${new Date().toISOString()}`,
      content: btoa(JSON.stringify(payload)),
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.status === 409 || res.status === 422) return false; // Stand veraltet — neu ziehen
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  return true;
}

// ---------- Schnappschuss & Zusammenführung ----------

// Diese Felder bleiben pro Gerät (Henne-Ei: ohne sie gäbe es keinen Abgleich).
const LOCAL_ONLY = new Set(['syncRepo', 'syncToken', 'syncPass']);

async function deviceId() {
  let id = await db.kvGet('deviceId', null);
  if (!id) {
    id = crypto.randomUUID();
    await db.kvSet('deviceId', id);
  }
  return id;
}

async function buildSnapshot() {
  const [settings, manifest, channels, blockedChannels, videos, feedback] = await Promise.all([
    S.load(), S.getManifest(), db.getAll('channels'),
    db.kvGet('blockedChannels', []), db.getAll('videos'), db.getAll('feedback'),
  ]);

  const cleanSettings = {};
  for (const [k, v] of Object.entries(settings)) {
    if (!LOCAL_ONLY.has(k)) cleanSettings[k] = v;
  }

  // Pro Video nur der Zustand, nicht die Metadaten — die holt jedes Gerät
  // selbst über die YouTube-API. Ausnahme: gemerkte Videos wandern komplett,
  // damit die Merkliste auch auf einem Gerät erscheint, das das Video nie
  // selbst geladen hat.
  const videoState = {};
  for (const v of videos) {
    const s = {};
    if (v.watched) s.w = 1;
    if (v.dismissed) s.d = 1;
    if (v.saved) { s.s = 1; s.sa = v.savedAt || null; }
    if (v.rating) s.r = v.rating;
    if (Object.keys(s).length) videoState[v.id] = s;
  }

  return {
    updatedAt: new Date().toISOString(),
    deviceId: await deviceId(),
    settings: cleanSettings,
    manifest,
    channels,
    blockedChannels,
    videoState,
    savedVideos: videos.filter((v) => v.saved),
    feedback,
  };
}

/**
 * Zusammenführen. Grundregel: Wer zuletzt geschrieben hat, gewinnt bei
 * Skalaren (Einstellungen, Manifest, Kanalliste). Beim Video-Zustand gilt
 * ODER — einmal irgendwo gesehen heißt überall gesehen; das ist der Fall,
 * um den es beim Abgleich wirklich geht.
 */
function merge(local, remote, remoteIsNewer) {
  if (!remote) return local;
  const win = remoteIsNewer ? remote : local;
  const out = {
    ...local,
    settings: { ...win.settings },
    manifest: win.manifest,
    channels: win.channels,
    blockedChannels: win.blockedChannels,
  };

  // API-Keys: ein leerer Wert überschreibt nie einen vorhandenen — sonst
  // löscht ein frisch eingerichtetes Gerät die Keys der anderen.
  for (const k of ['ytKey', 'anthropicKey']) {
    out.settings[k] = win.settings?.[k] || local.settings?.[k] || remote.settings?.[k] || '';
  }

  out.videoState = { ...local.videoState };
  for (const [id, r] of Object.entries(remote.videoState || {})) {
    const l = out.videoState[id] || {};
    out.videoState[id] = {
      ...(remoteIsNewer ? { ...l, ...r } : { ...r, ...l }),
      ...(l.w || r.w ? { w: 1 } : {}),
      ...(l.d || r.d ? { d: 1 } : {}),
    };
  }

  // Merkliste vereinigen; bei gleicher ID gewinnt der jüngere Stand.
  const savedListe = remoteIsNewer
    ? [...(local.savedVideos || []), ...(remote.savedVideos || [])]
    : [...(remote.savedVideos || []), ...(local.savedVideos || [])];
  const savedById = new Map(savedListe.map((v) => [v.id, v]));
  out.savedVideos = [...savedById.values()];

  const fbById = new Map();
  for (const f of [...(remote.feedback || []), ...(local.feedback || [])]) {
    const key = f.id ?? `${f.type}:${f.videoId}:${f.createdAt}`;
    const prev = fbById.get(key);
    if (!prev || (f.createdAt || '') > (prev.createdAt || '')) fbById.set(key, f);
  }
  out.feedback = [...fbById.values()];

  out.updatedAt = new Date().toISOString();
  return out;
}

async function applySnapshot(snap) {
  await S.save(snap.settings);
  await S.setManifest(snap.manifest);
  await db.kvSet('blockedChannels', snap.blockedChannels || []);
  await db.putMany('channels', snap.channels || []);

  const vorhandene = new Map((await db.getAll('videos')).map((v) => [v.id, v]));
  const updates = [];
  for (const [id, s] of Object.entries(snap.videoState || {})) {
    const v = vorhandene.get(id);
    if (!v) continue;
    updates.push({
      ...v,
      watched: Boolean(s.w) || v.watched,
      dismissed: Boolean(s.d) || v.dismissed,
      saved: Boolean(s.s),
      savedAt: s.s ? (s.sa || v.savedAt) : null,
      rating: s.r ?? (s.s || s.w || s.d ? v.rating : v.rating),
    });
  }
  for (const sv of snap.savedVideos || []) {
    if (!vorhandene.has(sv.id)) updates.push(sv);
  }
  await db.putMany('videos', updates);
  await db.putMany('feedback', snap.feedback || []);
}

// ---------- Öffentliche API ----------

export function isConfigured(settings) {
  return Boolean(settings.syncRepo && settings.syncToken && settings.syncPass);
}

/**
 * Ein vollständiger Abgleich: ziehen, zusammenführen, anwenden, hochschieben.
 * Läuft bei App-Start, nach „Aktualisieren" und auf Knopfdruck. Konflikt
 * (jemand hat zwischendurch gepusht) wird einmal durch erneutes Ziehen gelöst.
 */
export async function syncNow() {
  const settings = await S.load();
  if (!isConfigured(settings)) throw new Error('Geräteabgleich ist nicht eingerichtet.');
  const { syncRepo, syncToken, syncPass } = settings;

  for (let versuch = 0; versuch < 2; versuch++) {
    const { payload, sha } = await ghGet(syncRepo, syncToken);
    const remote = payload ? await decrypt(payload, syncPass) : null;

    const last = await db.kvGet('cloudLastSync', null);
    const remoteIsNewer = Boolean(remote
      && (!last || (remote.updatedAt || '') > (last.remoteAt || ''))
      && remote.deviceId !== await deviceId());

    const local = await buildSnapshot();
    const merged = merge(local, remote, remoteIsNewer);
    await applySnapshot(merged);

    const ok = await ghPut(syncRepo, syncToken, await encrypt(merged, syncPass), sha);
    if (ok) {
      await db.kvSet('cloudLastSync', { at: new Date().toISOString(), remoteAt: merged.updatedAt });
      return { remoteWarNeuer: remoteIsNewer, hatteRemote: Boolean(remote) };
    }
    // sha veraltet: einmal komplett neu — ziehen, mergen, schieben.
  }
  throw new Error('Abgleich-Konflikt — bitte gleich noch einmal versuchen.');
}

export async function lastSyncInfo() {
  return db.kvGet('cloudLastSync', null);
}
