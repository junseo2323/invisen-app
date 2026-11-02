import '@fontsource/ibm-plex-sans-kr/400.css';
import '@fontsource/ibm-plex-sans-kr/600.css';
import '@fontsource/ibm-plex-sans-kr/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles.css';

import { compile, morphChildren, render, type Screen } from './dc';
import { screens } from './screens';
import { session } from './store';
import { setupNativeChrome } from './native';

const app = document.getElementById('app')!;
const templates = new Map<string, HTMLTemplateElement>();
let current: { route: string; logic: Screen } | null = null;

function routeFromHash(): string {
  const r = location.hash.replace(/^#\/?/, '');
  if (screens[r]) return r;
  return session.onboarded ? 'home' : 'main';
}

function show(route: string) {
  const def = screens[route];
  current?.logic.unmount();

  // Entering home marks onboarding done; the start screen (logout in 전체) clears it.
  if (route === 'home') session.onboarded = true;
  if (route === 'main') session.onboarded = false;

  if (!templates.has(route)) templates.set(route, compile(def.markup));
  const tpl = templates.get(route)!;
  const logic = new def.logic();
  const paint = () => {
    if (current?.logic !== logic) return;
    morphChildren(app, render(tpl, logic.renderVals()));
  };
  logic.attach(paint);
  current = { route, logic };

  app.replaceChildren(...Array.from(render(tpl, logic.renderVals()).childNodes));
  app.classList.toggle('has-nav', !!app.querySelector('nav[aria-label="주요 메뉴"]'));
  document.title = `${def.title} · invisen`;
  window.scrollTo(0, 0);
  logic.mounted(app);
}

window.addEventListener('hashchange', () => show(routeFromHash()));

// Design placeholders link to "#"; keep them from resetting the route.
document.addEventListener('click', (ev) => {
  const a = (ev.target as Element).closest?.('a[href="#"]');
  if (a) ev.preventDefault();
});

void setupNativeChrome();
show(routeFromHash());
