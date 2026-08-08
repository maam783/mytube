// IndexedDB-Schicht. Alles liegt lokal auf dem iPad — es gibt keinen Server.

const DB_NAME = 'privatetube';
const DB_VERSION = 1;

let _db = null;

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('videos')) {
        const s = db.createObjectStore('videos', { keyPath: 'id' });
        s.createIndex('byChannel', 'channelId');
        s.createIndex('byPublished', 'publishedAt');
      }
      if (!db.objectStoreNames.contains('channels')) {
        db.createObjectStore('channels', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('feedback')) {
        const s = db.createObjectStore('feedback', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byVideo', 'videoId');
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'k' });
      }
      void e;
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function put(store, value) {
  return wrap((await tx(store, 'readwrite')).put(value));
}

export async function putMany(store, values) {
  if (!values.length) return;
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const v of values) os.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function get(store, key) {
  return wrap((await tx(store, 'readonly')).get(key));
}

export async function getAll(store) {
  return wrap((await tx(store, 'readonly')).getAll());
}

export async function del(store, key) {
  return wrap((await tx(store, 'readwrite')).delete(key));
}

export async function clear(store) {
  return wrap((await tx(store, 'readwrite')).clear());
}

export async function count(store) {
  return wrap((await tx(store, 'readonly')).count());
}

/** Nur die IDs eines Stores — billiger als getAll für Dedupe-Checks. */
export async function allKeys(store) {
  return wrap((await tx(store, 'readonly')).getAllKeys());
}

// --- Key/Value-Helfer für Einstellungen, Manifest, Sync-Zustand ---

export async function kvGet(key, fallback = null) {
  const row = await get('kv', key);
  return row === undefined || row === null ? fallback : row.v;
}

export async function kvSet(key, value) {
  return put('kv', { k: key, v: value });
}

// --- Backup ---

export async function exportAll() {
  const [videos, channels, feedback, kv] = await Promise.all([
    getAll('videos'), getAll('channels'), getAll('feedback'), getAll('kv'),
  ]);
  return {
    format: 'privatetube-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    videos, channels, feedback, kv,
  };
}

export async function importAll(data, { replace = false } = {}) {
  if (!data || data.format !== 'privatetube-backup') {
    throw new Error('Keine gültige PrivateTube-Sicherung.');
  }
  if (replace) {
    await Promise.all([clear('videos'), clear('channels'), clear('feedback'), clear('kv')]);
  }
  await putMany('channels', data.channels || []);
  await putMany('videos', data.videos || []);
  await putMany('kv', data.kv || []);
  // Feedback hat autoIncrement-Keys; beim Zusammenführen neu vergeben.
  const fb = (data.feedback || []).map((f) => (replace ? f : { ...f, id: undefined }));
  await putMany('feedback', fb);
}
