// Light theme ("밝은 화면"): the design system's light tokens (design/tokens.json),
// applied by rewriting the dark palette in rendered markup.
const DARK_TO_LIGHT: Record<string, string> = {
  '#0b0e12': '#f3f5f7', // surface / on-action
  '#13171c': '#ffffff', // surface-raised
  '#070a0d': '#e6e9ed', // surface-sunken
  '#1c2127': '#e6e9ed', // secondary button
  '#2c333b': '#c9cfd6', // line, gauge track
  '#3f4852': '#c9cfd6', // off segments
  '#5f6975': '#848e9a', // line-strong
  '#848e9a': '#5f6975', // inactive tab
  '#a9b1bb': '#5f6975', // ink-muted
  '#e3e7eb': '#13171c', // ink / action
  '#2bd8f0': '#0a8da3', // signal
  '#0d2e35': '#d6f5fa', // signal-soft
  '#34c77b': '#167a45', // safe
  '#0e2a1c': '#ddf3e6',
  '#ffbe1a': '#8f6200', // caution
  '#2e2306': '#fff1c9',
  '#ff5a4a': '#c8291e', // danger
  '#35110e': '#fde2df',
  '#ffffff12': '#ffffff',
};
const RE = new RegExp(Object.keys(DARK_TO_LIGHT).sort((a, b) => b.length - a.length).join('|'), 'gi');

export function toLight(value: string): string {
  if (!value.includes('#') && !value.includes('logo')) return value;
  return value.replace(RE, (m) => DARK_TO_LIGHT[m.toLowerCase()] ?? m).replace('./logo.svg', './logo-light.svg');
}
