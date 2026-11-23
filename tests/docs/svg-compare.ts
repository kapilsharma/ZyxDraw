/**
 * Structural SVG comparison for the docs tests.
 *
 * Ignores: whitespace, attribute order, data-zyx-* attributes, xmlns, marker id names, and
 * attributes equal to their SVG default (x="0", ry equal to rx, ...). Numbers match within 0.01.
 */

export interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

export function parseXml(xml: string): XNode {
  const root: XNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z][\w:-]*)\s*>|<([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      if (stack.length > 1) stack.pop();
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
      let a: RegExpExecArray | null;
      while ((a = attrRe.exec(m[3] ?? "")) !== null) attrs[a[1]] = decode(a[2]);
      const node: XNode = { name: m[2], attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[4]) stack.push(node);
    } else if (m[5]) {
      top.text += decode(m[5]);
    }
  }
  return root;
}

function decode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** Renames ids (and url(#id) references) to m1, m2, ... in order of appearance. */
function normalizeIds(root: XNode): void {
  const ids = new Map<string, string>();
  const collect = (n: XNode) => {
    if (n.attrs.id && !ids.has(n.attrs.id)) ids.set(n.attrs.id, `m${ids.size + 1}`);
    n.children.forEach(collect);
  };
  collect(root);
  const apply = (n: XNode) => {
    for (const [k, v] of Object.entries(n.attrs)) {
      if (k === "id") n.attrs[k] = ids.get(v) ?? v;
      else n.attrs[k] = v.replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${ids.get(id) ?? id})`);
    }
    n.children.forEach(apply);
  };
  apply(root);
}

const ZERO_DEFAULTS = new Set(["x", "y", "cx", "cy", "x1", "y1", "x2", "y2"]);

function attrValue(node: XNode, key: string): string | undefined {
  const v = node.attrs[key];
  if (v !== undefined) return v;
  if (ZERO_DEFAULTS.has(key) && node.name !== "tspan") return "0";
  if ((node.name === "rect" || node.name === "ellipse") && key === "ry") return node.attrs.rx;
  if ((node.name === "rect" || node.name === "ellipse") && key === "rx") return node.attrs.ry;
  if (key === "transform") return "translate(0,0)";
  return undefined;
}

function tokens(v: string): string[] {
  return v.match(/-?\d*\.?\d+(?:e[-+]?\d+)?|[^\s,\d.-]+/gi) ?? [];
}

function sameValue(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length !== tb.length) return false;
  return ta.every((x, i) => {
    const y = tb[i];
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return Math.abs(nx - ny) < 0.01;
    return x.toLowerCase() === y.toLowerCase();
  });
}

const IGNORED = (k: string) => k.startsWith("data-zyx-") || k === "xmlns";

/** Returns null when equal, else a description of the first difference. */
export function compareSvg(actualXml: string, expectedXml: string): string | null {
  const actual = parseXml(actualXml);
  const expected = parseXml(expectedXml);
  // Compare the content inside the root <svg> of the actual output with the doc fragment.
  const actualSvg = actual.children.find((c) => c.name === "svg");
  const actualContent: XNode = { name: "#root", attrs: {}, children: actualSvg?.children ?? [], text: "" };
  normalizeIds(actualContent);
  normalizeIds(expected);
  return compareNode(actualContent, expected, "svg");
}

function compareNode(a: XNode, e: XNode, path: string): string | null {
  if (a.name !== e.name) return `${path}: expected <${e.name}>, got <${a.name}>`;
  const keys = new Set([...Object.keys(a.attrs), ...Object.keys(e.attrs)].filter((k) => !IGNORED(k)));
  for (const k of keys) {
    const av = attrValue(a, k);
    const ev = attrValue(e, k);
    if (av === undefined && ev === undefined) continue;
    if (av === undefined || ev === undefined || !sameValue(av, ev)) {
      return `${path}/${a.name}: attribute ${k}: expected ${JSON.stringify(ev)}, got ${JSON.stringify(av)}`;
    }
  }
  const at = a.text.replace(/\s+/g, " ").trim();
  const et = e.text.replace(/\s+/g, " ").trim();
  if (at !== et) return `${path}/${a.name}: text: expected ${JSON.stringify(et)}, got ${JSON.stringify(at)}`;
  if (a.children.length !== e.children.length) {
    const names = (n: XNode) => n.children.map((c) => c.name).join(", ");
    return `${path}/${a.name}: expected ${e.children.length} children (${names(e)}), got ${a.children.length} (${names(a)})`;
  }
  for (let i = 0; i < a.children.length; i++) {
    const diff = compareNode(a.children[i], e.children[i], `${path}/${a.name}[${i}]`);
    if (diff) return diff;
  }
  return null;
}
