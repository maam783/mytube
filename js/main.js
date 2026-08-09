import * as db from './db.js';
import * as yt from './youtube.js';
import * as ai from './ai.js';
import * as S from './settings.js';
import * as sync from './sync.js';
import * as cloud from './cloudsync.js';
import { rank, stage0, ageDays } from './rank.js';

// ---------- kleine Helfer ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(message, level = 'info', ms = 4200) {
  const host = document.getElementById('toast-host');
  const node = el('div', { class: `toast ${level}` }, message);
  host.append(node);
  setTimeout(() => node.remove(), ms);
}

function fmtDuration(sec) {
  if (!sec) return 'live';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtAge(iso) {
  const days = ageDays({ publishedAt: iso });
  if (days < 1 / 24) return 'gerade eben';
  if (days < 1) return `vor ${Math.round(days * 24)} Std.`;
  if (days < 2) return 'gestern';
  return `vor ${Math.round(days)} Tagen`;
}

function fmtCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.0', '')} Mio.`;
  if (n >= 1000) return `${Math.round(n / 1000)} Tsd.`;
  return String(n || 0);
}

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// ---------- Zustand ----------

const view = document.getElementById('view');
let syncing = false;

// Solange die Einstellungen offen sind, hängt hier eine Funktion, die noch nicht
// gespeicherte Eingaben übernimmt. Sonst liest „Aktualisieren" die alten Werte
// und verlangt einen Key, den du gerade eingetippt hast.
let flushPendingSettings = null;
let syncAbort = null;

async function loadContext() {
  const [settings, videos, channels, blockedList] = await Promise.all([
    S.load(), db.getAll('videos'), db.getAll('channels'), db.kvGet('blockedChannels', []),
  ]);
  const channelsById = new Map(channels.map((c) => [c.id, c]));
  return { settings, videos, channels, channelsById, blocked: new Set(blockedList) };
}

async function blockChannel(channelId) {
  const liste = await db.kvGet('blockedChannels', []);
  if (!liste.includes(channelId)) await db.kvSet('blockedChannels', [...liste, channelId]);
}

async function unblockChannel(channelId) {
  const liste = await db.kvGet('blockedChannels', []);
  if (liste.includes(channelId)) {
    await db.kvSet('blockedChannels', liste.filter((id) => id !== channelId));
  }
}

/**
 * Feedback mit deterministischer ID `typ:videoId`: Ein zweiter Daumen auf
 * dasselbe Video überschreibt die alte Wertung, statt sie zu duplizieren —
 * und macht sie per Löschen der ID sauber zurücknehmbar.
 */
async function recordFeedback(videoId, type, value) {
  await db.put('feedback', {
    id: `${type}:${videoId}`,
    videoId, type, value, createdAt: new Date().toISOString(),
  });
}

async function clearFeedback(videoId, type) {
  await db.del('feedback', `${type}:${videoId}`);
}

async function updateVideo(id, patch) {
  const v = await db.get('videos', id);
  if (!v) return null;
  const next = { ...v, ...patch };
  await db.put('videos', next);
  return next;
}

// ---------- Sync ----------

async function runSync() {
  // Zweiter Tipp auf den laufenden Knopf bricht ab. Die Bewertung kann Minuten
  // dauern; ohne Ausweg wäre man ihr ausgeliefert.
  if (syncing) {
    syncAbort?.abort();
    toast('Wird abgebrochen…');
    return;
  }

  // Erst übernehmen, was in einem offenen Formular steht — sonst startet der
  // Lauf mit veralteten Werten.
  if (flushPendingSettings) { try { await flushPendingSettings(); } catch { /* egal */ } }

  const settings = await S.load();
  if (!settings.ytKey) {
    location.hash = '#/settings';
    toast('Es ist noch kein YouTube-API-Key hinterlegt.', 'warn');
    return;
  }

  syncing = true;
  syncAbort = new AbortController();
  const btn = document.getElementById('sync-btn');
  const bar = document.getElementById('progress');
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  btn.textContent = 'Abbrechen';
  btn.classList.add('busy');
  bar.hidden = false;
  fill.style.width = '0%';
  text.textContent = 'Start…';

  const labels = { channels: 'Kanäle', details: 'Metadaten', scoring: 'Bewertung' };

  try {
    const summary = await sync.run((ev) => {
      if (ev.phase === 'log') {
        if (ev.level === 'error') toast(ev.message, 'error');
        return;
      }
      // Videos sind vollständig — anzeigen, ohne auf die Bewertung zu warten.
      // Aber: Wer gerade mitten im Feed liest, wird nicht an den Anfang
      // gerissen — der bekommt ein Angebot statt eines Zwangs-Renders.
      if (ev.phase === 'ingested') {
        const onFeed = (location.hash || '#/') === '#/';
        if (!onFeed || window.scrollY < 80) { render(); return; }
        if (!document.getElementById('new-pill')) {
          const pill = el('button', {
            id: 'new-pill', class: 'new-pill',
            onclick: () => { pill.remove(); window.scrollTo(0, 0); render(); },
          }, 'Neue Videos ↑');
          document.body.append(pill);
          setTimeout(() => pill.remove(), 30000);
        }
        return;
      }
      if (ev.phase === 'done') return;
      const pct = ev.total ? Math.round((ev.done / ev.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      text.textContent = ev.phase === 'scoring'
        ? `Bewertung ${ev.done}/${ev.total} — der Feed ist schon nutzbar`
        : `${labels[ev.phase] || ev.phase} ${ev.done}/${ev.total}`;
    }, syncAbort.signal);

    if (syncAbort.signal.aborted) {
      toast(`Abgebrochen. ${summary.added} Videos geladen`
        + (summary.scored ? `, ${summary.scored} bewertet` : '') + '.', 'warn');
    } else {
      const errs = summary.log.filter((l) => l.level === 'error').length;
      toast(`${summary.added} neue Videos`
        + (summary.scored ? `, ${summary.scored} bewertet` : '')
        + (errs ? ` · ${errs} Fehler (siehe Status)` : ''),
        errs ? 'warn' : 'info');
    }
  } catch (e) {
    if (!syncAbort.signal.aborted) toast(e.message, 'error', 8000);
  } finally {
    syncing = false;
    syncAbort = null;
    btn.textContent = 'Aktualisieren';
    btn.classList.remove('busy');
    bar.hidden = true;
    render();
    // Frischen Stand zu den anderen Geräten schieben — im Hintergrund,
    // ein Fehlschlag (Hotel-WLAN) bricht nichts.
    S.load().then((s) => {
      if (cloud.isConfigured(s)) cloud.syncNow().catch(() => { /* nächstes Mal */ });
    });
  }
}

// ---------- Feed: „Die Tagesausgabe" ----------
//
// Der Feed ist als privates Tagesblatt gebaut: Masthead mit Datum und
// Live-Zähler, Tages-Sektionen, das Top-Video als Hero, danach Karten und
// ruhige Zeilen direkt auf dem Papier. Rang zeigt sich durch Form, nicht
// durch ein Score-Badge. Der reason-Satz spricht in kursiver Serife — die
// wiedererkennbare Stimme der Redaktion.

/** Dauer als Text für Bylines/Overlines ("42 Min.", "1 Std. 15 Min."). */
function fmtMins(sec) {
  if (!sec) return 'Live';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h) return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
  return `${Math.max(1, m)} Min.`;
}

function dayBucket(iso) {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - 6);
  if (d >= today) return 'Heute';
  if (d >= yesterday) return 'Gestern';
  if (d >= week) return 'Diese Woche';
  return 'Älter';
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- Live-Zähler im Masthead ---

let feedCountEl = null;
let feedCount = 0;

function setFeedCount(n) {
  feedCount = Math.max(0, n);
  if (feedCountEl?.isConnected) feedCountEl.textContent = String(feedCount);
}
const bumpFeedCount = (delta) => setFeedCount(feedCount + delta);

// --- Undo-Leiste: EINE fixe Leiste ersetzt confirm() und Toast-Stapel ---

let undoState = null;

function dismissUndo() {
  if (!undoState) return;
  clearTimeout(undoState.timer);
  undoState.el.remove();
  undoState = null;
}

/**
 * Persistenz ist zu diesem Zeitpunkt IMMER schon geschrieben (kein Datenverlust
 * beim App-Wechsel); undoFn kehrt sie um. Eine neue Aktion ersetzt die Leiste —
 * die vorherige gilt dann endgültig.
 */
function showUndo(label, undoFn) {
  dismissUndo();
  const bar = el('div', { class: 'undobar', role: 'status' },
    el('span', { class: 'undobar-text' }, label),
    el('button', {
      class: 'btn ghost',
      onclick: async () => {
        dismissUndo();
        try { await undoFn(); } catch (e) { toast(e.message, 'error'); }
      },
    }, 'Rückgängig'),
    el('span', { class: 'undobar-line' }));
  document.body.append(bar);
  void bar.offsetHeight; // Reflow statt rAF — rAF feuert in Hintergrund-Tabs nicht
  bar.classList.add('run');
  undoState = { el: bar, timer: setTimeout(dismissUndo, 5000) };
}

// --- Entfernen mit Höhenkollaps, Wiedereinsetzen für Undo ---

function collapseRemove(node, done = null) {
  let fired = false;
  const finish = () => {
    if (fired) return;
    fired = true;
    node.remove();
    done?.();
  };
  if (reducedMotion()) {
    node.style.transition = 'opacity 120ms ease';
    node.style.opacity = '0';
    setTimeout(finish, 130);
    return;
  }
  node.style.height = `${node.offsetHeight}px`;
  node.style.overflow = 'hidden';
  void node.offsetHeight; // Reflow, damit die Start-Höhe steht
  node.style.transition = 'all 220ms cubic-bezier(.2,0,0,1)';
  node.style.height = '0';
  node.style.opacity = '0';
  node.style.paddingTop = '0';
  node.style.paddingBottom = '0';
  node.style.marginTop = '0';
  node.style.marginBottom = '0';
  node.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 320);
}

/** Merkt sich die DOM-Position eines Elements, um es beim Undo zurückzuhängen. */
function rememberSlot(node) {
  return { node, parent: node.parentElement, next: node.nextElementSibling };
}

function restoreSlot(slot) {
  if (!slot.parent?.isConnected) { render(); return; }
  slot.node.removeAttribute('style');
  if (slot.next?.isConnected) slot.parent.insertBefore(slot.node, slot.next);
  else slot.parent.append(slot.node);
}

// --- Das ···-Menü (Popover auf dem iPad, Bottom-Sheet auf dem iPhone) ---

function openMenu(anchor, entries) {
  const narrow = matchMedia('(max-width: 719px)').matches;
  const menu = el('div', { class: narrow ? 'sheet' : 'menu', role: 'menu' });

  let close;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.sep) { menu.append(el('div', { class: 'menu-sep' })); continue; }
    if (entry.inert) { menu.append(el('div', { class: 'menu-inert' }, entry.label)); continue; }
    menu.append(el('button', {
      class: `menu-item${entry.danger ? ' danger' : ''}`,
      role: 'menuitem',
      onclick: async () => { close(); try { await entry.onTap(); } catch (e) { toast(e.message, 'error'); } },
    },
      el('span', { class: 'menu-ico', 'aria-hidden': 'true' }, entry.icon || ''),
      el('span', { class: 'menu-label' }, entry.label),
      entry.checked ? el('span', { class: 'menu-check' }, '✓') : null));
  }

  let scrim = null;
  const onOutside = (e) => { if (!menu.contains(e.target)) close(); };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  close = () => {
    menu.remove();
    scrim?.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onEsc);
    anchor?.focus?.();
  };

  if (narrow) {
    scrim = el('div', { class: 'scrim', onclick: () => close() });
    document.body.append(scrim, menu);
    // Kein rAF: das feuert in Hintergrund-Tabs nicht. Reflow erzwingen, damit
    // der Startzustand steht, dann die Klasse — die Transition läuft trotzdem.
    void menu.offsetHeight;
    scrim.classList.add('open');
    menu.classList.add('open');
  } else {
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.right - menu.offsetWidth), innerWidth - menu.offsetWidth - 8);
    let y = r.bottom + 6;
    if (y + menu.offsetHeight > innerHeight - 8) y = r.top - menu.offsetHeight - 6;
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
  }
  // Erst im nächsten Tick lauschen, sonst schliesst der öffnende Tipp sofort.
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onEsc);
  }, 0);
  return close;
}

/** Pseudo-Anker für „Menü an der Fingerposition" (Long-Press). */
const pointAnchor = (x, y) => ({
  getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }),
  focus: () => {},
});

// --- Rechts-Wisch „Gesehen" (nur Listenzeilen) ---

const SWIPE = { COMMIT: 96, SLOP: 8, AXIS: 1.2, DAMP: 0.4, EDGE: 28, FLICK: 0.5, FLICK_MIN: 32 };

function attachSwipe(wrap, row, { onCommit, onLongPress }) {
  let active = false; // nur zwischen pointerdown und pointerup verfolgen —
  // sonst „wischt" die Maus schon beim Drüberfahren ohne Klick
  let axis = null;
  let startX = 0; let startY = 0; let dx = 0;
  let lastX = 0; let lastT = 0; let vel = 0;
  let lpTimer = null;
  let swiped = false;

  const resetVisual = () => {
    row.classList.remove('dragging');
    wrap.classList.remove('commit');
    row.style.transition = `transform 250ms cubic-bezier(.2,.9,.3,1.15)`;
    row.style.transform = '';
  };

  row.addEventListener('pointerdown', (e) => {
    // 28px Totzone am linken Rand: dort wohnt der iOS-Zurück-Wisch.
    if (!e.isPrimary || e.clientX < SWIPE.EDGE) return;
    if (e.target.closest('button, a, .btn')) return;
    // Maus: nur die Primärtaste startet eine Geste.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    active = true;
    axis = null; dx = 0; swiped = false;
    startX = e.clientX; startY = e.clientY;
    lastX = e.clientX; lastT = e.timeStamp; vel = 0;
    row.style.transition = '';
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (active && axis === null) { swiped = true; onLongPress(startX, startY); }
    }, 450);
    try { row.setPointerCapture(e.pointerId); } catch { /* egal */ }
  });

  row.addEventListener('pointermove', (e) => {
    if (!active || !e.isPrimary) return;
    // Maus ohne gedrückte Taste: keine Geste (passiert nach verpasstem pointerup).
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { active = false; return; }
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(mx) < SWIPE.SLOP && Math.abs(my) < SWIPE.SLOP) return;
      axis = Math.abs(mx) > Math.abs(my) * SWIPE.AXIS ? 'h' : 'v';
      if (axis === 'h') { clearTimeout(lpTimer); row.classList.add('dragging'); }
      else { clearTimeout(lpTimer); return; } // vertikal: der Browser scrollt
    }
    if (axis !== 'h') return;
    dx = Math.max(0, mx); // nur nach rechts; links bleibt dem System
    const shifted = dx <= SWIPE.COMMIT ? dx : SWIPE.COMMIT + (dx - SWIPE.COMMIT) * SWIPE.DAMP;
    row.style.transform = `translateX(${shifted}px)`;
    wrap.classList.toggle('commit', dx >= SWIPE.COMMIT);
    const dt = e.timeStamp - lastT;
    if (dt > 0) vel = (e.clientX - lastX) / dt;
    lastX = e.clientX; lastT = e.timeStamp;
  });

  const finish = (e) => {
    clearTimeout(lpTimer);
    active = false;
    if (axis !== 'h') { axis = null; return; }
    swiped = true;
    const commit = dx >= SWIPE.COMMIT || (vel > SWIPE.FLICK && dx > SWIPE.FLICK_MIN);
    if (commit && !reducedMotion()) {
      row.style.transition = 'transform 200ms cubic-bezier(.2,.7,.3,1)';
      row.style.transform = 'translateX(100vw)';
      const go = () => onCommit();
      row.addEventListener('transitionend', go, { once: true });
      setTimeout(go, 260);
    } else if (commit) {
      onCommit();
    } else {
      resetVisual();
    }
    axis = null;
    void e;
  };
  row.addEventListener('pointerup', finish);
  row.addEventListener('pointercancel', (e) => { clearTimeout(lpTimer); active = false; if (axis === 'h') resetVisual(); axis = null; void e; });

  // Nach einer erkannten Geste den folgenden Click schlucken.
  row.addEventListener('click', (e) => {
    if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; }
  }, true);
}

// --- Bausteine ---

function openTarget(v) {
  if (!v.embeddable || v.embedFailed || v.ageRestricted) {
    // Kein Umweg über eine Detailseite, deren Player sowieso nicht darf.
    armReturnPrompt(v);
    window.open(watchUrl(v.id), '_blank', 'noopener');
    return;
  }
  location.hash = `#/v/${v.id}`;
}

function makeTappable(node, v) {
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  node.setAttribute('aria-label', `Video öffnen: ${v.title}`);
  node.addEventListener('click', (e) => {
    if (e.target.closest('button, a, .btn, .menu, .sheet')) return;
    openTarget(v);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTarget(v); }
  });
}

function thumbShell(v, { rounded = '10px' } = {}) {
  return el('div', { class: 'tshell', style: rounded ? `border-radius:${rounded}` : '' },
    v.thumb ? el('img', { src: v.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : null,
    el('span', { class: 'dur' }, fmtDuration(v.durationSec)),
    (!v.embeddable || v.embedFailed || v.ageRestricted)
      ? el('span', { class: 'ext', title: 'Öffnet in YouTube' }, '↗') : null);
}

/** Overline "KANAL · VOR 2 STD. · 42 MIN." mit farbigen Präfixen. */
function overline(v, exploration, { discovery = false } = {}) {
  const parts = [];
  if (v.liveStatus === 'live') parts.push(el('span', { class: 'ov-good' }, 'Live'));
  if (v.liveStatus === 'upcoming') parts.push(el('span', { class: 'ov-warn' }, 'Premiere'));
  if (exploration) parts.push(el('span', { class: 'ov-warn' }, 'Ausprobiert für dich'));
  if (discovery) parts.push(el('span', { class: 'ov-accent' }, 'Nicht abonniert'));
  const base = [v.channelTitle, fmtAge(v.publishedAt)];
  if (!v.liveStatus) base.push(fmtMins(v.durationSec));
  const node = el('div', { class: 'overline' });
  for (const p of parts) { node.append(p, ' · '); }
  node.append(base.join(' · '));
  return node;
}

// ---------- Der Feed selbst ----------

async function viewFeed() {
  const { settings, videos, channels, channelsById, blocked } = await loadContext();

  if (!settings.ytKey) return viewWelcome();
  if (!channels.length) {
    return el('div', { class: 'empty' },
      el('strong', {}, 'Noch keine Kanäle'),
      el('p', {}, 'Importiere deine Abo-Liste, dann kann es losgehen.'),
      el('a', { class: 'btn primary', href: '#/channels' }, 'Kanäle importieren'));
  }

  const { kept, rejected } = stage0(videos, settings, channelsById, Date.now(), blocked);
  const ordered = rank(kept, settings, channelsById);
  const rejectedTotal = [...rejected.values()].reduce((a, b) => a + b, 0);

  const wrap = el('div', { class: 'paper' });

  // --- Leerer Zustand: „Blatt weggelegt" ---
  if (!ordered.length) {
    const last = await db.kvGet('lastSync', null);
    const check = el('div', { class: 'empty done', html:
      `<svg viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">
        <path class="tick" d="M12 30 L24 42 L45 16" fill="none" stroke="var(--good)"
          stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>` });
    check.append(
      el('strong', {}, videos.length ? 'Alles gesehen' : 'Noch nichts geladen'),
      el('p', {}, last && videos.length
        ? `Stand: ${new Date(last.at).toLocaleString('de-DE', { weekday: 'long', hour: '2-digit', minute: '2-digit' })} — tippe auf „Aktualisieren" für Neues.`
        : 'Tippe oben auf „Aktualisieren".'));
    wrap.append(check);
    return wrap;
  }

  // --- Aufteilen: Hero, Entdeckungen, Karten, Zeilen ---
  const isWide = matchMedia('(min-width: 720px)').matches;
  const hero = ordered[0];
  const rest = ordered.slice(1);
  const discoveries = rest.filter((o) => o.video.source === 'discovery');
  const stream = rest.filter((o) => o.video.source !== 'discovery');

  setFeedCount(ordered.length);
  wrap.append(el('header', { class: 'masthead' },
    el('div', { class: 'overline' }, 'Dein Feed · noch ',
      (feedCountEl = el('span', {}, String(feedCount)))),
    el('h1', { class: 'masthead-date' },
      new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }))));

  // --- Gemeinsame Aktionen ---

  const markSeen = async (ids) => {
    const rows = await Promise.all(ids.map((id) => db.get('videos', id)));
    const fresh = rows.filter((v) => v && !v.watched);
    await db.putMany('videos', fresh.map((v) => ({ ...v, watched: true })));
    return fresh.map((v) => v.id);
  };

  const unmarkSeen = async (ids) => {
    const rows = await Promise.all(ids.map((id) => db.get('videos', id)));
    await db.putMany('videos', rows.filter(Boolean).map((v) => ({ ...v, watched: false })));
  };

  /** Sammelaktion: markieren, neu rendern, Undo anbieten. */
  const bulkSeen = async (ids, label) => {
    const done = await markSeen(ids);
    if (!done.length) return;
    render();
    showUndo(label(done.length), async () => { await unmarkSeen(done); render(); });
  };

  const seenSingle = async (v, wrapEl) => {
    await updateVideo(v.id, { watched: true });
    const slot = rememberSlot(wrapEl);
    collapseRemove(wrapEl);
    bumpFeedCount(-1);
    const kurz = v.title.length > 34 ? `${v.title.slice(0, 34)}…` : v.title;
    showUndo(`Gesehen · „${kurz}"`, async () => {
      await updateVideo(v.id, { watched: false });
      restoreSlot(slot);
      bumpFeedCount(1);
    });
  };

  const dislikeSingle = async (v, wrapEl) => {
    await recordFeedback(v.id, 'thumb', -1);
    await updateVideo(v.id, { watched: true, rating: -1 });
    const slot = rememberSlot(wrapEl);
    collapseRemove(wrapEl);
    bumpFeedCount(-1);
    showUndo('Weniger davon — ausgeblendet', async () => {
      await clearFeedback(v.id, 'thumb');
      await updateVideo(v.id, { watched: false, rating: null });
      restoreSlot(slot);
      bumpFeedCount(1);
    });
  };

  const toggleLike = async (v) => {
    const cur = await db.get('videos', v.id);
    if (cur?.rating === 1) {
      await clearFeedback(v.id, 'thumb');
      await updateVideo(v.id, { rating: null });
      toast('Wertung entfernt.');
    } else {
      await recordFeedback(v.id, 'thumb', 1);
      await updateVideo(v.id, { rating: 1 });
      toast('Notiert: mehr davon.');
    }
  };

  const markFromHere = async (idx) => {
    const ids = [...wrap.querySelectorAll('[data-idx]')]
      .filter((n) => Number(n.dataset.idx) >= idx)
      .map((n) => n.dataset.id);
    await bulkSeen(ids, (n) => `${n} als gesehen markiert`);
  };

  const remainingFrom = (idx) =>
    [...wrap.querySelectorAll('[data-idx]')].filter((n) => Number(n.dataset.idx) >= idx).length;

  const subscribeChannel = async (v) => {
    const s = await S.load();
    const kanal = await yt.resolveChannel(v.channelId, s.ytKey);
    const wasBlocked = (await db.kvGet('blockedChannels', [])).includes(v.channelId);
    await db.put('channels', kanal);
    await unblockChannel(v.channelId);
    // Bestehende Entdeckungen des Kanals werden zu normalen Abo-Videos.
    const flipped = (await db.getAll('videos'))
      .filter((x) => x.channelId === v.channelId && x.source === 'discovery');
    await db.putMany('videos', flipped.map((x) => ({ ...x, source: 'subscription' })));
    const slots = [...wrap.querySelectorAll(`[data-channel-id="${v.channelId}"]`)].map(rememberSlot);
    for (const s2 of slots) { collapseRemove(s2.node); bumpFeedCount(-1); }
    showUndo(`„${kanal.title}" abonniert`, async () => {
      await db.del('channels', kanal.id);
      if (wasBlocked) await blockChannel(v.channelId);
      await db.putMany('videos', flipped.map((x) => ({ ...x, source: 'discovery' })));
      render();
    });
  };

  const blockDiscovery = async (v) => {
    await blockChannel(v.channelId);
    const isSub = Boolean(await db.get('channels', v.channelId));
    const slots = [...wrap.querySelectorAll(`[data-channel-id="${v.channelId}"]`)].map(rememberSlot);
    for (const s2 of slots) { collapseRemove(s2.node); bumpFeedCount(-1); }
    showUndo(`„${v.channelTitle}" wird nicht mehr vorgeschlagen${isSub ? ' (Abo bleibt)' : ''}`,
      async () => {
        await unblockChannel(v.channelId);
        for (const s2 of slots) { restoreSlot(s2); bumpFeedCount(1); }
      });
  };

  /**
   * „Weg damit" ohne jede Wertung. Der Unterschied zu „Weniger davon":
   * Ein Autotest-Kanal ist gut, nur DIESES Modell interessiert nicht —
   * das darf weder den Kanal noch das Thema abwerten. Setzt nur dismissed,
   * schreibt kein Feedback.
   */
  const hideSingle = async (v, wrapEl) => {
    await updateVideo(v.id, { dismissed: true });
    const slot = rememberSlot(wrapEl);
    collapseRemove(wrapEl);
    bumpFeedCount(-1);
    showUndo('Ausgeblendet — ohne Wertung', async () => {
      await updateVideo(v.id, { dismissed: false });
      restoreSlot(slot);
      bumpFeedCount(1);
    });
  };

  /** Für später parken: raus aus dem Feed, rein in die Merkliste. */
  const saveForLater = async (v, wrapEl) => {
    await updateVideo(v.id, { saved: true, savedAt: new Date().toISOString() });
    const slot = rememberSlot(wrapEl);
    collapseRemove(wrapEl);
    bumpFeedCount(-1);
    showUndo('Gemerkt — liegt in der Merkliste', async () => {
      await updateVideo(v.id, { saved: false, savedAt: null });
      restoreSlot(slot);
      bumpFeedCount(1);
    });
  };

  const menuFor = (v, wrapEl, idx, { discovery = false } = {}) => async (anchor) => {
    const cur = await db.get('videos', v.id) || v;
    openMenu(anchor, [
      { icon: '🔖', label: 'Merken — später ansehen', onTap: () => saveForLater(v, wrapEl) },
      { icon: '👍', label: 'Mehr davon', checked: cur.rating === 1, onTap: () => toggleLike(v) },
      { icon: '👎', label: 'Weniger davon — und ausblenden', onTap: () => dislikeSingle(v, wrapEl) },
      { icon: '✕', label: 'Ausblenden — ohne Wertung', onTap: () => hideSingle(v, wrapEl) },
      { icon: '↗', label: 'In YouTube öffnen', onTap: () => { armReturnPrompt(v); window.open(watchUrl(v.id), '_blank', 'noopener'); } },
      idx != null ? { icon: '✓', label: `Ab hier alle als gesehen (${remainingFrom(idx)})`, onTap: () => markFromHere(idx) } : null,
      discovery ? { sep: true } : null,
      discovery ? { icon: '✓', label: 'Gesehen', onTap: () => seenSingle(v, wrapEl) } : null,
      discovery ? { icon: '+', label: 'Kanal abonnieren', onTap: () => subscribeChannel(v) } : null,
      discovery ? { icon: '🚫', label: 'Nie wieder vorschlagen', danger: true, onTap: () => blockDiscovery(v) } : null,
      v.score != null ? { inert: true, label: `Score: ${v.score}` } : null,
    ]);
  };

  const actionRow = (v, wrapEl, idx, { discovery = false } = {}) => {
    const menu = menuFor(v, wrapEl, idx, { discovery });
    const moreBtn = el('button', {
      class: 'btn icon', 'aria-label': 'Weitere Aktionen',
      onclick: () => menu(moreBtn),
    }, '···');
    const primary = discovery
      ? el('button', { class: 'btn', onclick: () => subscribeChannel(v) }, '+ Kanal')
      : el('button', { class: 'btn', onclick: () => seenSingle(v, wrapEl) }, 'Gesehen');
    return el('div', { class: 'actionrow' }, primary, moreBtn);
  };

  const attachLongPress = (node, v, wrapEl, idx, opts) => {
    let timer = null; let sx = 0; let sy = 0; let fired = false;
    node.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.target.closest('button, a, .btn')) return;
      sx = e.clientX; sy = e.clientY; fired = false;
      timer = setTimeout(() => { fired = true; menuFor(v, wrapEl, idx, opts)(pointAnchor(sx, sy)); }, 450);
    });
    const cancel = (e) => {
      if (e && Math.hypot(e.clientX - sx, e.clientY - sy) < 10 && e.type === 'pointermove') return;
      clearTimeout(timer);
    };
    node.addEventListener('pointermove', cancel);
    node.addEventListener('pointerup', () => clearTimeout(timer));
    node.addEventListener('pointercancel', () => clearTimeout(timer));
    node.addEventListener('click', (e) => {
      if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; }
    }, true);
  };

  // --- Kartentypen ---

  const heroCard = (o, idx) => {
    const v = o.video;
    const body = el('div', { class: 'card-body' },
      overline(v, o.exploration, { discovery: v.source === 'discovery' }),
      el('h3', { class: 'hero-title' }, v.title),
      v.reason ? el('p', { class: 'reason hero-reason' }, v.reason) : null);
    const card = el('article', {
      class: 'card hero', dataset: { id: v.id, idx: String(idx), channelId: v.channelId },
    }, thumbShell(v, { rounded: '' }), body); // Rundung regelt das CSS je Breite
    // Erst jetzt, denn die Aktionszeile braucht eine Referenz auf die Karte.
    body.append(actionRow(v, card, idx, { discovery: v.source === 'discovery' }));
    makeTappable(card, v);
    attachLongPress(card, v, card, idx, { discovery: v.source === 'discovery' });
    return card;
  };

  const gridCard = (o, idx) => {
    const v = o.video;
    const body = el('div', { class: 'card-body' },
      overline(v, o.exploration),
      el('h3', { class: 'card-title' }, v.title),
      v.reason ? el('p', { class: 'reason' }, v.reason) : null);
    const card = el('article', {
      class: 'card sec', dataset: { id: v.id, idx: String(idx), channelId: v.channelId },
    }, thumbShell(v, { rounded: '16px 16px 0 0' }), body);
    body.append(actionRow(v, card, idx));
    makeTappable(card, v);
    attachLongPress(card, v, card, idx, {});
    return card;
  };

  const rowItem = (o, idx) => {
    const v = o.video;
    const rowWrap = el('div', {
      class: 'row-wrap', dataset: { id: v.id, idx: String(idx), channelId: v.channelId },
    });
    const under = el('div', { class: 'row-under', 'aria-hidden': 'true' },
      el('span', { class: 'row-under-label' }, '✓ Gesehen'));
    const bylineParts = [v.channelTitle, fmtAge(v.publishedAt)];
    if (!v.liveStatus) bylineParts.push(fmtMins(v.durationSec));
    const row = el('div', { class: 'row-item' },
      thumbShell(v),
      el('div', { class: 'row-body' },
        o.exploration ? el('div', { class: 'overline' }, el('span', { class: 'ov-warn' }, 'Ausprobiert für dich')) : null,
        el('h3', { class: 'row-title' }, v.title),
        el('div', { class: 'byline' },
          v.liveStatus === 'live' ? el('span', { class: 'ov-good' }, 'Live · ') : null,
          v.liveStatus === 'upcoming' ? el('span', { class: 'ov-warn' }, 'Premiere · ') : null,
          bylineParts.join(' · ')),
        v.reason ? el('p', { class: 'reason' }, v.reason) : null,
        actionRow(v, rowWrap, idx)));
    rowWrap.append(under, row);
    makeTappable(row, v);
    attachSwipe(rowWrap, row, {
      onCommit: () => seenSingle(v, rowWrap),
      onLongPress: (x, y) => menuFor(v, rowWrap, idx, {})(pointAnchor(x, y)),
    });
    return rowWrap;
  };

  const discoverCard = (o, idx) => {
    const v = o.video;
    const bylineParts = [v.channelTitle, fmtAge(v.publishedAt)];
    if (!v.liveStatus) bylineParts.push(fmtMins(v.durationSec));
    if (v.viewCount) bylineParts.push(`${fmtCount(v.viewCount)} Aufrufe`); // begründet die Aufruf-Hürde
    const body = el('div', { class: 'card-body' },
      el('h3', { class: 'card-title' }, v.title),
      el('div', { class: 'byline' }, bylineParts.join(' · ')),
      v.reason ? el('p', { class: 'reason' }, v.reason) : null);
    const card = el('article', {
      class: 'card disc', dataset: { id: v.id, idx: String(idx), channelId: v.channelId },
    }, thumbShell(v, { rounded: '14px 14px 0 0' }), body);
    body.append(actionRow(v, card, idx, { discovery: true }));
    makeTappable(card, v);
    attachLongPress(card, v, card, idx, { discovery: true });
    return card;
  };

  // --- Zusammenbauen: Hero, Sektionen, Entdeckungs-Block, Feed-Ende ---

  const globalIdx = new Map(ordered.map((o, i) => [o.video.id, i]));
  wrap.append(heroCard(hero, 0));

  // Feste Reihenfolge unabhängig vom Ranking — sonst kann im KI-Modus ein
  // paar Tage altes, aber hoch bewertetes Video seine Sektion vor „Heute"
  // schieben, weil die Map sonst in Auftauchreihenfolge im Stream einsortiert.
  const buckets = new Map([['Heute', []], ['Gestern', []], ['Diese Woche', []], ['Älter', []]]);
  for (const o of stream) {
    buckets.get(dayBucket(o.video.publishedAt)).push(o);
  }
  for (const [name, members] of [...buckets]) {
    if (!members.length) buckets.delete(name);
  }

  // Karten gibt es nur ganz oben: die ersten vier Videos der OBERSTEN Sektion.
  // Danach einheitliche Zeilen. Vorher wurden die global Top-4 in ihre
  // jeweilige Datums-Sektion einsortiert — im KI-Modus streuten sie über die
  // Tage, und mitten im Feed tauchten scheinbar willkürlich große Karten auf.
  // Jetzt ist es ein Gefälle: Aufmacher → Karten → Zeilen, einmal, von oben.
  const firstBucket = buckets.values().next().value || [];
  const cardSet = new Set(isWide ? firstBucket.slice(0, 4).map((o) => o.video.id) : []);

  const discoverBlock = () => {
    if (!discoveries.length) return null;
    const useScroller = discoveries.length >= 3;
    const holder = el('div', { class: useScroller ? 'discover-row' : 'discover-stack' },
      ...discoveries.map((o) => discoverCard(o, globalIdx.get(o.video.id))));
    return el('section', { class: 'discover-block' },
      el('h2', { class: 'section-title' }, 'Außerhalb deiner Abos'),
      el('p', { class: 'discover-sub' }, 'Vorschläge von Kanälen, die du nicht abonniert hast.'),
      holder);
  };

  let discoverPlaced = false;
  let firstSection = true;
  for (const [name, members] of buckets) {
    const head = el('div', { class: 'section-head' },
      el('h2', { class: 'section-title' }, name),
      el('button', {
        class: 'btn ghost',
        onclick: () => bulkSeen(members.map((o) => o.video.id), (n) => `${name}: ${n} als gesehen markiert`),
      }, 'Alle gesehen'));
    const section = el('section', { class: 'day-section' }, head);

    const cards = members.filter((o) => cardSet.has(o.video.id));
    const rows = members.filter((o) => !cardSet.has(o.video.id));
    if (cards.length) section.append(el('div', { class: 'grid2' },
      ...cards.map((o) => gridCard(o, globalIdx.get(o.video.id)))));
    for (const o of rows) section.append(rowItem(o, globalIdx.get(o.video.id)));
    wrap.append(section);

    if (firstSection && members.length >= 3 && discoveries.length) {
      const block = discoverBlock();
      if (block) { wrap.append(block); discoverPlaced = true; }
    }
    firstSection = false;
  }
  if (!discoverPlaced && discoveries.length) wrap.append(discoverBlock());

  wrap.append(el('div', { class: 'feed-end card' },
    el('p', { class: 'feed-end-title' }, 'Ende erreicht'),
    el('button', {
      class: 'btn',
      onclick: () => bulkSeen(ordered.map((o) => o.video.id), (n) => `${n} als gesehen markiert`),
    }, `Alle ${ordered.length} als gesehen markieren`),
    rejectedTotal
      ? el('a', { class: 'feed-end-link', href: '#/status' }, `${rejectedTotal} ausgefiltert — Details im Status`)
      : null));

  // Erststart-Coaching: die oberste Zeile zeigt einmal, dass Wischen geht.
  if (!reducedMotion()) {
    db.kvGet('swipeHintShown', false).then((shown) => {
      if (shown) return;
      const firstRow = wrap.querySelector('.row-item');
      if (!firstRow) return;
      setTimeout(() => {
        firstRow.style.transition = 'transform 300ms ease';
        firstRow.style.transform = 'translateX(24px)';
        setTimeout(() => { firstRow.style.transform = ''; }, 1200);
        db.kvSet('swipeHintShown', true);
      }, 800);
    });
  }

  return wrap;
}

// ---------- Merkliste ----------

async function viewSaved() {
  const videos = (await db.getAll('videos'))
    .filter((v) => v.saved)
    .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));

  const wrap = el('div', { class: 'paper' });
  wrap.append(el('header', { class: 'masthead' },
    el('div', { class: 'overline' }, `Merkliste · ${videos.length}`),
    el('h1', { class: 'masthead-date' }, 'Später ansehen')));

  if (!videos.length) {
    wrap.append(el('div', { class: 'empty' },
      el('strong', {}, 'Nichts gemerkt'),
      el('p', {}, 'Im Feed: ···-Menü → „Merken — später ansehen". Gemerkte Videos überleben auch das Aufräumen alter Videos.')));
    return wrap;
  }

  for (const v of videos) {
    const bylineParts = [v.channelTitle, fmtAge(v.publishedAt)];
    if (!v.liveStatus) bylineParts.push(fmtMins(v.durationSec));
    const row = el('div', { class: 'row-item saved-item', dataset: { id: v.id } },
      thumbShell(v),
      el('div', { class: 'row-body' },
        el('h3', { class: 'row-title' }, v.title),
        el('div', { class: 'byline' }, bylineParts.join(' · ')),
        v.reason ? el('p', { class: 'reason' }, v.reason) : null,
        el('div', { class: 'actionrow' },
          el('button', {
            class: 'btn',
            onclick: async () => {
              // Gesehen = erledigt: raus aus der Merkliste, zählt als geschaut.
              await updateVideo(v.id, { watched: true, saved: false, savedAt: null });
              const slot = rememberSlot(row);
              collapseRemove(row);
              showUndo(`Gesehen · „${v.title.slice(0, 30)}…"`, async () => {
                await updateVideo(v.id, { watched: false, saved: true, savedAt: v.savedAt });
                restoreSlot(slot);
              });
            },
          }, 'Gesehen'),
          el('button', {
            class: 'btn ghost',
            onclick: async () => {
              // Zurück in den Feed (sofern noch im Altersfenster).
              await updateVideo(v.id, { saved: false, savedAt: null });
              const slot = rememberSlot(row);
              collapseRemove(row);
              showUndo('Aus der Merkliste entfernt', async () => {
                await updateVideo(v.id, { saved: true, savedAt: v.savedAt });
                restoreSlot(slot);
              });
            },
          }, 'Entfernen'))));
    makeTappable(row, v);
    wrap.append(row);
  }
  return wrap;
}

// ---------- Video-Detail ----------

async function viewVideo(id) {
  const v = await db.get('videos', id);
  if (!v) return el('div', { class: 'empty' }, el('strong', {}, 'Video nicht gefunden'));

  const settings = await S.load();
  const wrap = el('div');

  wrap.append(el('a', { class: 'btn ghost', href: '#/', style: 'margin-bottom:14px' }, '‹ Zurück'));

  const playerWrap = el('div', { class: 'player-wrap' });
  const canEmbed = v.embeddable && !v.embedFailed && !v.ageRestricted;

  if (canEmbed) {
    const origin = encodeURIComponent(location.origin);
    const src = `https://www.youtube-nocookie.com/embed/${v.id}`
      + `?enablejsapi=1&playsinline=1&rel=0&origin=${origin}`;
    playerWrap.append(el('iframe', {
      id: 'yt-player',
      src,
      title: v.title,
      allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture; web-share',
      allowfullscreen: true,
      referrerpolicy: 'strict-origin',
    }));
    attachPlayerSignals(v);
  } else {
    playerWrap.append(el('div', { class: 'player-fallback' },
      el('p', {}, v.ageRestricted
        ? 'Altersbeschränkt — Einbetten ist gesperrt.'
        : 'Der Uploader hat das Einbetten deaktiviert.'),
      el('a', { class: 'btn primary', href: watchUrl(v.id), target: '_blank', rel: 'noopener' },
        'In YouTube öffnen')));
  }
  wrap.append(playerWrap);

  // Bedienelemente gehören UNTER den Player, nie darüber (ToS-Vorgabe).
  wrap.append(el('h1', { class: 'video-title' }, v.title));
  wrap.append(el('p', { class: 'sub' },
    `${v.channelTitle} · ${fmtAge(v.publishedAt)} · ${fmtDuration(v.durationSec)}`
    + (v.viewCount ? ` · ${fmtCount(v.viewCount)} Aufrufe` : '')));

  if (v.reason) wrap.append(el('p', { class: 'reason' }, v.reason));

  const markWatched = async () => {
    await updateVideo(v.id, { watched: true });
    toast('Als gesehen markiert.');
  };

  // Gleiche Falle wie im Feed: das Element vor dem ersten `await` festhalten.
  const rate = (value, label) => {
    const btn = el('button', {
      class: 'btn',
      onclick: async () => {
        const good = value > 0;
        btn.classList.toggle('on-good', good);
        btn.classList.toggle('on-bad', !good);
        try {
          await recordFeedback(v.id, 'thumb', value);
          await updateVideo(v.id, { watched: true, rating: value });
          toast(good ? 'Notiert: mehr davon.' : 'Notiert: weniger davon.');
        } catch (e) {
          btn.classList.remove('on-good', 'on-bad');
          toast(`Bewertung konnte nicht gespeichert werden: ${e.message}`, 'error');
        }
      },
    }, label);
    return btn;
  };

  wrap.append(el('div', { class: 'video-actions' },
    rate(1, '👍 Gut'),
    rate(-1, '👎 Nicht gut'),
    el('a', {
      class: 'btn primary', href: watchUrl(v.id), target: '_blank', rel: 'noopener',
      onclick: () => armReturnPrompt(v),
    }, 'In YouTube öffnen'),
    el('button', { class: 'btn ghost', onclick: markWatched }, 'Gesehen'),
    el('button', {
      class: 'btn ghost',
      onclick: async () => {
        const cur = await db.get('videos', v.id);
        const jetzt = !cur?.saved;
        await updateVideo(v.id, { saved: jetzt, savedAt: jetzt ? new Date().toISOString() : null });
        toast(jetzt ? 'Gemerkt — liegt in der Merkliste.' : 'Aus der Merkliste entfernt.');
      },
    }, '🔖 Merken'),
    el('button', {
      class: 'btn ghost',
      onclick: async () => {
        const c = await db.get('channels', v.channelId);
        if (!c) return;
        await db.put('channels', { ...c, weight: Math.max(0.2, (c.weight ?? 1) * 0.6) });
        await recordFeedback(v.id, 'channel_pref', -1);
        toast(`Weniger von „${c.title}".`);
      },
    }, 'Weniger von diesem Kanal')));

  if (settings.aiEnabled && v.scoreTags?.length) {
    wrap.append(el('div', { class: 'badges' },
      ...v.scoreTags.map((t) => el('span', { class: 'badge' }, t))));
  }

  if (v.description) {
    wrap.append(el('h2', {}, 'Beschreibung'));
    wrap.append(el('div', { class: 'desc' }, v.description));
  }

  return wrap;
}

/**
 * IFrame-API für Abspiel-Signale. Rein optional: schlägt das Laden fehl
 * (kein Netz, blockiertes Skript), funktioniert der Player weiter, nur ohne
 * automatisches „zu Ende geschaut".
 */
function attachPlayerSignals(video) {
  const boot = () => {
    if (!window.YT?.Player) return;
    try {
      let lastTime = 0;
      const player = new window.YT.Player('yt-player', {
        events: {
          onStateChange: async (e) => {
            const YT = window.YT.PlayerState;
            if (e.data === YT.PLAYING) lastTime = player.getCurrentTime?.() || 0;
            if (e.data === YT.ENDED) {
              await updateVideo(video.id, { watched: true });
              await recordFeedback(video.id, 'completion', 1);
            }
            if (e.data === YT.PAUSED) {
              const t = player.getCurrentTime?.() || 0;
              const dur = player.getDuration?.() || video.durationSec || 0;
              if (dur && t / dur > 0.9) {
                await updateVideo(video.id, { watched: true });
                await recordFeedback(video.id, 'completion', 1);
              } else if (t > 0 && t < 30 && lastTime > 0) {
                await recordFeedback(video.id, 'skip', -0.5);
              }
            }
          },
          onError: async (e) => {
            // 101/150 = Einbetten deaktiviert, 100 = weg, 5 = HTML5-Problem
            if ([100, 101, 150].includes(e.data)) {
              await updateVideo(video.id, { embedFailed: true });
              toast('Einbetten nicht erlaubt — bitte „In YouTube öffnen".', 'warn');
              render();
            }
          },
        },
      });
    } catch { /* Signale sind optional */ }
  };

  if (window.YT?.Player) { boot(); return; }
  window.onYouTubeIframeAPIReady = boot;
  if (!document.getElementById('yt-iframe-api')) {
    const s = el('script', { id: 'yt-iframe-api', src: 'https://www.youtube.com/iframe_api' });
    s.onerror = () => { /* offline: kein Problem, Player läuft trotzdem */ };
    document.head.append(s);
  }
}

/** Nach der Rückkehr aus der YouTube-App einmal fragen — ein Tap, mehr nicht. */
function armReturnPrompt(video) {
  const onBack = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onBack);
    setTimeout(() => {
      const host = document.getElementById('toast-host');
      const box = el('div', { class: 'toast', style: 'pointer-events:auto' },
        el('span', {}, 'Gesehen? '),
        el('button', {
          class: 'btn icon', onclick: async () => {
            await recordFeedback(video.id, 'thumb', 1);
            await updateVideo(video.id, { watched: true });
            box.remove(); render();
          },
        }, '👍'),
        el('button', {
          class: 'btn icon', onclick: async () => {
            await recordFeedback(video.id, 'thumb', -1);
            await updateVideo(video.id, { watched: true });
            box.remove(); render();
          },
        }, '👎'),
        el('button', { class: 'btn ghost', onclick: () => box.remove() }, 'Später'));
      host.append(box);
    }, 400);
  };
  document.addEventListener('visibilitychange', onBack);
}

// ---------- Kanäle ----------

async function viewChannels() {
  const { channels, videos, settings } = await loadContext();
  const counts = new Map();
  for (const v of videos) counts.set(v.channelId, (counts.get(v.channelId) || 0) + 1);

  const wrap = el('div');
  wrap.append(el('h1', {}, 'Kanäle'), el('p', { class: 'sub' }, `${channels.length} Kanäle`));

  // --- Import ---
  const box = el('textarea', {
    placeholder: 'Takeout-CSV hier einfügen — oder eine Zeile pro Kanal:\n@handle\nhttps://www.youtube.com/@handle\nUCxxxxxxxxxxxxxxxxxxxxxx',
  });
  const status = el('p', { class: 'hint' });

  // Datei-Auswahl: greift auf dem iPad in „Dateien" und iCloud Drive. Damit
  // brauchst du den Mac nicht — AirDrop die Abos.csv einmal aufs iPad, fertig.
  const filePicker = el('input', {
    type: 'file',
    accept: '.csv,.txt,text/csv,text/plain',
    style: 'display:none',
  });
  filePicker.addEventListener('change', async () => {
    const file = filePicker.files?.[0];
    if (!file) return;
    try {
      box.value = await file.text();
      const treffer = new Set(box.value.match(/UC[\w-]{22}/g) || []).size;
      status.textContent = treffer
        ? `${file.name}: ${treffer} Kanäle erkannt — jetzt „Importieren" tippen.`
        : `${file.name} enthält keine Kanal-IDs. Ist das wirklich die Abos.csv?`;
    } catch (e) {
      toast(`Datei konnte nicht gelesen werden: ${e.message}`, 'error');
    }
    filePicker.value = '';
  });

  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Kanäle hinzufügen'),
    box,
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', {
        class: 'btn',
        onclick: () => filePicker.click(),
      }, 'CSV-Datei wählen'),
      filePicker,
      el('button', {
        class: 'btn primary',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await importChannels(box.value, settings.ytKey, (msg) => { status.textContent = msg; });
            box.value = '';
            render();
          } catch (err) {
            toast(err.message, 'error', 7000);
          } finally { btn.disabled = false; }
        },
      }, 'Importieren')),
    status,
    el('p', { class: 'hint' },
      'Zwei Wege: ', el('b', {}, 'CSV-Datei wählen'), ' greift auf „Dateien" und iCloud Drive — ',
      'schick dir die ', el('code', {}, 'Abos.csv'), ' einmal per AirDrop aufs iPad. ',
      'Oder den Inhalt oben ins Textfeld einsetzen.'),
    el('p', { class: 'hint' },
      'Die Datei bekommst du über takeout.google.com → alles abwählen → nur ',
      '„YouTube und YouTube Music" → darin nur „Abos". Sie heißt ',
      el('code', {}, 'Abos.csv'), ' (englisch: ', el('code', {}, 'subscriptions.csv'), ').')));

  // --- Liste ---
  for (const c of channels.sort((a, b) => a.title.localeCompare(b.title, 'de'))) {
    wrap.append(el('div', { class: `chan ${c.active === false ? 'off' : ''}` },
      c.thumb ? el('img', { src: c.thumb, alt: '', loading: 'lazy' }) : el('div', { class: 'img' }),
      el('div', { class: 'name' },
        el('b', {}, c.title),
        el('small', {}, `${counts.get(c.id) || 0} Videos`
          + (c.weight !== 1 ? ` · Gewicht ${c.weight.toFixed(2)}` : '')
          + (c.lastStatus && c.lastStatus !== 'ok' ? ` · ${c.lastStatus}` : ''))),
      el('button', {
        class: 'btn',
        onclick: async () => { await db.put('channels', { ...c, active: c.active === false }); render(); },
      }, c.active === false ? 'Anschalten' : 'Stumm'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          const eigene = videos.filter((x) => x.channelId === c.id);
          const frage = eigene.length
            ? `„${c.title}" entfernen? Die ${eigene.length} Videos dieses Kanals werden mit gelöscht.`
            : `„${c.title}" wirklich entfernen?`;
          if (!confirm(frage)) return;
          // Videos mit löschen — sonst bleiben sie als Waisen in der Datenbank
          // liegen und belegen Platz, auch wenn der Feed sie ausblendet.
          for (const x of eigene) await db.del('videos', x.id);
          await db.del('channels', c.id);
          toast(`„${c.title}" entfernt${eigene.length ? ` samt ${eigene.length} Videos` : ''}.`);
          render();
        },
      }, 'Entfernen')));
  }

  return wrap;
}

function parseChannelInput(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ids = new Set();
  const others = [];
  for (const line of lines) {
    // CSV: irgendeine Spalte sieht aus wie eine Kanal-ID
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const idCell = cells.find((c) => /^UC[\w-]{22}$/.test(c));
    if (idCell) { ids.add(idCell); continue; }
    const urlId = line.match(/UC[\w-]{22}/);
    if (urlId) { ids.add(urlId[0]); continue; }
    if (/^(channel id|channel-id|kanal)/i.test(line)) continue; // Kopfzeile
    others.push(cells[0] || line);
  }
  return { ids: [...ids], others };
}

async function importChannels(text, ytKey, onStatus) {
  if (!ytKey) throw new Error('Zuerst den YouTube-API-Key in den Einstellungen eintragen.');
  const { ids, others } = parseChannelInput(text);
  if (!ids.length && !others.length) throw new Error('Nichts Erkennbares gefunden.');

  const existing = new Set(await db.allKeys('channels'));
  const found = [];
  const failed = [];

  if (ids.length) {
    onStatus(`${ids.length} Kanal-IDs werden geladen…`);
    const newIds = ids.filter((id) => !existing.has(id));
    if (newIds.length) found.push(...await yt.fetchChannels(newIds, ytKey));
  }

  for (let i = 0; i < others.length; i++) {
    onStatus(`Handle ${i + 1}/${others.length} wird aufgelöst…`);
    try {
      const c = await yt.resolveChannel(others[i], ytKey);
      if (c && !existing.has(c.id)) found.push(c);
    } catch (e) {
      failed.push(`${others[i]}: ${e.message}`);
    }
  }

  await db.putMany('channels', found);
  const skipped = ids.length + others.length - found.length - failed.length;
  onStatus(`${found.length} hinzugefügt`
    + (skipped > 0 ? `, ${skipped} bereits vorhanden` : '')
    + (failed.length ? `, ${failed.length} fehlgeschlagen` : '') + '.');
  if (failed.length) toast(failed.slice(0, 3).join(' · '), 'warn', 8000);
  if (found.length) toast(`${found.length} Kanäle hinzugefügt. Jetzt „Aktualisieren" tippen.`);
}

// ---------- Manifest ----------

async function viewManifest() {
  const [manifest, settings] = await Promise.all([S.getManifest(), S.load()]);
  const area = el('textarea', { style: 'min-height:400px' });
  area.value = manifest;

  return el('div', {},
    el('h1', {}, 'Manifest'),
    el('p', { class: 'sub' },
      'Beschreibe in eigenen Worten, was du sehen willst. Claude bewertet jedes '
      + 'Video danach und schreibt einen Satz dazu, warum es vorgeschlagen wird.'),
    !settings.aiEnabled
      ? el('div', { class: 'card' },
          el('p', { class: 'hint', style: 'margin:0' },
            'Die KI-Bewertung ist gerade aus. Der Feed läuft chronologisch — das '
            + 'löst „keine alten Videos, keine Shorts" bereits vollständig. '),
          el('a', { class: 'btn', href: '#/settings', style: 'margin-top:10px' },
            'KI-Bewertung einschalten'))
      : null,
    area,
    el('div', { class: 'row', style: 'margin-top:12px' },
      el('button', {
        class: 'btn primary',
        onclick: async () => { await S.setManifest(area.value); toast('Manifest gespeichert.'); },
      }, 'Speichern'),
      el('button', {
        class: 'btn',
        onclick: async () => {
          if (!confirm('Alle bisherigen Bewertungen verwerfen und beim nächsten Lauf neu bewerten?')) return;
          const videos = await db.getAll('videos');
          await db.putMany('videos', videos.map((v) => ({ ...v, score: null, reason: null, scoreTags: null })));
          toast('Bewertungen zurückgesetzt.');
        },
      }, 'Neu bewerten lassen')));
}

// ---------- Einstellungen ----------

async function viewSettings() {
  const s = await S.load();
  const wrap = el('div');
  wrap.append(el('h1', {}, 'Einstellungen'));

  const fields = {};
  const field = (key, label, attrs = {}, hint = null) => {
    const input = el('input', { type: 'text', value: s[key] ?? '', ...attrs });
    fields[key] = input;
    return el('label', { class: 'field' }, el('span', {}, label), input,
      hint ? el('p', { class: 'hint' }, hint) : null);
  };

  // Schlüssel.
  // `type=password` verhindert, dass iOS den ersten Buchstaben großschreibt —
  // das allein würde einen API-Key unbrauchbar machen. Die data-*-Attribute
  // halten Passwort-Manager (iCloud-Schlüsselbund, 1Password, Bitwarden) davon
  // ab, hier fremde Zugangsdaten hineinzuschreiben.
  const keyAttrs = {
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    'data-1p-ignore': 'true',
    'data-lpignore': 'true',
    'data-bwignore': 'true',
  };
  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Schlüssel'),
    field('ytKey', 'YouTube Data API v3 — API-Key', keyAttrs,
      'console.cloud.google.com → Projekt → YouTube Data API v3 aktivieren → Anmeldedaten → API-Schlüssel. Kein OAuth nötig.'),
    field('anthropicKey', 'Anthropic API-Key (optional)', keyAttrs,
      'Nur für die KI-Bewertung. Bleibt auf diesem Gerät und geht ausschließlich an api.anthropic.com.')));

  // Filter
  const langInput = el('input', { type: 'text', value: (s.languages || []).join(', ') });
  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Filter'),
    el('div', { class: 'row' },
      field('maxAgeDays', 'Maximales Alter (Tage)', { type: 'number', min: 1, max: 365 }),
      field('minDurationSec', 'Mindestdauer (Sekunden)', { type: 'number', min: 0 }),
      field('maxDurationSec', 'Maximaldauer (0 = kein Limit)', { type: 'number', min: 0 })),
    el('div', { class: 'row' },
      field('shortsMaxSec', 'Shorts-Grenze (Sekunden)', { type: 'number', min: 0 })),
    el('label', { class: 'field' }, el('span', {}, 'Sprachen (leer = alle)'), langInput,
      el('p', { class: 'hint' }, 'Kommagetrennt, z. B. ', el('code', {}, 'de, en'))),
    el('p', { class: 'hint' },
      'Das Alterslimit greift schon beim Laden: Ältere Videos landen gar nicht erst '
      + 'in der Datenbank. Shorts werden dreifach abgefangen — über die Langform-Playlist, '
      + 'über #shorts und über die Dauer.')));

  // Feed
  const sortSelect = el('select', {},
    el('option', { value: 'newest' }, 'Neueste zuerst (chronologisch)'),
    el('option', { value: 'ai' }, 'KI-Ranking (braucht Bewertungen)'));
  sortSelect.value = s.sortMode;

  const aiToggle = el('input', { type: 'checkbox' });
  aiToggle.checked = Boolean(s.aiEnabled);

  const modelSelect = el('select', {},
    el('option', { value: 'claude-haiku-4-5' }, 'Claude Haiku 4.5 — günstig ($1/$5 pro Mio. Token)'),
    el('option', { value: 'claude-sonnet-5' }, 'Claude Sonnet 5 — genauer, teurer'));
  modelSelect.value = s.model;

  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Feed & KI'),
    el('label', { class: 'field' }, el('span', {}, 'Sortierung'), sortSelect),
    el('label', { class: 'field' },
      el('span', {}, 'KI-Bewertung'),
      el('div', { style: 'display:flex;align-items:center;gap:10px;min-height:44px' },
        aiToggle, el('span', {}, 'Videos von Claude bewerten lassen'))),
    el('label', { class: 'field' }, el('span', {}, 'Modell'), modelSelect),
    el('div', { class: 'row' },
      field('dailyBudgetUsd', 'Tagesbudget (USD, harter Stop)', { type: 'number', min: 0, step: 0.05 }),
      field('batchSize', 'Videos pro Anfrage', { type: 'number', min: 5, max: 40 }),
      field('halfLifeDays', 'Halbwertszeit Ranking (Tage)', { type: 'number', min: 1, step: 0.5 }),
      field('popularityWeight', 'Gewicht der Aufrufzahlen (0 = aus)', { type: 'number', min: 0, max: 2, step: 0.1 }))));

  // --- Entdecken ---
  const discToggle = el('input', { type: 'checkbox' });
  discToggle.checked = Boolean(s.discoveryEnabled);

  const queryBox = el('textarea', {
    style: 'min-height:150px',
    placeholder: 'Ein Suchbegriff pro Zeile:\nartificial intelligence\nTesla FSD\nmachine shop build',
  });
  queryBox.value = (s.discoveryQueries || []).join('\n');

  const discStatus = el('p', { class: 'hint' });

  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Entdecken'),
    el('p', { class: 'hint', style: 'margin-top:0' },
      'Sucht Videos außerhalb deiner Abos. Jede Suche kostet 100 von 10.000 '
      + 'Quota-Einheiten am Tag — der Abo-Abgleich braucht davon nur rund 80.'),
    el('label', { class: 'field' },
      el('span', {}, 'Vorschläge außerhalb der Abos'),
      el('div', { style: 'display:flex;align-items:center;gap:10px;min-height:44px' },
        discToggle, el('span', {}, 'Einschalten'))),
    el('label', { class: 'field' }, el('span', {}, 'Themen'), queryBox),
    el('div', { style: 'margin-bottom:14px' },
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          const btn = e.currentTarget;
          const eingaben = collect();
          if (!eingaben.anthropicKey) { toast('Dafür wird der Anthropic-Key gebraucht.', 'warn'); return; }
          btn.disabled = true;
          discStatus.textContent = 'Claude liest dein Manifest…';
          try {
            const [manifest, kanaele] = await Promise.all([S.getManifest(), db.getAll('channels')]);
            const vorschlaege = await ai.suggestQueries(manifest, kanaele.map((c) => c.title), {
              apiKey: eingaben.anthropicKey,
              model: eingaben.model,
              budgetUsd: eingaben.dailyBudgetUsd,
            });
            const vorhanden = queryBox.value.split('\n').map((x) => x.trim()).filter(Boolean);
            queryBox.value = [...new Set([...vorhanden, ...vorschlaege])].join('\n');
            discStatus.textContent = `${vorschlaege.length} Themen ergänzt — streich raus, was nicht passt.`;
            await persist();
          } catch (err) {
            discStatus.textContent = '';
            toast(err.message, 'error', 7000);
          } finally { btn.disabled = false; }
        },
      }, 'Themen aus dem Manifest vorschlagen')),
    discStatus,
    el('div', { class: 'row' },
      field('discoverySearchesPerDay', 'Suchen pro Tag', { type: 'number', min: 0, max: 40 }),
      field('discoveryMinViews', 'Nötige Aufrufe', { type: 'number', min: 0, step: 10000 }),
      field('discoveryRampDays', 'Ab wie vielen Tagen voll gefordert', { type: 'number', min: 0.5, step: 0.5 })),
    el('p', { class: 'hint' },
      'Die Hürde steigt mit dem Alter: Ein Video, das erst ein Drittel der Zeit '
      + 'hatte, muss auch nur ein Drittel der Aufrufe haben. Sonst würde jedes '
      + 'frische Video scheitern, nur weil es noch keine Gelegenheit hatte.')));

  // Sync
  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Laden'),
    el('div', { class: 'row' },
      field('concurrency', 'Parallele Anfragen', { type: 'number', min: 1, max: 10 }),
      field('itemsPerChannel', 'Videos pro Kanal je Lauf', { type: 'number', min: 5, max: 50 }),
      field('keepDays', 'Daten behalten (Tage)', { type: 'number', min: 7, max: 365 }))));

  const collect = () => {
    const patch = {};
    for (const [key, input] of Object.entries(fields)) {
      patch[key] = input.type === 'number' ? Number(input.value) : input.value.trim();
    }
    patch.languages = langInput.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    patch.sortMode = sortSelect.value;
    patch.model = modelSelect.value;
    patch.aiEnabled = aiToggle.checked && Boolean(patch.anthropicKey);
    patch.discoveryQueries = queryBox.value.split('\n').map((x) => x.trim()).filter(Boolean);
    patch.discoveryEnabled = discToggle.checked && patch.discoveryQueries.length > 0;
    return patch;
  };

  const persist = () => S.save(collect());
  flushPendingSettings = persist;

  // Jedes Feld wird beim Verlassen übernommen. Der Knopf bleibt als Bestätigung,
  // aber nichts hängt mehr davon ab, dass du ihn unten im Formular findest.
  wrap.addEventListener('change', () => { persist(); });

  wrap.append(el('div', { class: 'savebar' },
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        if (aiToggle.checked && !fields.anthropicKey.value.trim()) {
          toast('Für die KI-Bewertung fehlt der Anthropic-Key — sie bleibt aus.', 'warn');
          aiToggle.checked = false;
        }
        await persist();
        toast('Gespeichert.');
      },
    }, 'Speichern'),
    el('span', { class: 'savehint' }, 'Änderungen werden automatisch übernommen')));

  // Geräteabgleich
  const syncStatus = el('p', { class: 'hint' });
  cloud.lastSyncInfo().then((info) => {
    if (info) syncStatus.textContent = `Letzter Abgleich: ${new Date(info.at).toLocaleString('de-DE')}`;
  });
  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Geräteabgleich'),
    el('p', { class: 'hint', style: 'margin-top:0' },
      'Teilt Kanäle, Einstellungen, Manifest, Gesehen-Status und Merkliste '
      + 'zwischen Mac, iPad und iPhone — über ein privates GitHub-Repository, '
      + 'clientseitig verschlüsselt. GitHub sieht nur Zufallsbytes; deine '
      + 'API-Keys wandern deshalb sicher mit.'),
    field('syncRepo', 'Privates Repository', { placeholder: 'maam783/mytube-sync' },
      'Ein leeres privates Repo. Auf github.com anlegen oder ein vorhandenes nehmen.'),
    field('syncToken', 'GitHub-Token (fine-grained)', keyAttrs,
      'github.com → Settings → Developer settings → Fine-grained tokens: nur '
      + 'dieses eine Repo auswählen, einzige Berechtigung „Contents: Read and '
      + 'write". So kann das Token nichts außer dieser einen Datei.'),
    field('syncPass', 'Sync-Passwort', keyAttrs,
      'Frei wählbar, auf jedem Gerät dasselbe. Verschlüsselt die Daten, bevor '
      + 'sie GitHub erreichen — ohne dieses Passwort ist die Datei wertlos.'),
    el('div', { class: 'row', style: 'margin-top:4px' },
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          syncStatus.textContent = 'Gleiche ab…';
          try {
            await persist();
            const r = await cloud.syncNow();
            syncStatus.textContent = `Abgeglichen ${new Date().toLocaleTimeString('de-DE')}`
              + (r.hatteRemote ? '' : ' — erster Stand angelegt.');
            toast('Geräteabgleich erfolgreich.');
            render();
          } catch (err) {
            syncStatus.textContent = '';
            toast(err.message, 'error', 8000);
          } finally { btn.disabled = false; }
        },
      }, 'Jetzt abgleichen')),
    syncStatus));

  // Backup
  wrap.append(el('div', { class: 'card', style: 'margin-top:24px' },
    el('h2', { style: 'margin-top:0' }, 'Sicherung'),
    el('p', { class: 'hint', style: 'margin-top:0' },
      'Alles liegt in der Datenbank dieses Geräts. Lade dir vor der Reise eine '
      + 'Sicherung herunter — dann sind Kanäle, Einstellungen und Manifest nicht weg, '
      + 'wenn dem iPad etwas passiert.'),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { class: 'btn', onclick: doExport }, 'Sicherung laden'),
      el('button', { class: 'btn', onclick: doImport }, 'Sicherung einspielen'),
      el('button', {
        class: 'btn danger',
        onclick: async () => {
          if (!confirm('Wirklich alle Videos löschen? Kanäle und Einstellungen bleiben.')) return;
          await db.clear('videos');
          toast('Videos gelöscht.');
          render();
        },
      }, 'Videos löschen'))));

  // Notausgang unterwegs: Wenn du die App auf GitHub änderst, holt der Service
  // Worker die neue Fassung erst beim nächsten Start. Dieser Knopf erzwingt es.
  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'App aktualisieren'),
    el('p', { class: 'hint', style: 'margin-top:0' },
      'Holt die neueste Fassung der App vom Server. Deine Daten bleiben unberührt.'),
    el('button', {
      class: 'btn', style: 'margin-top:10px',
      onclick: async () => {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
        location.reload();
      },
    }, 'Neu laden erzwingen')));

  return wrap;
}

async function doExport() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `mytube-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function doImport() {
  const input = el('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await db.importAll(data, { replace: confirm('Vorhandene Daten ersetzen? Abbrechen = zusammenführen.') });
      S.peek();
      location.reload();
    } catch (e) {
      toast(e.message, 'error', 7000);
    }
  };
  document.body.append(input);
  input.click();
  input.remove();
}

// ---------- Status ----------

async function viewStatus() {
  const [summary, quota, spend, vCount, cCount, settings] = await Promise.all([
    db.kvGet('lastSync', null), yt.getQuota(), ai.getSpend(),
    db.count('videos'), db.count('channels'), S.load(),
  ]);

  const wrap = el('div');
  wrap.append(el('h1', {}, 'Status'));

  wrap.append(el('div', { class: 'stats' },
    el('div', { class: 'stat' }, el('b', {}, vCount), el('span', {}, 'Videos gespeichert')),
    el('div', { class: 'stat' }, el('b', {}, cCount), el('span', {}, 'Kanäle')),
    el('div', { class: 'stat' }, el('b', {}, `${quota.units}`), el('span', {}, 'Quota heute / 10.000')),
    el('div', { class: 'stat' }, el('b', {}, `$${spend.usd.toFixed(3)}`),
      el('span', {}, `KI heute / $${Number(settings.dailyBudgetUsd).toFixed(2)}`))));

  if (summary) {
    wrap.append(el('h2', {}, 'Letzter Lauf'));
    wrap.append(el('p', { class: 'sub' },
      new Date(summary.at).toLocaleString('de-DE')
      + ` · ${summary.added} neu · ${summary.scored} bewertet`
      + ` · ${summary.droppedOld} zu alt · ${summary.droppedShort} Shorts verworfen`));

    if (summary.log?.length) {
      const box = el('div', { class: 'card' });
      for (const l of summary.log) {
        box.append(el('div', { class: `logline ${l.level}` },
          el('time', {}, new Date(l.at).toLocaleTimeString('de-DE')),
          el('span', {}, l.message)));
      }
      wrap.append(box);
    }
  } else {
    wrap.append(el('p', { class: 'sub' }, 'Noch kein Lauf. Tippe oben auf „Aktualisieren".'));
  }

  wrap.append(el('h2', {}, 'Wie das hier läuft'));
  wrap.append(el('div', { class: 'card' }, el('p', { class: 'hint', style: 'margin:0' },
    'Diese App hat keinen Server. Alles läuft auf dem iPad: die YouTube-Anfragen, '
    + 'die Bewertung, die Datenbank. Dein YouTube-Account ist nicht beteiligt — es gibt '
    + 'kein OAuth, keine Cookies, keine Stream-Extraktion. Abgespielt wird über den '
    + 'offiziellen Player oder direkt in der YouTube-App.')));

  return wrap;
}

// ---------- Erststart ----------

function viewWelcome() {
  return el('div', {},
    el('h1', {}, 'Willkommen'),
    el('p', { class: 'sub' }, 'Drei Schritte, dann läuft es.'),
    el('div', { class: 'card' },
      el('h2', { style: 'margin-top:0' }, '1. Zum Home-Bildschirm hinzufügen'),
      el('p', { class: 'hint', style: 'margin-top:0' },
        'Teilen-Symbol → „Zum Home-Bildschirm". Wichtig: Richte alles danach in der '
        + 'Home-Bildschirm-App ein, nicht in Safari — die beiden teilen ihren Speicher nicht.')),
    el('div', { class: 'card' },
      el('h2', { style: 'margin-top:0' }, '2. API-Key eintragen'),
      el('p', { class: 'hint', style: 'margin-top:0' },
        'Ein YouTube-Data-API-Key genügt. Kein OAuth, kein Login, kein Zugriff auf deinen Account.'),
      el('a', { class: 'btn primary', href: '#/settings' }, 'Zu den Einstellungen')),
    el('div', { class: 'card' },
      el('h2', { style: 'margin-top:0' }, '3. Abos importieren'),
      el('p', { class: 'hint', style: 'margin-top:0' },
        'Die subscriptions.csv aus Google Takeout einfügen — einmalig.'),
      el('a', { class: 'btn', href: '#/channels' }, 'Zu den Kanälen')));
}

// ---------- Router ----------

const routes = [
  [/^#\/?$/, viewFeed],
  [/^#\/saved$/, viewSaved],
  [/^#\/v\/([\w-]+)$/, viewVideo],
  [/^#\/channels$/, viewChannels],
  [/^#\/manifest$/, viewManifest],
  [/^#\/settings$/, viewSettings],
  [/^#\/status$/, viewStatus],
];

// Scrollposition pro Route: Zurück aus dem Detail landet exakt dort, wo du
// warst. Vorher sprang jede Navigation und jede Aktion an den Seitenanfang —
// bei 180 Videos ist die Scrollposition aber der Arbeitsstand.
const scrollMem = new Map();
let currentRoute = location.hash || '#/';

async function render() {
  const hash = location.hash || '#/';
  scrollMem.set(currentRoute, window.scrollY);
  if (hash !== currentRoute) dismissUndo(); // Undo gilt für die Seite, auf der es entstand
  flushPendingSettings = null; // gilt nur, solange die Einstellungen offen sind
  for (const link of document.querySelectorAll('.tabs a')) {
    const active = link.getAttribute('href') === hash
      || (link.dataset.tab === 'feed' && hash.startsWith('#/v/'));
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  for (const [re, handler] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    try {
      const node = await handler(...m.slice(1));
      view.replaceChildren(node);
    } catch (e) {
      console.error(e);
      view.replaceChildren(el('div', { class: 'empty' },
        el('strong', {}, 'Etwas ist schiefgegangen'),
        el('p', {}, e.message)));
    }
    const target = scrollMem.get(hash) ?? 0;
    currentRoute = hash;
    // Synchron nach replaceChildren — Layout steht zu diesem Zeitpunkt schon.
    // Bewusst KEIN requestAnimationFrame: das feuert in Hintergrund-Tabs nie,
    // und die Position wäre beim Zurückwechseln verloren. Der Nachschlag nach
    // 60ms überstimmt die browsereigene History-Restauration.
    window.scrollTo(0, target);
    setTimeout(() => window.scrollTo(0, target), 60);
    return;
  }
  location.hash = '#/';
}

// ---------- Start ----------

document.getElementById('sync-btn').addEventListener('click', runSync);
document.getElementById('nav-feed').addEventListener('click', () => { location.hash = '#/'; });
window.addEventListener('hashchange', render);

// Sticky-Sektionsköpfe brauchen die echte Topbar-Höhe (sie bricht auf dem
// iPhone in zwei Zeilen um).
function setTopbarHeight() {
  const tb = document.querySelector('.topbar');
  if (tb) document.documentElement.style.setProperty('--topbar-h', `${tb.offsetHeight}px`);
}
window.addEventListener('resize', setTopbarHeight);

(async function start() {
  // Wir stellen die Scrollposition selbst wieder her — der Browser soll bei
  // Hash-Navigation nicht dazwischenfunken.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  await db.open();
  await S.load();
  setTopbarHeight();
  await render();
  setTopbarHeight();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline-Schale ist optional */ });
  }

  // Beim Start einmal abgleichen: Was du auf dem iPad weggeräumt hast, ist
  // dann auch auf dem Mac weg. Läuft im Hintergrund — ein Fehlschlag (kein
  // Netz) darf den Start nicht aufhalten.
  const s = await S.load();
  if (cloud.isConfigured(s)) {
    cloud.syncNow()
      .then((r) => { if (r.remoteWarNeuer) render(); })
      .catch((e) => toast(`Geräteabgleich: ${e.message}`, 'warn', 6000));
  }
})();
