import './fonts';
import './styles.css';
import './motion.css';

import { compile, morphChildren, render, setAttrTransform, type Screen } from './dc';
import { toLight } from './theme';
import { screens, type ScreenDef } from './screens';
import { app } from './store';
import { api, setToken, setUnauthorizedHandler } from './api';
import { haptics, isNative, onNotificationRoute, setupNativeChrome, setupNotificationTaps } from './native';
import { startMonitor, stopMonitor } from './monitor';
import { countUp, transitionFor, type Enter } from './motion';

const root = document.getElementById('app')!;
const templates = new Map<string, HTMLTemplateElement>();
let current: { route: string; logic: Screen; variant: string; kind: Enter; loading: boolean } | null = null;

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
    enter('swap');
    syncNav();
  } else {
    morphChildren(root, box);
    countUp(root, false);
  }
  syncLoading();
}

function enter(kind: Enter) {
  const el = root.firstElementChild as HTMLElement | null;
  if (!el) return;
  el.removeAttribute('data-enter');
  void el.offsetWidth; // restart the CSS animations
  el.setAttribute('data-enter', kind);
  countUp(root, true);
}

/** Data screens stay behind a scan bar until their data arrives, then play their entrance. */
function syncLoading() {
  if (!current) return;
  const loading = current.logic.loading();
  root.firstElementChild?.toggleAttribute('data-loading', loading);
  if (current.loading && !loading) enter(current.kind);
  current.loading = loading;
}

function syncNav() {
  root.classList.toggle('has-nav', !!root.querySelector('nav[aria-label="주요 메뉴"]'));
}

function show() {
  const route = resolve(location.hash);
  if (`#${route}` !== location.hash.split("?")[0]) {
    history.replaceState(null, "", `#${route}`);
  }
  if (current?.route === route) return paint();
  const kind = transitionFor(current?.route ?? null, route);
  current?.logic.unmount();
  const def = screens[route];
  const logic = new def.logic();
  current = { route, logic, variant: '', kind, loading: false };
  logic.attach(() => current?.logic === logic && paint());
  const vals = logic.renderVals() as Record<string, unknown>;
  current.variant = String(vals.$variant ?? '');
  root.replaceChildren(...Array.from(render(template(pick(def, current.variant)), vals).childNodes));
  enter(kind);
  syncLoading();
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

// A light tick under the finger for every control (native only; SOS has its own pattern).
let lastTick = 0;
document.addEventListener('pointerdown', (ev) => {
  if (!isNative) return;
  const el = (ev.target as Element).closest?.('button:not([disabled]), a[href]');
  if (!el || el.closest('[aria-label^="SOS 긴급 호출."]')) return;
  const now = Date.now();
  if (now - lastTick < 60) return;
  lastTick = now;
  haptics.light();
});

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
    location.hash = "#main";
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
if (import.meta.env.VITE_DEMO === '1') void import('./demo/controls').then((m) => m.mountDemoControls());
