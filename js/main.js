import * as db from './db.js';
import * as yt from './youtube.js';
import * as ai from './ai.js';
import * as S from './settings.js';
import * as sync from './sync.js';
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

async function loadContext() {
  const [settings, videos, channels] = await Promise.all([
    S.load(), db.getAll('videos'), db.getAll('channels'),
  ]);
  const channelsById = new Map(channels.map((c) => [c.id, c]));
  return { settings, videos, channels, channelsById };
}

async function recordFeedback(videoId, type, value) {
  await db.put('feedback', {
    videoId, type, value, createdAt: new Date().toISOString(),
  });
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
  if (syncing) return;

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
  const btn = document.getElementById('sync-btn');
  const bar = document.getElementById('progress');
  const fill = document.getElementById('progress-fill');
  const text = document.getElementById('progress-text');
  btn.disabled = true;
  btn.textContent = 'Lädt…';
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
      if (ev.phase === 'done') return;
      const pct = ev.total ? Math.round((ev.done / ev.total) * 100) : 0;
      fill.style.width = `${pct}%`;
      text.textContent = `${labels[ev.phase] || ev.phase} ${ev.done}/${ev.total}`;
    });
    const errs = summary.log.filter((l) => l.level === 'error').length;
    toast(`${summary.added} neue Videos`
      + (summary.scored ? `, ${summary.scored} bewertet` : '')
      + (errs ? ` · ${errs} Fehler (siehe Status)` : ''),
      errs ? 'warn' : 'info');
  } catch (e) {
    toast(e.message, 'error', 8000);
  } finally {
    syncing = false;
    btn.disabled = false;
    btn.textContent = 'Aktualisieren';
    bar.hidden = true;
    render();
  }
}

// ---------- Feed ----------

async function viewFeed() {
  const { settings, videos, channels, channelsById } = await loadContext();

  if (!settings.ytKey) return viewWelcome();
  if (!channels.length) {
    return el('div', { class: 'empty' },
      el('strong', {}, 'Noch keine Kanäle'),
      el('p', {}, 'Importiere deine Abo-Liste, dann kann es losgehen.'),
      el('a', { class: 'btn primary', href: '#/channels' }, 'Kanäle importieren'));
  }

  const { kept, rejected } = stage0(videos, settings, channelsById);
  const ordered = rank(kept, settings, channelsById);

  const wrap = el('div');
  const rejectSummary = [...rejected.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([why, n]) => `${n} ${why}`).join(' · ');

  wrap.append(el('div', { class: 'feed-meta' },
    el('span', {}, `${ordered.length} Videos · letzte ${settings.maxAgeDays} Tage`),
    rejectSummary ? el('span', {}, `ausgefiltert: ${rejectSummary}`) : null));

  if (!ordered.length) {
    wrap.append(el('div', { class: 'empty' },
      el('strong', {}, 'Nichts Neues'),
      el('p', {}, videos.length
        ? 'Alle aktuellen Videos sind gesehen oder ausgefiltert. Tippe auf „Aktualisieren".'
        : 'Noch nichts geladen. Tippe auf „Aktualisieren".')));
    return wrap;
  }

  for (const { video, exploration } of ordered) wrap.append(feedItem(video, exploration));
  return wrap;
}

function feedItem(v, exploration) {
  const open = () => { location.hash = `#/v/${v.id}`; };

  const badges = el('div', { class: 'badges' },
    exploration ? el('span', { class: 'badge explore' }, 'Ausprobiert für dich') : null,
    v.score != null ? el('span', { class: 'badge score' }, `Score ${v.score}`) : null,
    v.liveStatus === 'live' ? el('span', { class: 'badge' }, 'Live') : null,
    v.liveStatus === 'upcoming' ? el('span', { class: 'badge' }, 'Premiere') : null,
    !v.embeddable ? el('span', { class: 'badge' }, 'nur in YouTube') : null);

  const item = el('div', { class: 'item', dataset: { id: v.id } },
    el('button', { class: 'thumb', onclick: open, 'aria-label': `Video öffnen: ${v.title}` },
      v.thumb ? el('img', { src: v.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : null,
      el('span', { class: 'dur' }, fmtDuration(v.durationSec))),
    el('div', {},
      el('button', { class: 'title', onclick: open }, v.title),
      el('div', { class: 'byline' },
        `${v.channelTitle} · ${fmtAge(v.publishedAt)}`
        + (v.viewCount ? ` · ${fmtCount(v.viewCount)} Aufrufe` : '')),
      badges.children.length ? badges : null,
      v.reason ? el('p', { class: 'reason' }, v.reason) : null,
      el('div', { class: 'actions' },
        el('button', {
          class: 'btn icon', title: 'Mehr davon',
          onclick: async (e) => {
            await recordFeedback(v.id, 'thumb', 1);
            e.currentTarget.classList.add('on-good');
            toast('Notiert: mehr davon.');
          },
        }, '👍'),
        el('button', {
          class: 'btn icon', title: 'Weniger davon',
          onclick: async (e) => {
            await recordFeedback(v.id, 'thumb', -1);
            e.currentTarget.classList.add('on-bad');
            toast('Notiert: weniger davon.');
          },
        }, '👎'),
        el('a', {
          class: 'btn', href: watchUrl(v.id), target: '_blank', rel: 'noopener',
        }, 'In YouTube'),
        el('button', {
          class: 'btn ghost',
          onclick: async () => {
            await updateVideo(v.id, { dismissed: true });
            await recordFeedback(v.id, 'dismiss', -0.3);
            item.remove();
          },
        }, 'Ausblenden'))));

  return item;
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

  wrap.append(el('div', { class: 'video-actions' },
    el('button', {
      class: 'btn', onclick: async (e) => {
        await recordFeedback(v.id, 'thumb', 1);
        await markWatched();
        e.currentTarget.classList.add('on-good');
      },
    }, '👍 Gut'),
    el('button', {
      class: 'btn', onclick: async (e) => {
        await recordFeedback(v.id, 'thumb', -1);
        await markWatched();
        e.currentTarget.classList.add('on-bad');
      },
    }, '👎 Nicht gut'),
    el('a', {
      class: 'btn primary', href: watchUrl(v.id), target: '_blank', rel: 'noopener',
      onclick: () => armReturnPrompt(v),
    }, 'In YouTube öffnen'),
    el('button', { class: 'btn ghost', onclick: markWatched }, 'Gesehen'),
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

  wrap.append(el('div', { class: 'card' },
    el('h2', { style: 'margin-top:0' }, 'Kanäle hinzufügen'),
    box,
    el('div', { style: 'margin-top:10px' },
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
      'Abo-Liste exportieren: takeout.google.com → nur „YouTube und YouTube Music" → ',
      'nur „Abos" → die ', el('code', {}, 'subscriptions.csv'), ' hier einfügen.')));

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
          if (!confirm(`„${c.title}" wirklich entfernen?`)) return;
          await db.del('channels', c.id);
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
      field('halfLifeDays', 'Halbwertszeit Ranking (Tage)', { type: 'number', min: 1, step: 0.5 }))));

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
    download: `privatetube-${new Date().toISOString().slice(0, 10)}.json`,
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
  [/^#\/v\/([\w-]+)$/, viewVideo],
  [/^#\/channels$/, viewChannels],
  [/^#\/manifest$/, viewManifest],
  [/^#\/settings$/, viewSettings],
  [/^#\/status$/, viewStatus],
];

async function render() {
  const hash = location.hash || '#/';
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
    window.scrollTo(0, 0);
    return;
  }
  location.hash = '#/';
}

// ---------- Start ----------

document.getElementById('sync-btn').addEventListener('click', runSync);
document.getElementById('nav-feed').addEventListener('click', () => { location.hash = '#/'; });
window.addEventListener('hashchange', render);

(async function start() {
  await db.open();
  await S.load();
  await render();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline-Schale ist optional */ });
  }
})();
