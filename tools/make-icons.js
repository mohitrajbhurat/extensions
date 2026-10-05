#!/usr/bin/env node
// Renders <ext>/icons/icon.svg to icon16/32/48/128.png using Playwright's Chromium.
// Usage: node tools/make-icons.js <extension-folder>
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const dir = path.resolve(process.argv[2] || '.');
  const svgPath = path.join(dir, 'icons', 'icon.svg');
  if (!fs.existsSync(svgPath)) { console.error('Missing ' + svgPath); process.exit(1); }
  const svg = fs.readFileSync(svgPath, 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">
      <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`);
    await page.screenshot({ path: path.join(dir, 'icons', `icon${size}.png`), omitBackground: true });
  }
  await browser.close();
  console.log('Icons written to ' + path.join(dir, 'icons'));
})();
