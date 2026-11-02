import '@fontsource/ibm-plex-sans-kr/400.css';
import '@fontsource/ibm-plex-sans-kr/600.css';
import '@fontsource/ibm-plex-sans-kr/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles.css';

import { compile, morphChildren, render, setAttrTransform, type Screen } from './dc';
import { toLight } from './theme';
import { screens, type ScreenDef } from './screens';
import { app } from './store';
import { api, setToken, setUnauthorizedHandler } from './api';
import { onNotificationRoute, setupNativeChrome, setupNotificationTaps } from './native';
import { startMonitor, stopMonitor } from './monitor';

const root = document.getElementById('app')!;
const templates = new Map<string, HTMLTemplateElement>();
let current: { route: string; logic: Screen; variant: string } | null = null;

function template(markup: string): HTMLTemplateElement {
  let t = templates.get(markup);
  if (!t) templates.set(markup, (t = compile(markup)));
  return t;
}
const pick = (def: ScreenDef, variant: string) =>
  typeof def.markup === 'string' ? def.markup : (def.markup[variant] ?? Object.values(def.markup)[0]);

/** Where a signed-out / onboarding / signed-in user may go. */
function resolve(hash: string): string {
  const r = hash.replace(/^#\/?/, '').split('?')[0];
  const { token, onboarded } = app.state;
  const def = screens[r];
  if (!token) return def?.access === 'public' ? r : 'main';
  if (!onboarded) return def?.access === 'onboarding' ? r : 'login-profile';
  return def && def.access === 'app' ? r : 'home';
}

function paint() {
  if (!current) return;
  const def = screens[current.route];
  const vals = current.logic.renderVals() as Record<string, unknown>;
  const variant = String(vals.$variant ?? '');
  const box = render(template(pick(def, variant)), vals);
  if (variant !== current.variant) {
    current.variant = variant;
    root.replaceChildren(...Array.from(box.childNodes));
    syncNav();
  } else {
    morphChildren(root, box);
  }
}

function syncNav() {
  root.classList.toggle('has-nav', !!root.querySelector('nav[aria-label="주요 메뉴"]'));
}

function show() {
  const route = resolve(location.hash);
  if (`#/${route}` !== location.hash.split('?')[0]) {
    history.replaceState(null, '', `#/${route}`);
  }
  if (current?.route === route) return paint();
  current?.logic.unmount();
  const def = screens[route];
  const logic = new def.logic();
  current = { route, logic, variant: '' };
  logic.attach(() => current?.logic === logic && paint());
  const vals = logic.renderVals() as Record<string, unknown>;
  current.variant = String(vals.$variant ?? '');
  root.replaceChildren(...Array.from(render(template(pick(def, current.variant)), vals).childNodes));
  syncNav();
  document.title = `${def.title} · invisen`;
  window.scrollTo(0, 0);
  logic.mounted(root);
}

let theme = '';
function applyPrefs() {
  const { big, light } = app.state.prefs;
  root.style.setProperty('zoom', big ? '1.15' : '');
  const next = light ? 'light' : 'dark';
  if (next === theme) return;
  theme = next;
  document.documentElement.dataset.theme = next;
  setAttrTransform(light ? toLight : null);
  if (current) current.variant = '\u0000'; // force a full re-render in the new palette
}

// Design placeholders link to "#"; keep them from resetting the route.
document.addEventListener('click', (ev) => {
  if ((ev.target as Element).closest?.('a[href="#"]')) ev.preventDefault();
});
window.addEventListener('hashchange', show);
app.subscribe(() => {
  applyPrefs();
  paint();
});
onNotificationRoute((r) => (location.hash = r));

async function boot() {
  void setupNativeChrome();
  setupNotificationTaps();
  await app.load();
  setToken(app.state.token);
  setUnauthorizedHandler(async () => {
    await stopMonitor();
    setToken(null);
    await app.persist({ token: null, onboarded: false });
    location.hash = '#/main';
  });
  applyPrefs();
  show();
  if (app.state.token) {
    try {
      app.set({ me: await api.me() });
      if (app.state.onboarded) void startMonitor();
    } catch {
      /* offline: keep going with what we have; 401 is handled above */
    }
  }
}

void boot();
