// Unit tests for the pure helpers. Run: node --test design-inspector/test/unit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, toHex, toRgbString, toHslString, toOklchString, contrastRatio, wcag, rgbToOklch, oklchToRgb, colorFamily } from '../content/color.js';
import { distanceSegments } from '../content/measure.js';
import { buildTokens, toCssVariables, toJsonTokens, toTailwindConfig, spacingGrid, colorTokenName } from '../content/extract.js';
import { changesToCss, parseDeclarations } from '../content/liveedit.js';
import { extractCssUrls, guessExtension, safeFilename } from '../content/assets.js';
import { suggestFix } from '../content/eyedropper.js';

test('parseColor handles hex, short hex, alpha hex and rgb()', () => {
  assert.deepEqual(parseColor('#f60'), { r: 255, g: 102, b: 0, a: 1 });
  assert.deepEqual(parseColor('#ff660080'), { r: 255, g: 102, b: 0, a: 128 / 255 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor('transparent').a, 0);
});

test('format conversions', () => {
  const c = parseColor('#ff6600');
  assert.equal(toHex(c), '#ff6600');
  assert.equal(toRgbString(c), 'rgb(255 102 0)');
  assert.equal(toHslString(c), 'hsl(24 100% 50%)');
  assert.match(toOklchString(c), /^oklch\(69\.\d% 0\.2\d\d 4\d\.\d\)$/);
  const o = rgbToOklch(c);
  const back = oklchToRgb(o.l, o.c, o.h);
  assert.deepEqual([back.r, back.g, back.b], [255, 102, 0]);
});

test('WCAG contrast', () => {
  const black = parseColor('#000'), white = parseColor('#fff');
  assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
  const r = contrastRatio(parseColor('#777777'), white);
  assert.equal(r.toFixed(2), '4.48');
  const v = wcag(r);
  assert.equal(v.normalAA, false);
  assert.equal(v.largeAA, true);
  const fix = suggestFix(parseColor('#777777'), white, 4.5);
  assert.ok(fix && contrastRatio(parseColor(fix), white) >= 4.5, fix);
  assert.equal(suggestFix(black, white), null);
});

test('color families and token names', () => {
  assert.equal(colorFamily(parseColor('#2563eb')), 'blue');
  assert.equal(colorFamily(parseColor('#9ca3af')), 'gray');
  assert.equal(colorTokenName('#ffffff'), 'white');
  assert.match(colorTokenName('#1e3a8a'), /^blue-[789]00$/);
  assert.match(colorTokenName('#2563eb80'), /^blue-\d+-a50$/);
});

test('distanceSegments: side by side, stacked, nested', () => {
  const R = (left, top, w, hgt) => ({ left, top, right: left + w, bottom: top + hgt, width: w, height: hgt });
  const side = distanceSegments(R(0, 0, 100, 50), R(124, 0, 100, 50));
  assert.equal(side.length, 1);
  assert.equal(side[0].length, 24);
  assert.equal(side[0].axis, 'x');
  const stacked = distanceSegments(R(0, 0, 100, 50), R(0, 66, 100, 50));
  assert.deepEqual(stacked.map(s => [s.axis, s.length]), [['y', 16]]);
  const diag = distanceSegments(R(0, 0, 10, 10), R(30, 50, 10, 10));
  assert.deepEqual(diag.map(s => s.length).sort((a, b) => a - b), [20, 40]);
  const nested = distanceSegments(R(0, 0, 200, 100), R(16, 8, 100, 50));
  assert.deepEqual(nested.map(s => s.length), [8, 42, 16, 84]);
});

const scan = {
  colors: [
    { hex: '#ff6600', count: 9 }, { hex: '#1f2937', count: 30 }, { hex: '#ffffff', count: 20 }, { hex: '#2563eb', count: 4 },
  ],
  fonts: [{ family: 'Inter', stack: 'Inter, "Helvetica Neue", sans-serif', count: 40 }],
  sizes: [{ value: '16px', count: 30 }, { value: '14px', count: 10 }, { value: '32px', count: 2 }, { value: '20px', count: 3 }, { value: '12px', count: 1 }],
  weights: [{ value: '400', count: 30 }, { value: '700', count: 5 }],
  lineHeights: [{ value: '24px', count: 30 }, { value: '40px', count: 2 }],
  styles: [],
  spacing: [{ px: 16, count: 20 }, { px: 8, count: 12 }, { px: 24, count: 4 }, { px: 4, count: 2 }],
  radii: [{ value: '8px', count: 6 }, { value: '9999px', count: 2 }, { value: '4px', count: 1 }],
  shadows: [{ value: 'rgba(0, 0, 0, 0.15) 0px 2px 6px 0px', count: 3 }],
};

test('buildTokens names sizes around base and keeps values', () => {
  const t = buildTokens(scan);
  assert.deepEqual(t.fontSizes.map(s => `${s.name}=${s.value}`), ['xs=12px', 'sm=14px', 'base=16px', 'lg=20px', 'xl=32px']);
  assert.deepEqual(t.fontWeights.map(w => w.name), ['normal', 'bold']);
  assert.deepEqual(t.spacing.map(s => s.value), ['4px', '8px', '16px', '24px']);
  assert.ok(t.radii.some(r => r.name === 'full' && r.value === '9999px'));
  assert.equal(t.colors.length, 4);
  assert.deepEqual(t.fonts[0].value, ['Inter', 'Helvetica Neue', 'sans-serif']);
});

test('exports: CSS variables, DTCG JSON and Tailwind', () => {
  const t = buildTokens(scan);
  const css = toCssVariables(t, 'example.com');
  assert.match(css, /:root \{/);
  assert.match(css, /--color-orange-\d+: #ff6600;/);
  assert.match(css, /--font-inter: Inter, "Helvetica Neue", sans-serif;/);
  assert.match(css, /--space-1: 4px;/);
  const json = JSON.parse(toJsonTokens(t));
  assert.equal(json.fontSize.base.$value, '16px');
  assert.equal(json.color.white.$type, 'color');
  const tw = toTailwindConfig(t);
  assert.match(tw, /module\.exports = \{/);
  assert.match(tw, /"ds-1": "4px"/);
  // The config must be valid JavaScript.
  const mod = { exports: null };
  new Function('module', tw)(mod);
  assert.equal(mod.exports.theme.extend.fontSize.base, '16px');
});

test('spacingGrid detects an 8px grid', () => {
  assert.equal(spacingGrid([{ px: 8, count: 10 }, { px: 16, count: 10 }, { px: 4, count: 2 }]).unit, 8);
  assert.equal(spacingGrid([{ px: 4, count: 10 }, { px: 12, count: 10 }]).unit, 4);
  assert.equal(spacingGrid([{ px: 5, count: 10 }, { px: 7, count: 10 }]), null);
});

test('live edit CSS output and declaration parsing', () => {
  const css = changesToCss([
    { selector: '#title', props: new Map([['margin-top', '12px'], ['color', '#ff0000']]), text: { before: 'Old', after: 'New */ text' } },
    { selector: '.empty', props: new Map(), text: null },
  ], { source: 'example.com' });
  assert.match(css, /#title \{\n {2}margin-top: 12px;\n {2}color: #ff0000;\n\}/);
  assert.match(css, /Text in #title: "Old" → "New \* \/ text"/);
  assert.ok(!css.includes('.empty'));
  assert.equal(changesToCss([]), '');
  assert.deepEqual(parseDeclarations('display:flex; gap: 8px !important; bad; /* x: y */ --x: 1'), [['display', 'flex'], ['gap', '8px'], ['--x', '1']]);
});

test('asset helpers', () => {
  assert.deepEqual(extractCssUrls('url("a.png"), linear-gradient(red, blue), url(b.svg)'), ['a.png', 'b.svg']);
  assert.equal(guessExtension('https://x.com/img/photo.JPG?w=2'), 'jpg');
  assert.equal(guessExtension('data:image/svg+xml;charset=utf-8,%3Csvg'), 'svg');
  assert.equal(guessExtension('https://x.com/image', 'png'), 'png');
  assert.equal(safeFilename('my photo?.png', 'png'), 'my-photo.png');
  assert.equal(safeFilename('con', 'svg'), '_con.svg');
  assert.equal(safeFilename('', 'svg'), 'asset.svg');
});
