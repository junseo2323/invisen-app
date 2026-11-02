// invisen 관리자 대시보드 (web, served at /admin/).
// Same renderer as the worker app: each route is one design artboard + its logic.
import '../../src/fonts';
import '../../src/motion.css';
import './admin.css';

import { compile, morphChildren, render, type Screen } from '../../src/dc';
import { countUp } from '../../src/motion';
import { api, hasToken, setUnauthorizedHandler } from './api';
import { refreshPending, session } from './session';
import * as L from './logic';

import LoginHtml from './markup/Login.html?raw';
import SitesHtml from './markup/Sites.html?raw';
import HomeHtml from './markup/Home.html?raw';
import WorkersHtml from './markup/Workers.html?raw';
import WorkerHtml from './markup/Worker.html?raw';
import AlertsHtml from './markup/Alerts.html?raw';
import ReportsHtml from './markup/Reports.html?raw';
import SensorsHtml from './markup/Sensors.html?raw';
import SettingsHtml from './markup/Settings.html?raw';

type Access = 'public' | 'signed-in' | 'site';
interface Route {
  title: string;
  markup: string;
  make: (param: string) => Screen;
  access: Access;
}

const routes: Record<string, Route> = {
  login: { title: '로그인', markup: LoginHtml, make: () => new L.Login(), access: 'public' },
  sites: { title: '현장 선택', markup: SitesHtml, make: () => new L.Sites(), access: 'signed-in' },
  home: { title: '관제 홈', markup: HomeHtml, make: () => new L.Home(), access: 'site' },
  workers: { title: '작업자', markup: WorkersHtml, make: () => new L.Workers(), access: 'site' },
  worker: { title: '작업자 상세', markup: WorkerHtml, make: (id) => new L.Worker(Number(id)), access: 'site' },
  alerts: { title: '알림', markup: AlertsHtml, make: () => new L.Alerts(), access: 'site' },
  reports: { title: '보고서', markup: ReportsHtml, make: () => new L.Reports(), access: 'site' },
  sensors: { title: '센서', markup: SensorsHtml, make: () => new L.Sensors(), access: 'site' },
  settings: { title: '설정', markup: SettingsHtml, make: () => new L.SettingsScreen(), access: 'site' },
};

const root = document.getElementById('admin')!;
const templates = new Map<string, HTMLTemplateElement>();
const template = (markup: string) => templates.get(markup) ?? templates.set(markup, compile(markup)).get(markup)!;
let current: { key: string; name: string; logic: Screen; loading: boolean } | null = null;

/** "#worker-12?x" → { name: 'worker', param: '12' } */
function parse(hash: string) {
  const h = hash.replace(/^#\/?/, '').split('?')[0];
  const m = h.match(/^worker-(\d+)$/);
  return m ? { name: 'worker', param: m[1], key: h } : { name: h, param: '', key: h };
}

/** Where the visitor may go right now. */
function resolve(hash: string): { name: string; param: string; key: string } {
  const r = parse(hash);
  const def = routes[r.name];
  if (!hasToken()) return { name: 'login', param: '', key: 'login' };
  if (!def || def.access === 'public') return session.state.siteId ? { name: 'home', param: '', key: 'home' } : { name: 'sites', param: '', key: 'sites' };
  if (def.access === 'site' && !session.state.siteId) return { name: 'sites', param: '', key: 'sites' };
  if (r.name === 'worker' && !r.param) return { name: 'workers', param: '', key: 'workers' };
  return r;
}

function paint() {
  if (!current) return;
  const box = render(template(routes[current.name].markup), current.logic.renderVals() as Record<string, unknown>);
  morphChildren(root, box);
  countUp(root, false);
  syncLoading();
  syncBanner();
}

function enter() {
  const el = root.firstElementChild as HTMLElement | null;
  if (!el) return;
  el.removeAttribute('data-enter');
  void el.offsetWidth;
  el.setAttribute('data-enter', current && routes[current.name].access === 'site' ? 'tab' : 'swap');
  countUp(root, true);
}

function syncLoading() {
  if (!current) return;
  const loading = current.logic.loading();
  root.firstElementChild?.toggleAttribute('data-loading', loading);
  if (current.loading && !loading) enter();
  current.loading = loading;
}

/** Default password reminder, on every signed-in screen until it's changed. */
function syncBanner() {
  let el = document.getElementById('admin-banner');
  const show = !!session.state.admin?.mustChangePassword && current?.name !== 'login';
  if (!show) return el?.remove();
  if (!el) {
    el = document.createElement('div');
    el.id = 'admin-banner';
    el.setAttribute('role', 'alert');
    el.innerHTML = '<span>처음 받은 비밀번호를 쓰고 있어요. 다른 사람이 들어오지 못하게 지금 바꿔 주세요.</span><a href="#settings?pw">비밀번호 바꾸기</a>';
    document.body.prepend(el);
  }
}

function show() {
  const r = resolve(location.hash);
  if (`#${r.key}` !== location.hash.split('?')[0]) history.replaceState(null, '', `#${r.key}`);
  if (current?.key === r.key) {
    // banner link while already on settings: open the password dialog
    if (current.logic instanceof L.SettingsScreen && location.hash.includes('?pw')) current.logic.openPasswordDialog();
    return paint();
  }
  current?.logic.unmount();
  const def = routes[r.name];
  const logic = def.make(r.param);
  current = { key: r.key, name: r.name, logic, loading: false };
  logic.attach(() => current?.logic === logic && paint());
  root.replaceChildren(...Array.from(render(template(def.markup), logic.renderVals() as Record<string, unknown>).childNodes));
  document.body.dataset.screen = r.name;
  document.title = `${def.title} · invisen 관리자`;
  enter();
  syncLoading();
  syncBanner();
  window.scrollTo(0, 0);
  logic.mounted(root);
}

// Design placeholders link to "#"; keep them from resetting the route.
document.addEventListener('click', (ev) => {
  if ((ev.target as Element).closest?.('a[href="#"]')) ev.preventDefault();
});
window.addEventListener('hashchange', show);
session.subscribe(paint);
setUnauthorizedHandler(() => {
  session.set({ admin: null });
  location.hash = '#login';
});

// badge in the sidebar: pending alerts, every 30 s
setInterval(() => !document.hidden && current && routes[current.name].access === 'site' && void refreshPending(), 30_000);

async function boot() {
  if (hasToken()) {
    try {
      session.set({ admin: await api.me() });
    } catch {
      /* 401 → handler above sends us to login; offline → keep going */
    }
  }
  show();
}
void boot();
