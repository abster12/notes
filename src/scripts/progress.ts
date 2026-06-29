// Progress tracking — read/listen state per article
// All state in localStorage, no backend

export interface ProgressEntry {
  slug: string;
  read: boolean;
  listenProgress: number; // 0-100
  scrollPosition: number; // 0-1
  lastVisited: string; // ISO timestamp
  firstRead: string | null; // ISO timestamp
  completedAt: string | null;
}

const KEY_PREFIX = 'notes:progress:';
const CHANGED_EVENT = 'notes:progress:changed';

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* noop */ }
}

function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* noop */ }
}

function keys(): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) out.push(k);
    }
    return out;
  } catch { return []; }
}

function dispatch(slug: string, entry: ProgressEntry): void {
  document.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { slug, entry } }));
}

function readEntry(slug: string): ProgressEntry | null {
  const raw = safeGet(KEY_PREFIX + slug);
  if (!raw) return null;
  try { return JSON.parse(raw) as ProgressEntry; } catch { return null; }
}

export function getProgress(slug: string): ProgressEntry | null {
  return readEntry(slug);
}

export function setProgress(slug: string, update: Partial<ProgressEntry>): ProgressEntry {
  const current = readEntry(slug) || {
    slug,
    read: false,
    listenProgress: 0,
    scrollPosition: 0,
    lastVisited: new Date().toISOString(),
    firstRead: null,
    completedAt: null,
  };
  const merged: ProgressEntry = { ...current, ...update, slug, lastVisited: new Date().toISOString() };
  safeSet(KEY_PREFIX + slug, JSON.stringify(merged));
  dispatch(slug, merged);
  return merged;
}

export function markRead(slug: string): void {
  const current = readEntry(slug);
  const now = new Date().toISOString();
  setProgress(slug, {
    read: true,
    firstRead: current?.firstRead || now,
    completedAt: current?.completedAt || now,
  });
}

export function markListenProgress(slug: string, percent: number): void {
  const clamped = Math.max(0, Math.min(100, percent));
  setProgress(slug, { listenProgress: clamped });
}

export function markScrollPosition(slug: string, percent: number): void {
  const clamped = Math.max(0, Math.min(1, percent));
  const update: Partial<ProgressEntry> = { scrollPosition: clamped };
  if (clamped >= 0.9) {
    update.read = true;
    const current = readEntry(slug);
    const now = new Date().toISOString();
    update.firstRead = current?.firstRead || now;
    update.completedAt = current?.completedAt || now;
  }
  setProgress(slug, update);
}

export function getAllProgress(): Record<string, ProgressEntry> {
  const out: Record<string, ProgressEntry> = {};
  for (const k of keys()) {
    const raw = safeGet(k);
    if (!raw) continue;
    try {
      const e = JSON.parse(raw) as ProgressEntry;
      out[e.slug] = e;
    } catch { /* noop */ }
  }
  return out;
}

export function getContinueListening(): { entry: ProgressEntry; url: string } | null {
  const all = Object.values(getAllProgress());
  if (all.length === 0) return null;

  // Prefer in-progress (>0 and <100) by lastVisited desc
  const inProgress = all
    .filter(e => e.listenProgress > 0 && e.listenProgress < 100)
    .sort((a, b) => b.lastVisited.localeCompare(a.lastVisited));

  if (inProgress.length > 0) {
    return { entry: inProgress[0], url: inferUrl(inProgress[0].slug) };
  }

  // Fall back to most recent with any listen progress
  const started = all
    .filter(e => e.listenProgress > 0)
    .sort((a, b) => b.lastVisited.localeCompare(a.lastVisited));

  if (started.length > 0) {
    return { entry: started[0], url: inferUrl(started[0].slug) };
  }

  return null;
}

function inferUrl(slug: string): string {
  // slug is like "system-design/url-shortener" or "coding-interview/sliding-window"
  if (slug.startsWith('http')) return slug;
  const base = (typeof import.meta !== 'undefined' && (import.meta as any).env?.BASE_URL) || '/';
  return base + slug + (slug.endsWith('/') ? '' : '/');
}

export function clearProgress(slug: string): void {
  safeRemove(KEY_PREFIX + slug);
  const empty: ProgressEntry = {
    slug,
    read: false,
    listenProgress: 0,
    scrollPosition: 0,
    lastVisited: new Date().toISOString(),
    firstRead: null,
    completedAt: null,
  };
  dispatch(slug, empty);
}

export function onProgressChange(callback: (slug: string, entry: ProgressEntry) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail && detail.slug && detail.entry) callback(detail.slug, detail.entry);
  };
  const storageHandler = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(KEY_PREFIX) && e.newValue) {
      try {
        const entry = JSON.parse(e.newValue) as ProgressEntry;
        callback(entry.slug, entry);
      } catch { /* noop */ }
    }
  };
  document.addEventListener(CHANGED_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    document.removeEventListener(CHANGED_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}

if (typeof window !== 'undefined') {
  (window as any).NotesProgress = {
    getProgress,
    setProgress,
    markRead,
    markListenProgress,
    markScrollPosition,
    getAllProgress,
    getContinueListening,
    clearProgress,
    onProgressChange,
  };
}
