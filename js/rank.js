// Stufe 0 (kostenlos) und das Ranking. Beides läuft bei jedem Render neu,
// damit Einstellungsänderungen sofort greifen, ohne neu zu synchronisieren.

export const DAY_MS = 86_400_000;

export function ageDays(video, now = Date.now()) {
  return (now - new Date(video.publishedAt).getTime()) / DAY_MS;
}

/**
 * Ist das ein Short? Drei Ebenen, weil keine allein trägt:
 *  1. Die UULF-Playlist liefert Shorts gar nicht erst aus (siehe youtube.js)
 *  2. `#shorts` in Titel oder Beschreibung
 *  3. Dauer unterhalb der Shorts-Grenze
 *
 * Ebene 3 läuft nur, wenn die Playlist-Quelle unzuverlässig war (`useDuration`).
 * Sonst würde ein legitimes 2-Minuten-Video fälschlich als Short gelten — dafür
 * ist die Mindestdauer zuständig, und die sagt dann auch ehrlich warum.
 */
export function isShort(video, settings, { useDuration = false } = {}) {
  if (video.isShort === true) return true;
  const hay = `${video.title} ${video.description || ''}`.toLowerCase();
  if (/#shorts?\b/.test(hay)) return true;
  if (useDuration && !video.liveStatus
      && video.durationSec > 0 && video.durationSec <= settings.shortsMaxSec) return true;
  return false;
}

/** Warum ein Video nicht im Feed steht — oder null, wenn es durchkommt. */
export function stage0Reject(video, settings, channelsById, now = Date.now()) {
  if (video.dismissed) return 'weggewischt';
  if (video.watched) return 'gesehen';

  const channel = channelsById.get(video.channelId);
  // Kein Kanaleintrag = Kanal wurde entfernt. Ohne diese Zeile blieben seine
  // Videos für immer im Feed, weil die Stumm-Prüfung darunter ins Leere lief.
  if (!channel) return 'Kanal entfernt';
  if (channel.active === false) return 'Kanal stummgeschaltet';

  const age = ageDays(video, now);
  if (age > settings.maxAgeDays) return `älter als ${settings.maxAgeDays} Tage`;

  if (isShort(video, settings)) return 'Short';

  const live = Boolean(video.liveStatus);
  if (!live) {
    if (settings.minDurationSec > 0 && video.durationSec < settings.minDurationSec) {
      return `kürzer als ${Math.round(settings.minDurationSec / 60)} Min`;
    }
    if (settings.maxDurationSec > 0 && video.durationSec > settings.maxDurationSec) {
      return `länger als ${Math.round(settings.maxDurationSec / 60)} Min`;
    }
  }

  if (settings.languages?.length && video.lang) {
    const base = video.lang.split('-')[0].toLowerCase();
    if (!settings.languages.includes(base)) return `Sprache ${video.lang}`;
  }

  return null;
}

export function stage0(videos, settings, channelsById, now = Date.now()) {
  const kept = [];
  const rejected = new Map();
  for (const v of videos) {
    const why = stage0Reject(v, settings, channelsById, now);
    if (why) rejected.set(why, (rejected.get(why) || 0) + 1);
    else kept.push(v);
  }
  return { kept, rejected };
}

/**
 * Reihenfolge des Feeds.
 *
 * 'newest': strikt chronologisch — das ist die Antwort auf „keine drei Jahre
 * alten Videos". Ohne KI, ohne Umgewichtung, ohne Überraschung.
 *
 * 'ai': score × Altersabfall × Kanalgewicht, danach Maximal-Marginal-Relevance,
 * damit ein produktiver Lieblingskanal nicht den ganzen Feed belegt. Jede
 * n-te Position ist ein Exploration-Slot aus dem Mittelfeld.
 */
export function rank(videos, settings, channelsById, now = Date.now()) {
  if (settings.sortMode !== 'ai') {
    return videos
      .slice()
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map((v) => ({ video: v, exploration: false }));
  }

  const halfLife = Math.max(0.5, settings.halfLifeDays);
  const scored = videos.map((v) => {
    const weight = channelsById.get(v.channelId)?.weight ?? 1;
    const norm = (v.score == null ? 50 : v.score) / 100;
    const decay = Math.exp(-ageDays(v, now) / halfLife);
    return { video: v, base: norm * decay * weight };
  });

  const pool = scored.slice().sort((a, b) => b.base - a.base);
  const explorationPool = scored
    .filter((s) => s.video.score != null && s.video.score >= 40 && s.video.score <= 70)
    .sort((a, b) => b.base - a.base);

  const used = new Set();
  const perChannel = new Map();
  const out = [];
  const every = Math.max(0, settings.explorationEvery | 0);

  const take = (entry, exploration) => {
    used.add(entry.video.id);
    perChannel.set(entry.video.channelId, (perChannel.get(entry.video.channelId) || 0) + 1);
    out.push({ video: entry.video, exploration });
  };

  while (out.length < scored.length) {
    const slot = out.length + 1;

    if (every > 0 && slot % every === 0) {
      const pick = explorationPool.find((s) => !used.has(s.video.id));
      if (pick) { take(pick, true); continue; }
    }

    let best = null;
    let bestVal = -Infinity;
    for (const s of pool) {
      if (used.has(s.video.id)) continue;
      const seen = perChannel.get(s.video.channelId) || 0;
      const val = s.base * Math.pow(0.6, seen);
      if (val > bestVal) { bestVal = val; best = s; }
    }
    if (!best) break;
    take(best, false);
  }

  return out;
}
