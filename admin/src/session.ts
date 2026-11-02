// Who is signed in, which site they're looking at, and the alert badge count.
import { api, hasToken, setToken, type Admin } from './api';

interface State {
  admin: Admin | null;
  siteId: number | null;
  siteName: string;
  pending: number;
}

const SITE_KEY = 'invisen-admin-site';
const read = (): { id: number; name: string } | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SITE_KEY) ?? 'null');
    return v && typeof v.id === 'number' ? v : null;
  } catch {
    return null;
  }
};

const saved = read();
const listeners = new Set<() => void>();

export const session = {
  state: { admin: null, siteId: saved?.id ?? null, siteName: saved?.name ?? '', pending: 0 } as State,
  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    listeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  signedIn: () => hasToken(),
  pickSite(id: number, name: string) {
    try {
      localStorage.setItem(SITE_KEY, JSON.stringify({ id, name }));
    } catch {
      /* ignore */
    }
    this.set({ siteId: id, siteName: name, pending: 0 });
  },
  /** Editors may change things; viewers only look. */
  canEdit: () => session.state.admin?.role !== 'viewer',
  isOwner: () => session.state.admin?.role === 'owner',
};

export async function refreshPending() {
  const site = session.state.siteId;
  if (!site || !hasToken()) return;
  try {
    const { n } = await api.pendingCount(site);
    if (n !== session.state.pending) session.set({ pending: n });
  } catch {
    /* next tick */
  }
}

export async function logout() {
  try {
    await api.logout();
  } catch {
    /* already gone */
  }
  setToken(null);
  session.set({ admin: null, pending: 0 });
  location.hash = '#login';
}
