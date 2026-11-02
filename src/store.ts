// Small persisted state. Storage can throw in private modes; never let it break the app.
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const session = {
  get onboarded(): boolean {
    return read('invisen.onboarded', false);
  },
  set onboarded(v: boolean) {
    write('invisen.onboarded', v);
  },
};

export const prefs = {
  load: (): Record<string, boolean> => read('invisen.prefs', {}),
  save: (v: Record<string, boolean>) => write('invisen.prefs', v),
};
