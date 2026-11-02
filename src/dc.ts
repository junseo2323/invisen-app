// A small renderer for the design's artboard markup, so screens stay a 1:1 copy
// of the design files. Supports exactly what the design uses:
//   {{a.b}} holes in text and attributes, <sc-for list as>, <sc-if value>,
//   and on<Event>="{{fn}}" handlers. Re-renders patch the live DOM in place,
//   so a press-and-hold (SOS) survives state updates.

type Vals = Record<string, unknown>;
type Handlers = Record<string, (ev: Event) => void>;
interface HandledElement extends Element {
  __h?: Handlers;
  __bound?: Set<string>;
}

const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Optional rewrite of every rendered attribute value (used for the light theme). */
let attrTransform: ((value: string) => string) | null = null;
export const setAttrTransform = (fn: ((value: string) => string) | null) => (attrTransform = fn);
const tx = (v: string) => (attrTransform ? attrTransform(v) : v);
const WHOLE_HOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;

function lookup(scope: Vals, path: string): unknown {
  let cur: unknown = scope;
  for (const key of path.split('.')) {
    if (cur == null) return undefined;
    cur = (cur as Vals)[key];
  }
  return cur;
}

function resolve(scope: Vals, raw: string | null): unknown {
  if (raw == null) return undefined;
  const m = raw.match(WHOLE_HOLE);
  return m ? lookup(scope, m[1]) : raw;
}

function interpolate(scope: Vals, raw: string): string {
  return raw.replace(HOLE, (_, path: string) => {
    const v = lookup(scope, path);
    return v == null ? '' : String(v);
  });
}

function bind(el: HandledElement, handlers: Handlers) {
  el.__h = handlers;
  el.__bound ??= new Set();
  for (const type of Object.keys(handlers)) {
    if (el.__bound.has(type)) continue;
    el.__bound.add(type);
    el.addEventListener(type, (ev) => el.__h?.[type]?.(ev));
  }
}

function renderNode(node: Node, scope: Vals, into: Node) {
  if (node.nodeType === Node.TEXT_NODE) {
    into.appendChild(document.createTextNode(interpolate(scope, node.nodeValue ?? '')));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.localName;

  if (tag === 'sc-for') {
    const list = resolve(scope, el.getAttribute('list'));
    const as = el.getAttribute('as') ?? 'item';
    if (Array.isArray(list)) {
      list.forEach((item, index) => {
        const inner = { ...scope, [as]: item, index };
        el.childNodes.forEach((c) => renderNode(c, inner, into));
      });
    }
    return;
  }
  if (tag === 'sc-if') {
    if (resolve(scope, el.getAttribute('value'))) {
      el.childNodes.forEach((c) => renderNode(c, scope, into));
    }
    return;
  }

  const out = document.createElementNS(el.namespaceURI, el.localName) as HandledElement;
  const handlers: Handlers = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    if (name.startsWith('hint-')) continue;
    if (name.startsWith('on')) {
      const fn = resolve(scope, attr.value);
      if (typeof fn === 'function') handlers[name.slice(2)] = fn as (ev: Event) => void;
      continue;
    }
    // A whole-hole attribute that resolves to false/null/undefined is left off
    // (so disabled="{{busy}}" works); aria-* keep the literal "true"/"false".
    if (!name.startsWith('aria-') && WHOLE_HOLE.test(attr.value)) {
      const v = resolve(scope, attr.value);
      if (v === false || v == null) continue;
      out.setAttribute(name, v === true ? '' : tx(String(v)));
      continue;
    }
    out.setAttribute(name, tx(interpolate(scope, attr.value)));
  }
  if (Object.keys(handlers).length) bind(out, handlers);

  const children = el.localName === 'template' ? (el as HTMLTemplateElement).content : el;
  children.childNodes.forEach((c) => renderNode(c, scope, out));
  into.appendChild(out);
}

export function compile(markup: string): HTMLTemplateElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  return tpl;
}

export function render(tpl: HTMLTemplateElement, vals: Vals): HTMLDivElement {
  const box = document.createElement('div');
  tpl.content.childNodes.forEach((c) => renderNode(c, vals, box));
  return box;
}

// ---- in-place patching -------------------------------------------------------

function morphNode(a: Node, b: Node) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) {
    a.parentNode?.replaceChild(b, a);
    return;
  }
  if (a.nodeType === Node.TEXT_NODE) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  if (a.nodeType !== Node.ELEMENT_NODE) return;
  const ea = a as HandledElement;
  const eb = b as HandledElement;
  for (const attr of Array.from(ea.attributes)) {
    if (!eb.hasAttribute(attr.name)) ea.removeAttribute(attr.name);
  }
  for (const attr of Array.from(eb.attributes)) {
    if (ea.getAttribute(attr.name) !== attr.value) ea.setAttribute(attr.name, attr.value);
  }
  // Keep an input's live value in step with state, except while the user is typing in it.
  if (ea instanceof HTMLInputElement && eb.hasAttribute('value') && document.activeElement !== ea) {
    const v = eb.getAttribute('value') ?? '';
    if (ea.value !== v) ea.value = v;
  }
  bind(ea, eb.__h ?? {});
  morphChildren(ea, eb);
}

export function morphChildren(from: Node, to: Node) {
  const a = Array.from(from.childNodes);
  const b = Array.from(to.childNodes);
  b.forEach((node, i) => {
    if (i < a.length) morphNode(a[i], node);
    else from.appendChild(node);
  });
  for (let i = b.length; i < a.length; i++) a[i].parentNode?.removeChild(a[i]);
}

// ---- screen logic base -------------------------------------------------------

export abstract class Screen<S extends Vals = Vals> {
  state = {} as S;
  private onChange: () => void = () => {};

  attach(onChange: () => void) {
    this.onChange = onChange;
  }

  setState(patch: Partial<S>) {
    this.state = { ...this.state, ...patch };
    this.onChange();
  }

  renderVals(): Vals {
    return {};
  }

  /** Called after the screen is first put on the page. */
  mounted(_root: HTMLElement): void {}
  /** Called before navigating away. */
  unmount(): void {}
}

export class StaticScreen extends Screen {}
