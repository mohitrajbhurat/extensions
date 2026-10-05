#!/usr/bin/env node
// End-to-end check of matching + filling on test/job-form.html.
// Usage (from repo root): node smart-autofill/test/run-test.js
// Loads a temporary copy of the extension with host access (so the test can script the tab
// without a toolbar click), seeds a profile, then previews, fills, undoes and checks learn mode.
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { chromium } = require('playwright');

const extSrc = path.resolve(__dirname, '..');
const PORT = 8765 + Math.floor(Math.random() * 500);

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'test') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

const PDF = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
const profile = {
  id: 'p1', name: 'Job hunting', kind: 'job',
  contact: { firstName: 'Jane', middleName: 'Q', lastName: 'Doe', preferredName: 'JJ', pronouns: 'She/her', email: 'jane.doe@example.com', phone: '+1 (512) 555-0134', phoneCountryCode: '+1' },
  address: { line1: '100 Congress Ave', line2: 'Apt 4', city: 'Austin', state: 'TX', postalCode: '78701', country: 'United States' },
  links: { linkedin: 'https://linkedin.com/in/janedoe', github: 'https://github.com/janedoe', portfolio: 'https://jane.dev', twitter: '' },
  auth: { authorized: 'yes', sponsorship: 'no', citizenship: 'United States', relocate: 'yes', over18: 'yes' },
  demo: { gender: 'Female', race: 'Asian', veteran: 'I am not a protected veteran', disability: 'Decline to self-identify' },
  salary: { expected: '165000', currency: 'USD' },
  misc: { availableStart: '2026-11-02', yearsExperience: '8', howHeard: 'LinkedIn', skills: 'TypeScript, Go, Kubernetes' },
  work: [
    { company: 'Globex', title: 'Staff Engineer', location: 'Austin, TX', startDate: '2021-01', endDate: '', current: true, description: 'Platform team lead' },
    { company: 'Initech', title: 'Software Engineer', location: 'Dallas, TX', startDate: '2016-06', endDate: '2020-12', current: false, description: 'Payments' },
  ],
  edu: [{ school: 'Texas A&M University', degree: "Master's", field: 'Computer Science', gpa: '3.8', startDate: '2014-08', endDate: '2016-05' }],
  qa: [
    { id: 'q1', question: 'Why do you want to work at {company}?', answer: 'I admire how {company} ships robots that matter, and my platform work fits {role}.' },
    { id: 'q2', question: 'Is there anything else you would like us to know?', answer: 'Happy to share references.' },
  ],
  files: { resume: { name: 'Jane_Doe_Resume.pdf', type: 'application/pdf', size: 60, dataUrl: PDF }, coverLetter: null },
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-'));
  const ext = path.join(tmp, 'ext');
  copyDir(extSrc, ext);
  const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['<all_urls>'];
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));

  const html = fs.readFileSync(path.join(__dirname, 'job-form.html'));
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }).listen(PORT);

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await new Promise(r => setTimeout(r, 500));
  for (const p of ctx.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();

  await sw.evaluate(async (p) => {
    await chrome.storage.local.set({ data: { version: 1, profiles: [p], activeProfileId: p.id }, siteRules: {} });
  }, profile);

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const url = `http://localhost:${PORT}/apply/acme-robotics`;
  await page.goto(url);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find(t => t.url === u).id, url);

  const results = [];
  const check = (name, actual, expected) => {
    const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
    results.push({ name, ok, actual });
  };

  // Preview
  const prev = await sw.evaluate((id) => SmartAutofill.preview(id), tabId);
  check('preview matched fields', prev.total, n => n >= 30);
  const panelShown = await page.evaluate(() => !!document.getElementById('smart-autofill-ui-host'));
  check('preview overlay injected', panelShown, true);

  // Fill from preview
  const res = await sw.evaluate((id) => SmartAutofill.fill(id, null, true), tabId);
  check('fill count', res.filled, n => n >= 30);
  check('repeatable section added', res.added, n => n >= 1);
  await page.waitForTimeout(300);

  const v = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const val = (s) => (q(s) ? q(s).value : null);
    const checked = (name) => { const r = [...document.querySelectorAll(`input[name="${name}"]`)].find(x => x.checked); return r ? r.parentElement.textContent.trim() : null; };
    const fr = document.getElementById('frame').contentDocument;
    return {
      first: val('#first_name'), last: val('#last_name'), email: val('#email'), phone: val('#phone'), loc: val('#loc'),
      addr: val('[name=addr1]'), city: val('[name=city_field]'), state: val('#st'), zip: val('[name=zip]'), country: q('#country').selectedOptions[0].text,
      resume: q('#resume').files.length ? q('#resume').files[0].name : null,
      linkedin: val('[name="urls[LinkedIn]"]'), github: val('[name="urls[GitHub]"]'), site: val('#site'),
      c0: val('#exp0c'), t0: val('#exp0t'), s0: val('#exp0s'), e0: val('#exp0e'), cur0: q('[name="experience[0][current]"]').checked,
      c1: val('#exp1c'), t1: val('#exp1t'), s1: val('#exp1s'), e1: val('#exp1e'), cur1: q('[name="experience[1][current]"]') ? q('[name="experience[1][current]"]').checked : null,
      school: val('#school'), degree: q('#degree').selectedOptions[0].text, disc: val('#disc'), gm: val('#gm'), gy: val('#gy'),
      auth: checked('q_auth'), spons: val('#spons'), why: val('#why'), salary: val('#salary'), start: val('#start'), hear: val('#hear'),
      extra: q('[contenteditable]').textContent, reactState: q('#react_state').textContent,
      pronouns: q('pronoun-field').shadowRoot.querySelector('input').value, middle: window.__closedRoot ? null : 'n/a',
      gender: val('#gender'), race: val('#race'), vet: checked('vet'),
      ifGithub: fr.getElementById('g').value, ifYears: fr.getElementById('yrs').value,
    };
  });
  // closed shadow root lives in page world; read it via an injected page script
  v.middle = await page.evaluate(() => window.__closedRoot.querySelector('input').value);

  const expect = {
    first: 'Jane', last: 'Doe', email: 'jane.doe@example.com', phone: '+1 (512) 555-0134', loc: s => /^Austin/.test(s),
    addr: '100 Congress Ave', city: 'Austin', state: 'TX', zip: '78701', country: 'United States of America', resume: 'Jane_Doe_Resume.pdf',
    linkedin: 'https://linkedin.com/in/janedoe', github: 'https://github.com/janedoe', site: 'https://jane.dev',
    c0: 'Globex', t0: 'Staff Engineer', s0: '01/2021', e0: '', cur0: true,
    c1: 'Initech', t1: 'Software Engineer', s1: '06/2016', e1: '12/2020', cur1: false,
    school: 'Texas A&M University', degree: "Master's Degree", disc: 'Computer Science', gm: 'May', gy: '2016',
    auth: 'Yes', spons: 'No', why: s => /Acme Robotics ships robots/.test(s), salary: '165000', start: '2026-11-02', hear: 'LinkedIn',
    extra: 'Happy to share references.', reactState: 'JJ', pronouns: 'She/her', middle: 'Q',
    gender: 'Female', race: 'Asian (Not Hispanic or Latino)', vet: 'I am not a protected veteran',
    ifGithub: 'https://github.com/janedoe', ifYears: '8',
  };
  for (const [k, e] of Object.entries(expect)) check('value ' + k, v[k], e);

  // Undo
  const und = await sw.evaluate((id) => SmartAutofill.undo(id), tabId);
  check('undo restored', und.restored, n => n > 20);
  check('undo cleared first name', await page.inputValue('#first_name'), '');
  check('undo cleared iframe', await page.frameLocator('#frame').locator('#g').inputValue(), '');

  // Learn mode: fill, then user corrects "Website" to their GitHub URL (a different profile value).
  await sw.evaluate((id) => SmartAutofill.fill(id, null, false), tabId);
  await page.fill('#site', 'https://github.com/janedoe');
  await page.press('#site', 'Tab');
  await page.waitForTimeout(500);
  const rules = await sw.evaluate(async () => (await chrome.storage.local.get('siteRules')).siteRules);
  const learned = Object.values(rules.localhost || {}).find(r => r.key === 'links.github');
  check('learned rule saved', !!learned, true);
  await page.reload();
  await sw.evaluate((id) => SmartAutofill.fill(id, null, false), tabId);
  check('learned rule applied on refill', await page.inputValue('#site'), 'https://github.com/janedoe');

  // Encryption round trip through the options page module
  const optPage = await ctx.newPage();
  await optPage.goto(`chrome-extension://${sw.url().split('/')[2]}/options/options.html#security`);
  const lockRes = await optPage.evaluate(async () => {
    const S = await import('../shared/store.js');
    await S.enableLock('correct horse battery');
    const raw = await chrome.storage.local.get(['data', 'vault']);
    await S.lock();
    let lockedErr = false;
    try { await S.loadData(); } catch (e) { lockedErr = !!e.locked; }
    let wrong = false;
    try { await S.unlock('nope nope nope'); } catch (e) { wrong = true; }
    await S.unlock('correct horse battery');
    const d = await S.loadData();
    const backup = await S.exportBackup('backup-pass-123');
    await S.disableLock('correct horse battery');
    const imp = await S.importBackup(backup, 'backup-pass-123', 'replace');
    return { plainGone: !raw.data, hasVault: !!raw.vault && !JSON.stringify(raw.vault).includes('Jane'), lockedErr, wrong, name: d.profiles[0].contact.firstName, imported: imp.profiles, backupEncrypted: !backup.includes('Jane') };
  });
  for (const [k, val] of Object.entries(lockRes)) check('crypto ' + k, val, k === 'name' ? 'Jane' : k === 'imported' ? 1 : true);

  check('no page errors', errors.length, 0);
  await ctx.close();
  server.close();

  let pass = 0;
  for (const r of results) {
    if (r.ok) pass++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  (got ' + JSON.stringify(r.actual) + ')'}`);
  }
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
