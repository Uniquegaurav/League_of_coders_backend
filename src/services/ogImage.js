import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

// Link-preview images (1200x630 PNG) for WhatsApp, LinkedIn, X, Discord and Slack.
// Rendered with satori (layout -> SVG) and resvg (SVG -> PNG). Colours match the app's dark theme.
const require = createRequire(import.meta.url);
const fontDir = path.join(path.dirname(require.resolve('@fontsource/inter/package.json')), 'files');
const font = (weight) => ({
  name: 'Inter',
  weight,
  style: 'normal',
  data: readFileSync(path.join(fontDir, `inter-latin-${weight}-normal.woff`)),
});
const FONTS = [font(400), font(600), font(800)];

export const C = {
  bg: '#06070b',
  panel: '#11131b',
  line: '#262a38',
  text: '#ffffff',
  sub: '#a3a7b8',
  dim: '#6b6f80',
  brand: '#a18bff',
  brandSolid: '#7c5cff',
  neon: '#5eead4',
  easy: '#34d399',
  medium: '#fbbf24',
  hard: '#fb7185',
};

const TIERS = [
  { min: 2000, name: 'Challenger', color: '#fbbf24' },
  { min: 1800, name: 'Master', color: '#f0abfc' },
  { min: 1600, name: 'Diamond', color: '#7dd3fc' },
  { min: 1400, name: 'Platinum', color: '#5eead4' },
  { min: 1200, name: 'Gold', color: '#fcd34d' },
  { min: 1100, name: 'Silver', color: '#d4d6e0' },
  { min: 1000, name: 'Bronze', color: '#fb923c' },
  { min: 0, name: 'Recruit', color: '#a3a7b8' },
];
export const tierFor = (rating) => TIERS.find((t) => (Number(rating) || 0) >= t.min) || TIERS[TIERS.length - 1];

/** Tiny element builder so the cards read like markup without a JSX build step. */
export const h = (type, style = {}, ...children) => ({
  type,
  props: { style: { display: 'flex', ...style }, children: children.flat().filter((c) => c !== null && c !== false && c !== undefined) },
});

const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

export const avatar = (name, size = 96, ring = C.brandSolid) =>
  h(
    'div',
    {
      width: size,
      height: size,
      borderRadius: size,
      background: '#1d2030',
      border: `4px solid ${ring}`,
      alignItems: 'center',
      justifyContent: 'center',
      color: C.text,
      fontSize: size * 0.38,
      fontWeight: 800,
    },
    initials(name)
  );

export const stat = (label, value, color = C.text) =>
  h(
    'div',
    { flexDirection: 'column', padding: '18px 24px', background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, minWidth: 150 },
    h('div', { fontSize: 44, fontWeight: 800, color }, String(value)),
    h('div', { fontSize: 20, color: C.sub, marginTop: 4, textTransform: 'uppercase', letterSpacing: 2 }, label)
  );

export const chip = (text, color = C.sub) =>
  h('div', { padding: '8px 16px', borderRadius: 999, border: `1px solid ${C.line}`, background: C.panel, color, fontSize: 22, fontWeight: 600 }, text);

/** Shared frame: brand bar on top, content in the middle, call to action at the bottom. */
export const frame = (content, footer = '') =>
  h(
    'div',
    {
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
      flexDirection: 'column',
      justifyContent: 'space-between',
      background: `linear-gradient(135deg, ${C.bg} 0%, #0d0f1a 60%, #1a1238 100%)`,
      color: C.text,
      fontFamily: 'Inter',
      padding: '48px 64px',
    },
    h(
      'div',
      { width: '100%', alignItems: 'center', justifyContent: 'space-between' },
      h(
        'div',
        { alignItems: 'center', fontSize: 28, fontWeight: 800 },
        h('div', { width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg, ${C.brandSolid}, #22d3ee)`, marginRight: 14 }),
        'League',
        h('span', { color: C.medium }, 'of'),
        'Coders'
      ),
      h('div', { fontSize: 22, color: C.sub }, 'Real-time coding battles')
    ),
    h('div', { width: '100%', flexDirection: 'column' }, content),
    h('div', { width: '100%', fontSize: 24, color: C.dim }, footer)
  );

export async function renderPng(tree) {
  const svg = await satori(tree, { width: 1200, height: 630, fonts: FONTS });
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}

// Small in-memory cache: crawlers often fetch the same image several times in a row.
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

export async function cachedPng(key, build) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.png;
  const png = await renderPng(await build());
  cache.set(key, { png, at: Date.now() });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return png;
}
