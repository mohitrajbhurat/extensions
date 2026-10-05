#!/usr/bin/env node
// Developer tool: regenerates rules/*.json from lib/trackers.js, lib/entities.js and
// lib/params.js. The generated files are committed, so the extension loads without it.
// Usage: node privacy-shield/tools/build-rules.js [--check]
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const root = path.resolve(__dirname, '..');
  const { STATIC_RULESETS } = await import(pathToFileURL(path.join(root, 'lib/rules-builder.js')).href);
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const rs of STATIC_RULESETS) {
    const file = path.join(root, rs.file);
    const json = JSON.stringify(rs.build(), null, 1) + '\n';
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (current !== json) { console.error(`stale: ${rs.file}`); stale++; }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, json);
      console.log(`wrote ${rs.file} (${rs.build().length} rules)`);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('rules up to date');
})().catch((e) => { console.error(e); process.exit(1); });
