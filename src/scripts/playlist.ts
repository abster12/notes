// Playlist queue — localStorage-backed playback queue
// No backend, persists across sessions

export interface PlaylistItem {
  slug: string;
  title: string;
  url: string;
}

export interface PlaylistState {
  items: PlaylistItem[];
  currentIndex: number;
  repeat: 'none' | 'all' | 'one';
  shuffle: boolean;
}

const KEY = 'notes:playlist';
const CHANGED_EVENT = 'notes:playlist:changed';

const DEFAULT_STATE: PlaylistState = {
  items: [],
  currentIndex: -1,
  repeat: 'none',
  shuffle: false,
};

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* noop */ }
}

function safeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* noop */ }
}

function readState(): PlaylistState {
  const raw = safeGet(KEY);
  if (!raw) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(raw) as PlaylistState;
    return {
      items: parsed.items || [],
      currentIndex: typeof parsed.currentIndex === 'number' ? parsed.currentIndex : -1,
      repeat: parsed.repeat || 'none',
      shuffle: !!parsed.shuffle,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(state: PlaylistState): void {
  safeSet(KEY, JSON.stringify(state));
  document.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: state }));
}

export function getPlaylist(): PlaylistState {
  return readState();
}

export function addToPlaylist(slug: string, title: string, url: string): void {
  const state = readState();
  if (state.items.some(i => i.slug === slug)) return;
  state.items.push({ slug, title, url });
  if (state.currentIndex === -1) state.currentIndex = 0;
  writeState(state);
}

export function removeFromPlaylist(slug: string): void {
  const state = readState();
  const idx = state.items.findIndex(i => i.slug === slug);
  if (idx === -1) return;
  state.items.splice(idx, 1);
  if (state.currentIndex >= state.items.length) {
    state.currentIndex = state.items.length - 1;
  } else if (idx < state.currentIndex) {
    state.currentIndex--;
  }
  writeState(state);
}

export function isInPlaylist(slug: string): boolean {
  return readState().items.some(i => i.slug === slug);
}

export function clearPlaylist(): void {
  writeState({ ...DEFAULT_STATE });
}

export function reorderPlaylist(fromIndex: number, toIndex: number): void {
  const state = readState();
  if (fromIndex < 0 || fromIndex >= state.items.length) return;
  if (toIndex < 0 || toIndex >= state.items.length) return;
  const [moved] = state.items.splice(fromIndex, 1);
  state.items.splice(toIndex, 0, moved);
  if (state.currentIndex === fromIndex) {
    state.currentIndex = toIndex;
  } else if (state.currentIndex > fromIndex && state.currentIndex <= toIndex) {
    state.currentIndex--;
  } else if (state.currentIndex < fromIndex && state.currentIndex >= toIndex) {
    state.currentIndex++;
  }
  writeState(state);
}

export function setCurrent(slug: string): void {
  const state = readState();
  const idx = state.items.findIndex(i => i.slug === slug);
  if (idx === -1) return;
  state.currentIndex = idx;
  writeState(state);
}

export function nextInQueue(): PlaylistItem | null {
  const state = readState();
  if (state.items.length === 0) return null;

  if (state.currentIndex < state.items.length - 1) {
    state.currentIndex++;
    writeState(state);
    return state.items[state.currentIndex];
  }

  // At end
  if (state.repeat === 'all') {
    state.currentIndex = 0;
    writeState(state);
    return state.items[0];
  }

  return null;
}

export function prevInQueue(): PlaylistItem | null {
  const state = readState();
  if (state.items.length === 0) return null;
  if (state.currentIndex > 0) {
    state.currentIndex--;
    writeState(state);
    return state.items[state.currentIndex];
  }
  return null;
}

export function setRepeat(repeat: 'none' | 'all' | 'one'): void {
  const state = readState();
  state.repeat = repeat;
  writeState(state);
}

export function setShuffle(shuffle: boolean): void {
  const state = readState();
  state.shuffle = shuffle;
  writeState(state);
}

export function onPlaylistChange(callback: (state: PlaylistState) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as PlaylistState | undefined;
    if (detail) callback(detail);
  };
  const storageHandler = (e: StorageEvent) => {
    if (e.key === KEY) callback(readState());
  };
  document.addEventListener(CHANGED_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    document.removeEventListener(CHANGED_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}

if (typeof window !== 'undefined') {
  (window as any).NotesPlaylist = {
    getPlaylist,
    addToPlaylist,
    removeFromPlaylist,
    isInPlaylist,
    clearPlaylist,
    reorderPlaylist,
    setCurrent,
    nextInQueue,
    prevInQueue,
    setRepeat,
    setShuffle,
    onPlaylistChange,
  };
}
