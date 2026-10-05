// Smart Autofill filler: turns a profile + field key into a concrete value and writes it into
// a control in a way that frameworks (React, Vue, Angular) notice.
(function () {
  'use strict';
  if (globalThis.__SA_filler) return;
  const M = globalThis.__SA_matcher;
  const { norm, byKey } = M;

  // ---------- reference tables ----------
  const US_STATES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
    DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
    NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
    // Canadian provinces
    AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia',
    ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan',
  };
  const COUNTRIES = [
    ['US', 'USA', 'United States', 'United States of America', 'America', 'U.S.', 'U.S.A.'],
    ['GB', 'GBR', 'United Kingdom', 'UK', 'Great Britain', 'England', 'Britain'],
    ['CA', 'CAN', 'Canada'], ['IN', 'IND', 'India'], ['DE', 'DEU', 'Germany', 'Deutschland'], ['FR', 'FRA', 'France'],
    ['AU', 'AUS', 'Australia'], ['NZ', 'NZL', 'New Zealand'], ['IE', 'IRL', 'Ireland'], ['NL', 'NLD', 'Netherlands', 'Holland'],
    ['ES', 'ESP', 'Spain'], ['IT', 'ITA', 'Italy'], ['MX', 'MEX', 'Mexico'], ['BR', 'BRA', 'Brazil'], ['CN', 'CHN', 'China'],
    ['JP', 'JPN', 'Japan'], ['KR', 'KOR', 'South Korea', 'Korea, Republic of', 'Republic of Korea'], ['SG', 'SGP', 'Singapore'],
    ['SE', 'SWE', 'Sweden'], ['NO', 'NOR', 'Norway'], ['DK', 'DNK', 'Denmark'], ['FI', 'FIN', 'Finland'], ['CH', 'CHE', 'Switzerland'],
    ['AT', 'AUT', 'Austria'], ['BE', 'BEL', 'Belgium'], ['PL', 'POL', 'Poland'], ['PT', 'PRT', 'Portugal'], ['IL', 'ISR', 'Israel'],
    ['AE', 'ARE', 'United Arab Emirates', 'UAE'], ['PK', 'PAK', 'Pakistan'], ['BD', 'BGD', 'Bangladesh'], ['PH', 'PHL', 'Philippines'],
    ['NG', 'NGA', 'Nigeria'], ['ZA', 'ZAF', 'South Africa'], ['AR', 'ARG', 'Argentina'], ['CO', 'COL', 'Colombia'], ['CL', 'CHL', 'Chile'],
    ['UA', 'UKR', 'Ukraine'], ['RO', 'ROU', 'Romania'], ['VN', 'VNM', 'Vietnam', 'Viet Nam'], ['ID', 'IDN', 'Indonesia'], ['TR', 'TUR', 'Turkey', 'Türkiye'],
  ];
  const SYNONYMS = [
    ['male', 'man', 'm'], ['female', 'woman', 'f'],
    ['non binary', 'nonbinary', 'genderqueer', 'gender non conforming', 'non conforming'],
    ['decline', 'decline to self identify', 'prefer not to say', 'prefer not to answer', 'i dont wish to answer', 'i do not wish to answer', 'choose not to disclose', 'decline to answer', 'i prefer not to disclose', 'do not wish to disclose', 'not specified'],
    ['bachelors', 'bachelor', 'bachelors degree', 'bachelor of science', 'bachelor of arts', 'ba', 'bs', 'bsc', 'b s', 'b a', 'b tech', 'btech', 'be', 'b e', 'undergraduate'],
    ['masters', 'master', 'masters degree', 'master of science', 'master of arts', 'ms', 'ma', 'msc', 'm s', 'm a', 'm tech', 'mtech', 'meng'],
    ['mba', 'master of business administration'],
    ['doctorate', 'phd', 'ph d', 'doctor of philosophy', 'doctoral'],
    ['associate', 'associates', 'associates degree', 'aa', 'as'],
    ['high school', 'high school diploma', 'secondary school', 'ged'],
    ['i am not a protected veteran', 'not a protected veteran', 'not a veteran', 'no military service', 'i am not a veteran'],
    ['i identify as one or more of the classifications of protected veteran', 'protected veteran', 'i am a protected veteran', 'veteran'],
    ['no i dont have a disability', 'no i do not have a disability', 'i do not have a disability', 'no disability', 'no, i don\'t have a disability and have not had one in the past'],
    ['yes i have a disability', 'i have a disability', 'yes i have a disability or have had one in the past'],
    ['white', 'caucasian', 'white not hispanic or latino'],
    ['black', 'black or african american', 'african american'],
    ['asian', 'asian not hispanic or latino'],
    ['hispanic or latino', 'hispanic', 'latino', 'latinx'],
    ['two or more races', 'multiracial', 'two or more'],
    ['remote', 'fully remote', 'work from home', 'remote only'], ['on site', 'onsite', 'in office', 'in person'], ['hybrid'],
    ['linkedin', 'linked in'], ['referral', 'employee referral', 'referred by employee', 'friend'], ['job board', 'indeed', 'glassdoor'],
    ['usd', 'us dollar', '$'], ['eur', 'euro'], ['gbp', 'pound', 'british pound'], ['inr', 'rupee', 'indian rupee'],
    ['he him', 'he him his'], ['she her', 'she her hers'], ['they them', 'they them theirs'],
  ];
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  // ---------- profile values ----------
  function currentJob(p) {
    const w = (p.work || []).filter(j => j && (j.company || j.title));
    return w.find(j => j.current) || w[0] || {};
  }
  function applyTemplate(text, ctx, p) {
    const c = p.contact || {};
    const map = {
      company: ctx.company || 'your company', role: ctx.role || 'this role', position: ctx.role || 'this role',
      name: [c.firstName, c.lastName].filter(Boolean).join(' '), first_name: c.firstName || '', firstname: c.firstName || '',
      date: new Date().toLocaleDateString(), years: (p.misc && p.misc.yearsExperience) || '',
      current_company: currentJob(p).company || '', current_title: currentJob(p).title || '',
    };
    return String(text || '').replace(/\{\{?\s*([a-z_]+)\s*\}?\}/gi, (m, k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : m));
  }
  function valueFor(profile, key, index, ctx) {
    const p = profile || {};
    const [g, f] = key.split('.');
    if (g === 'work' || g === 'edu') {
      const list = (p[g] || []).filter(e => e && Object.values(e).some(v => v && v !== false));
      const e = list[index || 0];
      return e ? e[f] : undefined;
    }
    if (g === 'qa') {
      const qa = (p.qa || []).find(q => q.id === f);
      return qa ? applyTemplate(qa.answer, ctx || {}, p) : undefined;
    }
    if (g === 'files') return p.files ? p.files[f] : undefined;
    const c = p.contact || {}, a = p.address || {};
    switch (key) {
      case 'contact.fullName': return [c.firstName, c.middleName, c.lastName].filter(Boolean).join(' ');
      case 'contact.emailConfirm': return c.email;
      case 'contact.preferredName': return c.preferredName || c.firstName;
      case 'address.location': return [a.city, a.state].filter(Boolean).join(', ') + (a.country && !/^(us|usa|united states)/i.test(a.country) ? ', ' + a.country : '');
      case 'misc.currentCompany': return currentJob(p).company;
      case 'misc.currentTitle': return currentJob(p).title;
      case 'misc.coverLetterText': return applyTemplate((p.misc || {}).coverLetterText, ctx || {}, p);
      case 'misc.summary': return applyTemplate((p.misc || {}).summary, ctx || {}, p);
    }
    return p[g] ? p[g][f] : undefined;
  }
  function isEmptyValue(v) {
    return v == null || v === '' || (typeof v === 'object' && !v.dataUrl);
  }

  // Every scalar value in a profile, for learn mode lookups.
  function flatten(profile) {
    const out = [];
    for (const def of globalThis.SmartAutofillFields.FIELDS) {
      if (def.group === 'work' || def.group === 'edu' || def.group === 'files') continue;
      const v = valueFor(profile, def.key, 0);
      if (typeof v === 'string' && v.trim()) out.push({ key: def.key, index: 0, value: v });
    }
    for (const g of ['work', 'edu']) {
      (profile[g] || []).filter(e => e && Object.values(e).some(v => v && v !== false)).forEach((e, i) => {
        for (const [f, v] of Object.entries(e || {})) if (typeof v === 'string' && v.trim()) out.push({ key: g + '.' + f, index: i, value: v });
      });
    }
    (profile.qa || []).forEach(q => { if (q.answer) out.push({ key: 'qa.' + q.id, index: 0, value: q.answer }); });
    return out;
  }

  // ---------- value shaping ----------
  function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (m) return { y: +m[1], m: +m[2], d: m[3] ? +m[3] : null };
    m = s.match(/^(\d{1,2})\/(\d{4})$/);
    if (m) return { y: +m[2], m: +m[1], d: null };
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return { y: +m[3], m: +m[1], d: +m[2] };
    m = s.match(/^(\d{4})$/);
    if (m) return { y: +m[1], m: 1, d: null };
    if (/present|current|now/i.test(s)) return { present: true };
    const t = Date.parse(s);
    if (!isNaN(t)) { const dt = new Date(t); return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() }; }
    return null;
  }
  const pad = n => String(n).padStart(2, '0');
  function datePart(desc) {
    const t = norm(desc.label + ' ' + desc.aria + ' ' + desc.placeholder + ' ' + desc.nameid);
    const hasM = /\bmonth\b|\bmm\b|\bmo\b/.test(t), hasY = /\byear\b|\byyyy\b|\byy\b|\byr\b/.test(t);
    if (hasM && !hasY) return 'month';
    if (hasY && !hasM && !/\bdd\b|\bday\b/.test(t)) return 'year';
    return 'full';
  }
  function formatDateFor(el, kind, desc, raw) {
    const p = parseDate(raw);
    if (!p || p.present) return p && p.present ? '' : String(raw || '');
    const d = p.d || 1;
    if (kind === 'date') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'month') return `${p.y}-${pad(p.m)}`;
      if (t === 'week') return `${p.y}-W01`;
      if (t === 'datetime-local') return `${p.y}-${pad(p.m)}-${pad(d)}T09:00`;
      return `${p.y}-${pad(p.m)}-${pad(d)}`;
    }
    const part = datePart(desc);
    if (part === 'month') return String(p.m);
    if (part === 'year') return String(p.y);
    const hint = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('pattern') || '') + ' ' + desc.label).toLowerCase();
    if (/yyyy-mm-dd/.test(hint)) return `${p.y}-${pad(p.m)}-${pad(d)}`;
    if (/dd\/mm\/yyyy|dd\.mm\.yyyy/.test(hint)) return `${pad(d)}/${pad(p.m)}/${p.y}`;
    if (/mm\/dd\/yyyy|mm\/dd\/yy/.test(hint)) return `${pad(p.m)}/${pad(d)}/${p.y}`;
    if (/mm\/yyyy|mm \/ yyyy|mm-yyyy/.test(hint)) return `${pad(p.m)}/${p.y}`;
    if (/mm\/yy\b/.test(hint)) return `${pad(p.m)}/${String(p.y).slice(2)}`;
    if (/yyyy-mm/.test(hint)) return `${p.y}-${pad(p.m)}`;
    if (/\byyyy\b/.test(hint) && !/mm/.test(hint)) return String(p.y);
    return p.d ? `${pad(p.m)}/${pad(p.d)}/${p.y}` : `${pad(p.m)}/${p.y}`;
  }
  function yesNo(v) {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    const s = norm(v);
    if (!s) return '';
    if (/^(yes|y|true|1)\b/.test(s)) return 'yes';
    if (/^(no|n|false|0)\b/.test(s)) return 'no';
    return s;
  }
  function textValue(el, kind, desc, def, raw) {
    if (def && def.type === 'date') return formatDateFor(el, kind, desc, raw);
    if (def && (def.type === 'yesno' || def.type === 'bool')) {
      const yn = yesNo(raw);
      return yn === 'yes' ? 'Yes' : yn === 'no' ? 'No' : String(raw);
    }
    let v = String(raw == null ? '' : raw);
    const type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    if (def && def.type === 'phone') {
      const max = el.maxLength > 0 ? el.maxLength : 0;
      if (type === 'number' || (max && max <= 11) || /^\[?\\d|\d\{/.test(el.getAttribute('pattern') || '')) v = v.replace(/\D/g, '').slice(-(max || 15));
    }
    if (def && def.type === 'number' || type === 'number') {
      if (type === 'number') {
        const n = v.replace(/[^\d.\-]/g, '');
        v = n;
      }
    }
    if (def && def.key === 'misc.skills' && Array.isArray(raw)) v = raw.join(', ');
    if (el.maxLength > 0 && v.length > el.maxLength) v = v.slice(0, el.maxLength);
    return v;
  }

  // ---------- option matching ----------
  function bigrams(s) { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); } return out; }
  function dice(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0;
    for (const [k, n] of A) inter += Math.min(n, B.get(k) || 0);
    return (2 * inter) / (a.length - 1 + b.length - 1);
  }
  function expandCandidates(value, def) {
    const v = norm(value);
    const out = new Set([v]);
    if (!v) return [];
    if (def && def.type === 'state') {
      const up = String(value).trim().toUpperCase();
      if (US_STATES[up]) out.add(norm(US_STATES[up]));
      for (const [ab, name] of Object.entries(US_STATES)) if (norm(name) === v) out.add(ab.toLowerCase());
    }
    if (def && (def.type === 'country' || def.key === 'address.country' || def.key === 'auth.citizenship')) {
      for (const row of COUNTRIES) if (row.some(n => norm(n) === v)) row.forEach(n => out.add(norm(n)));
      if (def.key === 'auth.citizenship') for (const n of [...out]) { out.add(n + 'n'); out.add(n + 'ian'); }
    }
    for (const group of SYNONYMS) {
      if (group.some(g => norm(g) === v)) group.forEach(g => out.add(norm(g)));
    }
    return [...out].filter(Boolean);
  }
  function polarity(text) {
    const s = norm(text);
    if (/^(no|n|false|i am not|im not|i do not|i dont|i will not|i wont|i have not|i havent|not)\b/.test(s)) return 'no';
    if (/^(yes|y|true|i am|im|i do|i will|i have|i can|authorized|eligible)\b/.test(s)) return 'yes';
    return null;
  }
  function optionScore(optText, cands) {
    const o = norm(optText);
    if (!o) return 0;
    let best = 0;
    for (const c of cands) {
      let s = 0;
      if (o === c) s = 1;
      else if (c.length >= 2 && (o.startsWith(c + ' ') || o.endsWith(' ' + c))) s = 0.86;
      else if (c.length >= 3 && (' ' + o + ' ').includes(' ' + c + ' ')) s = 0.78;
      else if (o.length >= 3 && (' ' + c + ' ').includes(' ' + o + ' ')) s = 0.72;
      else s = dice(o, c) * 0.8;
      if (s > best) best = s;
    }
    return best;
  }
  // Pick the best option index from [{text, value}] for the value; returns -1 if nothing fits.
  function chooseOption(options, raw, def, desc) {
    if (raw == null || raw === '') return -1;
    // Dates in selects: month / year parts.
    if (def && def.type === 'date') {
      const p = parseDate(raw);
      if (!p || p.present) return -1;
      const part = desc ? datePart(desc) : 'full';
      const looksMonth = options.filter(o => MONTHS.some(m => norm(o.text).startsWith(m.slice(0, 3)))).length >= 6;
      const looksYear = options.filter(o => /^\d{4}$/.test(String(o.text).trim())).length >= 3;
      if (part === 'month' || (looksMonth && !looksYear)) {
        const name = MONTHS[p.m - 1];
        return options.findIndex(o => { const t = norm(o.text), v = norm(o.value); return t === name || t === name.slice(0, 3) || t === String(p.m) || t === pad(p.m) || v === String(p.m) || v === pad(p.m); });
      }
      if (part === 'year' || looksYear) return options.findIndex(o => String(o.text).trim() === String(p.y) || String(o.value).trim() === String(p.y));
      return -1;
    }
    const isYesNo = def && (def.type === 'yesno' || def.type === 'bool');
    if (isYesNo) {
      const want = yesNo(raw);
      if (want === 'yes' || want === 'no') {
        const idx = options.findIndex(o => polarity(o.text) === want || polarity(o.value) === want);
        if (idx >= 0) return idx;
      }
    }
    const values = Array.isArray(raw) ? raw : [raw];
    let bestIdx = -1, bestScore = 0;
    for (const val of values) {
      const cands = expandCandidates(val, def);
      options.forEach((o, i) => {
        if (o.placeholder) return;
        const s = Math.max(optionScore(o.text, cands), optionScore(o.value, cands) * 0.95);
        if (s > bestScore) { bestScore = s; bestIdx = i; }
      });
    }
    return bestScore >= 0.6 ? bestIdx : -1;
  }

  // ---------- writing to the DOM ----------
  function fire(el, type, init = {}) {
    let ev;
    if (type === 'input') {
      try { ev = new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: init.data == null ? null : String(init.data) }); }
      catch (e) { ev = new Event('input', { bubbles: true, composed: true }); }
    } else if (type === 'focus' || type === 'blur') {
      ev = new FocusEvent(type, { bubbles: false, composed: true });
    } else if (type === 'focusin' || type === 'focusout') {
      ev = new FocusEvent(type, { bubbles: true, composed: true });
    } else if (type === 'keydown' || type === 'keyup') {
      ev = new KeyboardEvent(type, { bubbles: true, composed: true, key: init.key || 'Unidentified' });
    } else {
      ev = new Event(type, { bubbles: true, composed: true });
    }
    el.dispatchEvent(ev);
  }
  function protoFor(el) {
    if (el instanceof HTMLTextAreaElement) return HTMLTextAreaElement.prototype;
    if (el instanceof HTMLSelectElement) return HTMLSelectElement.prototype;
    return HTMLInputElement.prototype;
  }
  // Sets value through the prototype setter so React's value tracker sees a change.
  function setNativeValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(protoFor(el), 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function setText(el, value) {
    try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    fire(el, 'focusin');
    setNativeValue(el, value);
    fire(el, 'input', { data: value });
    fire(el, 'change');
    fire(el, 'keyup', { key: 'Unidentified' });
    fire(el, 'focusout');
    try { el.blur(); } catch (e) { /* ignore */ }
    fire(el, 'blur');
    return String(el.value) === String(value) || el.value !== '';
  }
  function setSelect(el, index) {
    if (index < 0 || index >= el.options.length) return false;
    const opt = el.options[index];
    setNativeValue(el, opt.value);
    if (el.selectedIndex !== index) el.selectedIndex = index;
    opt.selected = true;
    fire(el, 'input');
    fire(el, 'change');
    fire(el, 'blur');
    return true;
  }
  function setChecked(el, checked) {
    if (el.checked === checked) return true;
    el.click();
    if (el.checked !== checked) {
      // Some frameworks swallow clicks on visually hidden inputs; set directly.
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      desc.set.call(el, checked);
      fire(el, 'input');
      fire(el, 'change');
    }
    return el.checked === checked;
  }
  function setContentEditable(el, value) {
    try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    let ok = false;
    try {
      const sel = el.ownerDocument.getSelection();
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      ok = el.ownerDocument.execCommand('insertText', false, value);
    } catch (e) { ok = false; }
    if (!ok || norm(el.textContent) !== norm(value)) {
      el.textContent = value;
      fire(el, 'input', { data: value });
    }
    fire(el, 'change');
    try { el.blur(); } catch (e) { /* ignore */ }
    return true;
  }
  function dataUrlToFile(f) {
    const [head, b64] = String(f.dataUrl).split(',');
    const mime = (head.match(/data:([^;]+)/) || [])[1] || f.type || 'application/octet-stream';
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], f.name || 'file', { type: mime, lastModified: f.lastModified || Date.now() });
  }
  function acceptsFile(el, file) {
    const accept = (el.getAttribute('accept') || '').trim();
    if (!accept) return true;
    const name = file.name.toLowerCase();
    return accept.split(',').map(s => s.trim().toLowerCase()).some(a => {
      if (!a) return false;
      if (a.startsWith('.')) return name.endsWith(a);
      if (a.endsWith('/*')) return file.type.startsWith(a.slice(0, -1));
      return file.type === a;
    });
  }
  function setFile(el, fileRef) {
    if (!fileRef || !fileRef.dataUrl) return { ok: false, reason: 'No file in profile' };
    const file = dataUrlToFile(fileRef);
    if (!acceptsFile(el, file)) return { ok: false, reason: 'File type not accepted here' };
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      fire(el, 'input');
      fire(el, 'change');
      // Drop zones listen for drop events on a wrapper.
      return { ok: el.files && el.files.length === 1 };
    } catch (e) {
      return { ok: false, reason: 'Browser blocked file attach' };
    }
  }

  // ARIA combobox (react-select, Workday style): type then click the matching option.
  async function setCombobox(el, value) {
    setText(el, value);
    try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    fire(el, 'keydown', { key: 'ArrowDown' });
    const deadline = Date.now() + 900;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 120));
      const listId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      const root = (listId && document.getElementById(listId)) || document;
      const opts = [...root.querySelectorAll('[role=option]')].filter(o => M.isVisible(o));
      if (opts.length) {
        const idx = chooseOption(opts.map(o => ({ text: o.textContent, value: o.getAttribute('data-value') || '' })), value, null);
        if (idx >= 0) {
          opts[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          opts[idx].click();
          return true;
        }
        break;
      }
    }
    return el.value !== '';
  }

  // Snapshot a control so undo can restore it.
  function snapshot(entry) {
    return entry.els.map(el => {
      if (entry.kind === 'contenteditable') return { el, html: el.innerHTML };
      if (el.type === 'checkbox' || el.type === 'radio') return { el, checked: el.checked };
      if (el.type === 'file') return { el, file: true };
      return { el, value: el.value };
    });
  }
  function restore(snaps) {
    for (const s of snaps) {
      const el = s.el;
      if (!el.isConnected) continue;
      if ('html' in s) { el.innerHTML = s.html; fire(el, 'input'); continue; }
      if ('checked' in s) { if (el.checked !== s.checked) setChecked(el, s.checked); continue; }
      if (s.file) { try { el.files = new DataTransfer().files; fire(el, 'change'); } catch (e) { /* ignore */ } continue; }
      if (el.tagName === 'SELECT') { setNativeValue(el, s.value); fire(el, 'input'); fire(el, 'change'); continue; }
      setText(el, s.value);
    }
  }

  // Apply a value to an entry. Returns {ok, reason, shown}.
  async function apply(entry, key, raw, ctx) {
    const def = byKey[key] || (key.startsWith('qa.') ? { key, type: 'longtext' } : null);
    const desc = M.describe(entry);
    const el = entry.el;
    if (isEmptyValue(raw) && !(def && def.type === 'bool' && raw === false)) return { ok: false, reason: 'No value in profile' };
    switch (entry.kind) {
      case 'file': return setFile(el, raw);
      case 'select': {
        const options = [...el.options].map((o, i) => ({ text: o.text, value: o.value, placeholder: i === 0 && (!o.value || /select|choose|please|--/i.test(o.text)) }));
        const idx = chooseOption(options, raw, def, desc);
        if (idx < 0) return { ok: false, reason: 'No matching option' };
        return { ok: setSelect(el, idx), shown: options[idx].text };
      }
      case 'radio': {
        const idx = chooseOption(entry.options, raw, def, desc);
        if (idx < 0) return { ok: false, reason: 'No matching choice' };
        return { ok: setChecked(entry.options[idx].el, true), shown: entry.options[idx].text };
      }
      case 'checkgroup': {
        const vals = Array.isArray(raw) ? raw : String(raw).split(/\s*[;,]\s*/);
        let any = false;
        const shown = [];
        for (const v of vals) {
          const idx = chooseOption(entry.options, v, def, desc);
          if (idx >= 0) { setChecked(entry.options[idx].el, true); any = true; shown.push(entry.options[idx].text); }
        }
        return any ? { ok: true, shown: shown.join(', ') } : { ok: false, reason: 'No matching choice' };
      }
      case 'checkbox': {
        const want = def && def.type === 'bool' ? !!raw && raw !== 'no' : yesNo(raw) === 'yes';
        return { ok: setChecked(el, want), shown: want ? 'Checked' : 'Unchecked' };
      }
      case 'contenteditable': {
        const v = textValue(el, entry.kind, desc, def, raw);
        return { ok: setContentEditable(el, v), shown: v };
      }
      default: {
        const v = textValue(el, entry.kind, desc, def, raw);
        if (v === '') return { ok: false, reason: 'Nothing to enter' };
        const role = el.getAttribute('role');
        if (role === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') return { ok: await setCombobox(el, v), shown: v };
        return { ok: setText(el, v), shown: v };
      }
    }
  }

  function preview(raw, def) {
    if (raw == null) return '';
    if (typeof raw === 'object') return raw.name ? raw.name : '';
    if (def && def.type === 'bool') return raw && raw !== 'no' ? 'check' : 'leave unchecked';
    let s = String(raw);
    if (def && def.type === 'yesno') s = yesNo(raw) === 'yes' ? 'Yes' : yesNo(raw) === 'no' ? 'No' : s;
    return s.length > 40 ? s.slice(0, 38) + '...' : s;
  }

  globalThis.__SA_filler = { valueFor, isEmptyValue, apply, snapshot, restore, flatten, preview, chooseOption, parseDate, expandCandidates, yesNo, setText };
})();
