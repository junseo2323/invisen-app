// JS side of the motion system: numbers count up (mono digits tick like an instrument),
// and the router picks a transition from where you came from and where you're going.

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const lastValue = new WeakMap<Element, number>();
const frame = new WeakMap<Element, number>();
const outCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Animates every [data-count] number: from 0 when a screen appears, from the old value when it changes. */
export function countUp(root: ParentNode, entry: boolean) {
  root.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const text = node.nodeValue ?? '';
    const m = text.match(/-?\d+(?:\.(\d+))?/);
    if (!m) {
      lastValue.delete(el);
      return;
    }
    const target = parseFloat(m[0]);
    const decimals = m[1]?.length ?? 0;
    const prev = lastValue.get(el);
    lastValue.set(el, target);
    const from = prev ?? (entry ? 0 : target);
    if (from === target || reduced()) return;
    cancelAnimationFrame(frame.get(el) ?? 0);
    const duration = prev == null ? 900 : 450;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = from + (target - from) * outCubic(t);
      // the renderer may have swapped the text node meanwhile: always write to the current one
      const n = el.firstChild;
      if (n && n.nodeType === Node.TEXT_NODE) n.nodeValue = text.replace(m[0], v.toFixed(decimals));
      if (t < 1) frame.set(el, requestAnimationFrame(step));
    };
    frame.set(el, requestAnimationFrame(step));
  });
}

const TABS = ['home', 'home-caution', 'site', 'exposure', 'log', 'more'];
const FLOW = ['main', 'login-phone', 'login-profile', 'login-sensor', 'login-wear'];
const MODALS = ['sos', 'alert-danger'];

export type Enter = 'push' | 'pop' | 'tab' | 'modal' | 'swap';

export function transitionFor(from: string | null, to: string): Enter {
  if (!from) return 'tab';
  if (MODALS.includes(to)) return 'modal';
  if (MODALS.includes(from)) return 'swap';
  if (TABS.includes(from) && TABS.includes(to)) return 'tab';
  const fi = FLOW.indexOf(from);
  const ti = FLOW.indexOf(to);
  if (fi >= 0 && ti >= 0) return ti > fi ? 'push' : 'pop';
  if (to === 'sensor') return 'push';
  if (from === 'sensor') return 'pop';
  return 'tab';
}
