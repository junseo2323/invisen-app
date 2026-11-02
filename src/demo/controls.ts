// Demo build only: a small switch to play the safe / caution / danger scenarios.
import { setSimScenario, scenario } from '../sensor/sim';
import { app } from '../store';
import { refreshStatus } from '../monitor';

export function mountDemoControls() {
  const bar = document.createElement('div');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', '데모 상황 바꾸기');
  bar.style.cssText =
    'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom));z-index:50;display:flex;gap:2px;padding:3px;background:rgba(11,14,18,.88);border:1px solid #3f4852;font:600 12px/1 "IBM Plex Sans KR",system-ui,sans-serif;backdrop-filter:blur(6px)';
  const label = document.createElement('span');
  label.textContent = '데모';
  label.style.cssText = 'display:flex;align-items:center;padding:0 8px;color:#a9b1bb';
  bar.append(label);
  const opts = [
    ['safe', '안전', '#34c77b'],
    ['caution', '주의', '#ffbe1a'],
    ['danger', '위험', '#ff5a4a'],
  ] as const;
  const buttons = opts.map(([key, text, color]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = `height:32px;padding:0 12px;border:0;border-radius:0;font:inherit;cursor:pointer;color:${color}`;
    b.onclick = () => {
      setSimScenario(key);
      void refreshStatus();
      paint();
    };
    bar.append(b);
    return [key, b] as const;
  });
  const paint = () => {
    const on = scenario();
    for (const [key, b] of buttons) b.style.background = key === on ? '#2c333b' : 'transparent';
    const inApp = app.state.onboarded && !/alert-danger|sos/.test(location.hash);
    bar.style.display = inApp ? 'flex' : 'none';
  };
  document.body.append(bar);
  app.subscribe(paint);
  window.addEventListener('hashchange', paint);
  paint();
}
