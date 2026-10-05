import * as S from '../shared/store.js';
import { PROFILE_KINDS, QA_SUGGESTIONS, newProfile, emptyWork, emptyEdu, completeness, uid } from '../shared/profile.js';

const $ = (id) => document.getElementById(id);
const FIELDS = globalThis.SmartAutofillFields;
const MAX_FILE = 5 * 1024 * 1024;

let data = null;
let currentId = null;
let saveTimer = 0;

// ---------- small DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function dialog({ title, body, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, input = null }) {
  return new Promise((resolve) => {
    const field = input ? h('input', { class: 'input', type: input.type || 'text', value: input.value || '', placeholder: input.placeholder || '', 'aria-label': title }) : null;
    const ok = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'submit', text: okLabel });
    const d = h('dialog', {},
      h('form', { method: 'dialog' },
        h('h2', { text: title }),
        body ? h('p', { class: 'muted', text: body }) : null,
        field,
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', value: 'cancel', text: cancelLabel, onclick: () => d.close('cancel') }), ok)));
    d.addEventListener('close', () => {
      const v = d.returnValue !== 'cancel' ? (field ? field.value : true) : null;
      d.remove();
      resolve(v);
    });
    ok.addEventListener('click', (e) => { e.preventDefault(); d.close('ok'); });
    $('dialogHost').append(d);
    d.showModal();
    (field || ok).focus();
  });
}

function setSaveState(text) {
  $('saveState').textContent = text;
}

// ---------- routing ----------
const VIEWS = ['profiles', 'rules', 'security', 'backup', 'settings', 'help'];
async function route() {
  const hash = location.hash.slice(1);
  let view = hash.split('=')[0] || 'profiles';
  if (view === 'profile') { currentId = decodeURIComponent(hash.split('=')[1] || ''); view = 'profiles'; }
  if (!VIEWS.includes(view)) view = 'profiles';
  const lock = await S.getLockState();
  $('lockNow').hidden = !(lock.lockEnabled && !lock.locked);
  for (const a of document.querySelectorAll('.side a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  for (const v of document.querySelectorAll('.view')) v.hidden = true;
  const needsData = view === 'profiles' || view === 'backup';
  if (lock.locked && needsData) {
    $('view-locked').hidden = false;
    $('unlockPass').focus();
    return;
  }
  $('view-' + view).hidden = false;
  if (view === 'profiles') await renderProfiles();
  if (view === 'rules') await renderRules();
  if (view === 'security') await renderSecurity();
  if (view === 'settings') await renderSettings();
}

// ---------- profiles ----------
const YESNO = [['', 'Not set'], ['yes', 'Yes'], ['no', 'No']];
const SECTIONS = [
  { id: 'contact', title: 'Contact', open: true, fields: [
    ['contact.firstName', 'First name', { ac: 'given-name' }], ['contact.lastName', 'Last name', { ac: 'family-name' }],
    ['contact.middleName', 'Middle name'], ['contact.preferredName', 'Preferred name'],
    ['contact.email', 'Email', { type: 'email', ac: 'email' }], ['contact.phone', 'Phone', { type: 'tel', ac: 'tel' }],
    ['contact.phoneCountryCode', 'Phone country code', { placeholder: '+1' }],
    ['contact.pronouns', 'Pronouns', { list: ['He/him', 'She/her', 'They/them'] }],
  ] },
  { id: 'address', title: 'Address', open: true, fields: [
    ['address.line1', 'Street address', { span: 2, ac: 'address-line1' }], ['address.line2', 'Apartment, suite, unit', { span: 2 }],
    ['address.city', 'City'], ['address.state', 'State / province', { placeholder: 'e.g. TX or Texas' }],
    ['address.postalCode', 'ZIP / postal code'], ['address.country', 'Country', { list: ['United States', 'Canada', 'United Kingdom', 'India', 'Germany', 'Australia'] }],
  ] },
  { id: 'links', title: 'Links', open: true, fields: [
    ['links.linkedin', 'LinkedIn URL', { type: 'url', placeholder: 'https://www.linkedin.com/in/...' }], ['links.github', 'GitHub URL', { type: 'url', placeholder: 'https://github.com/...' }],
    ['links.portfolio', 'Portfolio / website', { type: 'url' }], ['links.twitter', 'Twitter / X', { type: 'url' }],
  ] },
  { id: 'auth', title: 'Work authorization', open: true, fields: [
    ['auth.authorized', 'Legally authorized to work in your country of application?', { options: YESNO }],
    ['auth.sponsorship', 'Will you require visa sponsorship?', { options: YESNO }],
    ['auth.citizenship', 'Citizenship', { list: ['United States', 'Canada', 'India', 'United Kingdom'] }], ['auth.visaStatus', 'Visa / immigration status', { placeholder: 'e.g. Citizen, Green card, H-1B, F-1 OPT' }],
    ['auth.relocate', 'Willing to relocate?', { options: YESNO }], ['auth.remote', 'Work arrangement preference', { options: [['', 'Not set'], ['Remote', 'Remote'], ['Hybrid', 'Hybrid'], ['On-site', 'On-site'], ['Flexible', 'Flexible']] }],
    ['auth.over18', 'At least 18 years old?', { options: YESNO }], ['auth.backgroundCheck', 'Consent to background check?', { options: YESNO }],
    ['auth.clearance', 'Security clearance', { placeholder: 'e.g. None, Secret, TS/SCI' }],
  ] },
  { id: 'demo', title: 'Demographics (optional)', note: 'Used only for voluntary self-identification (EEO) questions. Leave any field empty to never answer it.', fields: [
    ['demo.gender', 'Gender', { options: [['', 'Not set'], ['Male', 'Male'], ['Female', 'Female'], ['Non-binary', 'Non-binary'], ['Decline to self-identify', 'Decline to self-identify']] }],
    ['demo.race', 'Race / ethnicity', { options: [['', 'Not set'], ['American Indian or Alaska Native', 'American Indian or Alaska Native'], ['Asian', 'Asian'], ['Black or African American', 'Black or African American'], ['Hispanic or Latino', 'Hispanic or Latino'], ['Native Hawaiian or Other Pacific Islander', 'Native Hawaiian or Other Pacific Islander'], ['White', 'White'], ['Two or More Races', 'Two or more races'], ['Decline to self-identify', 'Decline to self-identify']] }],
    ['demo.hispanic', 'Hispanic or Latino?', { options: [...YESNO, ['Decline to self-identify', 'Decline to self-identify']] }],
    ['demo.veteran', 'Veteran status', { options: [['', 'Not set'], ['I am not a protected veteran', 'I am not a protected veteran'], ['I identify as one or more of the classifications of protected veteran', 'I am a protected veteran'], ['Decline to self-identify', 'Decline to self-identify']] }],
    ['demo.disability', 'Disability status', { options: [['', 'Not set'], ['No, I do not have a disability', 'No, I do not have a disability'], ['Yes, I have a disability', 'Yes, I have a disability'], ['Decline to self-identify', 'Decline to self-identify']] }],
    ['demo.transgender', 'Transgender?', { options: [...YESNO, ['Decline to self-identify', 'Decline to self-identify']] }],
    ['demo.orientation', 'Sexual orientation', {}],
  ] },
  { id: 'salary', title: 'Compensation', fields: [
    ['salary.expected', 'Expected salary', { placeholder: 'e.g. 120000' }], ['salary.current', 'Current salary'],
    ['salary.currency', 'Currency', { list: ['USD', 'EUR', 'GBP', 'CAD', 'INR', 'AUD'] }],
  ] },
  { id: 'misc', title: 'Availability and summary', fields: [
    ['misc.availableStart', 'Earliest start date', { type: 'date' }], ['misc.noticePeriod', 'Notice period', { placeholder: 'e.g. 2 weeks' }],
    ['misc.yearsExperience', 'Years of experience', { type: 'number' }], ['misc.howHeard', 'How you usually hear about jobs', { list: ['LinkedIn', 'Company website', 'Referral', 'Job board'] }],
    ['misc.skills', 'Skills', { span: 2, textarea: true, placeholder: 'Comma separated: JavaScript, SQL, Project management' }],
    ['misc.languages', 'Languages spoken', { span: 2, placeholder: 'English (native), Spanish (professional)' }],
    ['misc.summary', 'Professional summary', { span: 2, textarea: true }],
    ['misc.coverLetterText', 'Cover letter text', { span: 2, textarea: true, rows: 8, placeholder: 'Dear {company} team, ... Templates: {company} {role} {name}' }],
  ] },
];

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}
function current() { return data.profiles.find(p => p.id === currentId); }

function scheduleSave(immediate) {
  setSaveState('Saving...');
  clearTimeout(saveTimer);
  const run = async () => {
    try {
      const p = current();
      if (p) p.updatedAt = Date.now();
      await S.saveData(data);
      setSaveState('All changes saved');
      renderTabs();
    } catch (e) {
      setSaveState(e.locked ? 'Locked: changes not saved' : 'Save failed: ' + e.message);
      if (e.locked) route();
    }
  };
  if (immediate) run(); else saveTimer = setTimeout(run, 400);
}

function bindInput(el, path, transform) {
  const p = current();
  const v = getPath(p, path);
  if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v;
  el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
    const val = el.type === 'checkbox' ? el.checked : el.value;
    setPath(current(), path, transform ? transform(val) : val);
    scheduleSave();
  });
  return el;
}

function fieldControl(path, label, o = {}) {
  const id = 'f-' + path.replace(/\./g, '-') + '-' + uid();
  let ctl;
  if (o.options) {
    ctl = h('select', { class: 'input', id });
    for (const [v, t] of o.options) ctl.add(new Option(t, v));
  } else if (o.textarea) {
    ctl = h('textarea', { class: 'input', id, rows: o.rows || 3, placeholder: o.placeholder || '' });
  } else {
    ctl = h('input', { class: 'input', id, type: o.type || 'text', placeholder: o.placeholder || '', autocomplete: 'off' });
    if (o.list) {
      const lid = id + '-list';
      ctl.setAttribute('list', lid);
      const dl = h('datalist', { id: lid }, o.list.map(v => h('option', { value: v })));
      bindInput(ctl, path);
      return h('label', { class: 'field' + (o.span === 2 ? ' span2' : ''), for: id }, h('span', { text: label }), ctl, dl);
    }
  }
  bindInput(ctl, path);
  return h('label', { class: 'field' + (o.span === 2 ? ' span2' : ''), for: id }, h('span', { text: label }), ctl);
}

function sectionCard(title, open, ...body) {
  const d = h('details', { class: 'card' }, h('summary', {}, h('h2', { text: title })), ...body);
  d.open = !!open;
  return d;
}

function renderTabs() {
  const tabs = $('profileTabs');
  tabs.replaceChildren(...data.profiles.map(p => {
    const pct = completeness(p);
    const kind = (PROFILE_KINDS.find(k => k.id === p.kind) || {}).label || 'Custom';
    const b = h('button', { class: 'ptab', role: 'tab', 'aria-selected': String(p.id === currentId), type: 'button', onclick: () => { currentId = p.id; history.replaceState(null, '', '#profile=' + encodeURIComponent(p.id)); renderProfiles(); } },
      h('span', { class: 'pname', text: p.name || 'Untitled' }),
      h('span', { class: 'pmeta' }, kind + (p.id === data.activeProfileId ? ' · active' : ''), h('span', { class: 'meter', title: pct + '% complete' }, h('i', { style: `width:${pct}%` })), pct + '%'));
    return b;
  }));
}

function entryCard(kind, list, index, rerender) {
  const e = list[index];
  const title = kind === 'work' ? [e.title, e.company].filter(Boolean).join(' at ') || 'New position' : [e.degree, e.school].filter(Boolean).join(', ') || 'New school';
  const base = `${kind}.${index}.`;
  const move = (d) => { const j = index + d; if (j < 0 || j >= list.length) return; [list[index], list[j]] = [list[j], list[index]]; scheduleSave(true); rerender(); };
  const head = h('div', { class: 'entry-head' }, h('b', { text: `${index + 1}. ${title}` }),
    h('div', { class: 'tools' },
      h('button', { class: 'btn small ghost', type: 'button', title: 'Move up', 'aria-label': 'Move up', disabled: index === 0, onclick: () => move(-1), text: '↑' }),
      h('button', { class: 'btn small ghost', type: 'button', title: 'Move down', 'aria-label': 'Move down', disabled: index === list.length - 1, onclick: () => move(1), text: '↓' }),
      h('button', { class: 'btn small danger', type: 'button', text: 'Remove', onclick: async () => { if (await dialog({ title: 'Remove this entry?', okLabel: 'Remove', danger: true })) { list.splice(index, 1); scheduleSave(true); rerender(); } } })));
  let grid;
  if (kind === 'work') {
    const cur = h('input', { type: 'checkbox' });
    bindInput(cur, base + 'current');
    grid = h('div', { class: 'grid' },
      fieldControl(base + 'company', 'Company'), fieldControl(base + 'title', 'Job title'),
      fieldControl(base + 'location', 'Location'), h('label', { class: 'inline-check current-job' }, cur, 'I currently work here'),
      fieldControl(base + 'startDate', 'Start (month)', { type: 'month' }), fieldControl(base + 'endDate', 'End (month)', { type: 'month' }),
      fieldControl(base + 'description', 'Description / responsibilities', { span: 2, textarea: true, rows: 4 }));
  } else {
    grid = h('div', { class: 'grid' },
      fieldControl(base + 'school', 'School / university'), fieldControl(base + 'degree', 'Degree', { list: ["Bachelor's", "Master's", 'MBA', 'PhD', "Associate's", 'High School'] }),
      fieldControl(base + 'field', 'Field of study / major'), fieldControl(base + 'gpa', 'GPA'),
      fieldControl(base + 'startDate', 'Start (month)', { type: 'month' }), fieldControl(base + 'endDate', 'Graduation (month)', { type: 'month' }));
  }
  return h('div', { class: 'entry' }, head, grid);
}

function repeatableCard(kind) {
  const title = kind === 'work' ? 'Work history' : 'Education';
  const body = h('div');
  const render = () => {
    const list = current()[kind];
    body.replaceChildren(
      h('p', { class: 'section-note', text: kind === 'work' ? 'Most recent first. Smart Autofill fills one entry per section on the form and clicks "Add another" for the rest when it can.' : 'Most recent first.' }),
      ...list.map((_, i) => entryCard(kind, list, i, render)),
      h('button', { class: 'btn', type: 'button', text: kind === 'work' ? 'Add position' : 'Add school', onclick: () => { list.push(kind === 'work' ? emptyWork() : emptyEdu()); scheduleSave(true); render(); } }));
  };
  render();
  return sectionCard(title, true, body);
}

function qaCard() {
  const body = h('div', { class: 'qa' });
  const render = () => {
    const p = current();
    const items = p.qa.map((q, i) => {
      const qIn = h('input', { class: 'input', placeholder: 'Question as it appears on forms', 'aria-label': 'Question ' + (i + 1) });
      bindInput(qIn, `qa.${i}.question`);
      const aIn = h('textarea', { class: 'input', rows: 4, placeholder: 'Your answer. Templates: {company} {role} {name} {current_title}', 'aria-label': 'Answer ' + (i + 1) });
      bindInput(aIn, `qa.${i}.answer`);
      return h('div', { class: 'entry' },
        h('div', { class: 'entry-head' }, h('b', { text: `Answer ${i + 1}` }),
          h('button', { class: 'btn small danger', type: 'button', text: 'Remove', onclick: () => { p.qa.splice(i, 1); scheduleSave(true); render(); } })),
        h('div', { class: 'stack' }, qIn, aIn));
    });
    const existing = new Set(p.qa.map(q => q.question));
    const chips = QA_SUGGESTIONS.filter(s => !existing.has(s)).map(s => h('button', { class: 'chip', type: 'button', text: '+ ' + s, onclick: () => { p.qa.push({ id: uid(), question: s, answer: '' }); scheduleSave(true); render(); } }));
    body.replaceChildren(
      h('p', { class: 'section-note', text: 'Free-text questions are matched to these by wording similarity, so you only write each answer once.' }),
      ...items,
      h('div', {}, h('button', { class: 'btn', type: 'button', text: 'Add custom answer', onclick: () => { p.qa.push({ id: uid(), question: '', answer: '' }); scheduleSave(true); render(); } })),
      chips.length ? h('div', { class: 'chips' }, chips) : null);
  };
  render();
  return sectionCard('Custom answers', true, body);
}

function fileSlot(slot, label) {
  const wrap = h('div', { class: 'file-slot' });
  const render = () => {
    const f = current().files[slot];
    const input = h('input', { type: 'file', accept: '.pdf,.doc,.docx,.txt,.rtf,.odt', class: 'sr-only', id: 'file-' + slot });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > MAX_FILE) { await dialog({ title: 'File too large', body: 'Please choose a file under 5 MB.', cancelLabel: 'Close', okLabel: 'OK' }); return; }
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      current().files[slot] = { name: file.name, type: file.type, size: file.size, lastModified: file.lastModified, dataUrl };
      scheduleSave(true);
      render();
    });
    wrap.replaceChildren(
      h('b', { text: label }),
      f ? h('div', {}, h('div', { class: 'fname', text: f.name }), h('small', { class: 'muted', text: `${(f.size / 1024).toFixed(0)} KB · ${f.type || 'file'}` })) : h('span', { class: 'muted', text: 'No file yet' }),
      h('div', { class: 'row' },
        h('label', { class: 'btn small', for: 'file-' + slot, tabindex: '0', role: 'button', onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } }, f ? 'Replace' : 'Choose file'),
        f ? h('button', { class: 'btn small danger', type: 'button', text: 'Remove', onclick: () => { current().files[slot] = null; scheduleSave(true); render(); } }) : null,
        input));
  };
  render();
  return wrap;
}

async function renderProfiles() {
  if (!data) data = await S.loadData();
  if (!currentId || !data.profiles.some(p => p.id === currentId)) currentId = data.activeProfileId;
  renderTabs();
  const p = current();
  const nameIn = h('input', { class: 'input', id: 'pname' });
  bindInput(nameIn, 'name');
  const kindSel = h('select', { class: 'input', id: 'pkind' }, PROFILE_KINDS.map(k => new Option(k.label, k.id)));
  bindInput(kindSel, 'kind');
  const top = h('div', { class: 'card' },
    h('div', { class: 'editor-top' },
      h('label', { class: 'field', for: 'pname' }, h('span', { text: 'Profile name' }), nameIn),
      h('label', { class: 'field', for: 'pkind' }, h('span', { text: 'Type' }), kindSel),
      h('div', { class: 'btns' },
        p.id === data.activeProfileId ? h('span', { class: 'status-pill on', text: 'Active' }) : h('button', { class: 'btn', type: 'button', text: 'Make active', onclick: () => { data.activeProfileId = p.id; scheduleSave(true); renderProfiles(); } }),
        h('button', { class: 'btn', type: 'button', text: 'Duplicate', onclick: duplicateProfile }),
        h('button', { class: 'btn danger', type: 'button', text: 'Delete', disabled: data.profiles.length < 2, title: data.profiles.length < 2 ? 'Keep at least one profile' : '', onclick: deleteProfile }))));

  const sections = SECTIONS.map(s => sectionCard(s.title, s.open,
    s.note ? h('p', { class: 'section-note', text: s.note }) : null,
    h('div', { class: 'grid' }, s.fields.map(([path, label, o]) => fieldControl(path, label, o || {})))));
  const files = sectionCard('Documents', true,
    h('p', { class: 'section-note', text: 'Attached to resume and cover letter upload fields where the site allows it. Max 5 MB each.' }),
    h('div', { class: 'files' }, fileSlot('resume', 'Resume / CV'), fileSlot('coverLetter', 'Cover letter')));

  $('profileEditor').replaceChildren(h('div', { class: 'editor' },
    top, sections[0], sections[1], sections[2], repeatableCard('work'), repeatableCard('edu'), files, qaCard(), sections[3], sections[5], sections[6], sections[4]));
}

async function duplicateProfile() {
  const src = current();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = uid();
  copy.name = src.name + ' (copy)';
  copy.createdAt = copy.updatedAt = Date.now();
  data.profiles.push(copy);
  currentId = copy.id;
  scheduleSave(true);
  renderProfiles();
}
async function deleteProfile() {
  const p = current();
  if (!(await dialog({ title: `Delete "${p.name}"?`, body: 'This removes the profile and its documents. This cannot be undone.', okLabel: 'Delete', danger: true }))) return;
  data.profiles = data.profiles.filter(x => x.id !== p.id);
  if (data.activeProfileId === p.id) data.activeProfileId = data.profiles[0].id;
  currentId = data.activeProfileId;
  scheduleSave(true);
  renderProfiles();
}
async function createProfile() {
  const name = await dialog({ title: 'New profile', body: 'Give it a name, like "Work" or "Job hunting: design roles".', okLabel: 'Create', input: { value: '', placeholder: 'Profile name' } });
  if (!name) return;
  const base = current();
  const p = newProfile(name.trim(), /job/i.test(name) ? 'job' : /work/i.test(name) ? 'work' : /personal|home/i.test(name) ? 'personal' : 'custom');
  // Start from the same contact details so new profiles are useful immediately.
  if (base) { p.contact = { ...base.contact }; p.address = { ...base.address }; }
  data.profiles.push(p);
  currentId = p.id;
  scheduleSave(true);
  renderProfiles();
}

// ---------- site rules ----------
function fieldLabel(key) {
  if (key === '__skip') return 'Never fill';
  if (key.startsWith('qa.')) {
    const id = key.slice(3);
    for (const p of (data && data.profiles) || []) { const q = p.qa.find(x => x.id === id); if (q) return 'Answer: ' + q.question; }
    return 'Custom answer';
  }
  const def = FIELDS.byKey[key];
  return def ? def.label : key;
}
async function renderRules() {
  try { if (!data) data = await S.loadData(); } catch (e) { /* locked: labels for answers unavailable */ }
  const rules = await S.getRules();
  const filter = $('ruleSearch').value.trim().toLowerCase();
  const hosts = Object.keys(rules).filter(hs => !filter || hs.includes(filter)).sort();
  const list = $('rulesList');
  if (!hosts.length) {
    list.replaceChildren(h('div', { class: 'card empty' }, filter ? 'No sites match.' : 'No site rules yet. Remap a field in the in-page preview, or correct a filled field, and it will show up here.'));
    return;
  }
  list.replaceChildren(...hosts.map(host => {
    const entries = Object.entries(rules[host]).sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
    const rows = entries.map(([sig, r]) => h('tr', {},
      h('td', { class: 'sig', title: sig, text: r.label || sig.split('|').slice(1).join('|').replace(/^[nil]:/, '') }),
      h('td', { text: fieldLabel(r.key) + (r.index != null && r.index > 0 ? ` #${r.index + 1}` : '') }),
      h('td', { class: 'muted', text: r.updated ? new Date(r.updated).toLocaleDateString() : '' }),
      h('td', {}, h('button', { class: 'btn small danger', type: 'button', text: 'Delete', 'aria-label': 'Delete rule', onclick: async () => { await S.deleteRule(host, sig); renderRules(); } }))));
    return h('div', { class: 'card site' },
      h('div', { class: 'site-head' }, h('h2', { text: host }),
        h('button', { class: 'btn small danger', type: 'button', text: 'Forget site', onclick: async () => { if (await dialog({ title: `Forget all rules for ${host}?`, okLabel: 'Forget', danger: true })) { await S.clearRules(host); renderRules(); } } })),
      h('table', { class: 'rules' }, h('thead', {}, h('tr', {}, h('th', { text: 'Field on page' }), h('th', { text: 'Fills with' }), h('th', { text: 'Updated' }), h('th', {}))), h('tbody', {}, rows)));
  }));
}

// ---------- security ----------
function strength(pass) {
  let s = 0;
  if (pass.length >= 8) s++;
  if (pass.length >= 12) s++;
  if (pass.length >= 16) s++;
  if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) s++;
  if (/\d/.test(pass) && /[^A-Za-z0-9]/.test(pass)) s++;
  return Math.min(4, s);
}
function passFields(prefix, withOld) {
  const old = withOld ? h('input', { class: 'input', type: 'password', id: prefix + 'old', autocomplete: 'current-password', required: true }) : null;
  const p1 = h('input', { class: 'input', type: 'password', id: prefix + 'p1', autocomplete: 'new-password', minlength: '8', required: true });
  const p2 = h('input', { class: 'input', type: 'password', id: prefix + 'p2', autocomplete: 'new-password', minlength: '8', required: true });
  const bar = h('i');
  p1.addEventListener('input', () => {
    const s = strength(p1.value);
    bar.style.width = (s / 4) * 100 + '%';
    bar.style.background = ['var(--danger)', 'var(--danger)', 'var(--warn)', 'var(--ok)', 'var(--ok)'][s];
  });
  const nodes = [
    old ? h('label', { class: 'field', for: prefix + 'old' }, h('span', { text: 'Current passphrase' }), old) : null,
    h('label', { class: 'field', for: prefix + 'p1' }, h('span', { text: withOld ? 'New passphrase' : 'Passphrase (8+ characters)' }), p1),
    h('div', { class: 'strength', 'aria-hidden': 'true' }, bar),
    h('label', { class: 'field', for: prefix + 'p2' }, h('span', { text: 'Confirm passphrase' }), p2),
  ];
  return { nodes, old, p1, p2 };
}
async function renderSecurity() {
  const lock = await S.getLockState();
  const s = await S.getSettings();
  const body = $('securityBody');
  const msg = h('p', { class: 'msg', role: 'status' });
  const statusCard = h('div', { class: 'card stack' },
    h('h2', {}, 'Passphrase lock ', h('span', { class: 'status-pill ' + (lock.lockEnabled ? 'on' : 'off'), text: lock.lockEnabled ? (lock.locked ? 'On · locked' : 'On · unlocked') : 'Off' })),
    h('p', { class: 'muted', text: 'When on, profiles (including documents) are encrypted with AES-GCM 256 using a key derived from your passphrase with PBKDF2-SHA-256 (310,000 iterations). The key is held in session memory while unlocked. If you forget the passphrase, the data cannot be recovered; keep an encrypted backup.' }));
  const auto = h('select', { class: 'input', id: 'autoLock' }, [[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'When the browser closes']].map(([v, t]) => new Option(t, v)));
  auto.value = String(s.autoLockMinutes);
  auto.addEventListener('change', () => S.saveSettings({ autoLockMinutes: +auto.value }));
  const cards = [statusCard];
  if (!lock.lockEnabled) {
    const f = passFields('en', false);
    const form = h('form', { class: 'card stack' }, h('h2', { text: 'Turn on passphrase lock' }), ...f.nodes,
      h('div', {}, h('button', { class: 'btn primary', type: 'submit', text: 'Encrypt my profiles' })), msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (f.p1.value !== f.p2.value) { msg.className = 'msg err'; msg.textContent = 'Passphrases do not match.'; return; }
      msg.className = 'msg'; msg.textContent = 'Encrypting...';
      try { await S.enableLock(f.p1.value); data = null; msg.className = 'msg ok'; renderSecurity(); route(); } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    });
    cards.push(form);
  } else if (lock.locked) {
    cards.push(h('div', { class: 'card stack' }, h('p', { text: 'Unlock to change the passphrase or turn the lock off.' }), h('div', {}, h('button', { class: 'btn primary', type: 'button', text: 'Unlock', onclick: () => { location.hash = '#profiles'; } }))));
  } else {
    cards.push(h('div', { class: 'card stack' }, h('h2', { text: 'Auto-lock' }), h('label', { class: 'field', for: 'autoLock' }, h('span', { text: 'Lock after inactivity' }), auto),
      h('div', {}, h('button', { class: 'btn', type: 'button', text: 'Lock now', onclick: async () => { await S.lock(); data = null; renderSecurity(); route(); } }))));
    const f = passFields('ch', true);
    const msg2 = h('p', { class: 'msg', role: 'status' });
    const change = h('form', { class: 'card stack' }, h('h2', { text: 'Change passphrase' }), ...f.nodes, h('div', {}, h('button', { class: 'btn', type: 'submit', text: 'Change passphrase' })), msg2);
    change.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (f.p1.value !== f.p2.value) { msg2.className = 'msg err'; msg2.textContent = 'Passphrases do not match.'; return; }
      msg2.className = 'msg'; msg2.textContent = 'Re-encrypting...';
      try { await S.changePassphrase(f.old.value, f.p1.value); msg2.className = 'msg ok'; msg2.textContent = 'Passphrase changed.'; change.reset(); } catch (err) { msg2.className = 'msg err'; msg2.textContent = err.message; }
    });
    const offPass = h('input', { class: 'input', type: 'password', id: 'offPass', autocomplete: 'current-password', required: true });
    const msg3 = h('p', { class: 'msg', role: 'status' });
    const off = h('form', { class: 'card stack' }, h('h2', { text: 'Turn off lock' }), h('p', { class: 'muted', text: 'Profiles will be stored unencrypted in this browser profile.' }),
      h('label', { class: 'field', for: 'offPass' }, h('span', { text: 'Passphrase' }), offPass), h('div', {}, h('button', { class: 'btn danger', type: 'submit', text: 'Decrypt and turn off' })), msg3);
    off.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await S.disableLock(offPass.value); data = null; renderSecurity(); route(); } catch (err) { msg3.className = 'msg err'; msg3.textContent = err.message; }
    });
    cards.push(change, off);
  }
  body.replaceChildren(h('div', { class: 'cards' }, cards));
}

// ---------- settings ----------
async function renderSettings() {
  const s = await S.getSettings();
  for (const el of document.querySelectorAll('[data-setting]')) el.checked = !!s[el.dataset.setting];
  $('minConf').value = s.minConfidence;
  $('minConfOut').textContent = Math.round(s.minConfidence * 100) + '%';
  $('allFramesPerm').checked = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  const bytes = await S.storageUsage();
  $('usage').textContent = `Using ${(bytes / 1024).toFixed(1)} KB of local storage (profiles, documents and site rules).`;
}
function bindSettings() {
  for (const el of document.querySelectorAll('[data-setting]')) el.addEventListener('change', () => S.saveSettings({ [el.dataset.setting]: el.checked }));
  $('minConf').addEventListener('input', () => { $('minConfOut').textContent = Math.round($('minConf').value * 100) + '%'; });
  $('minConf').addEventListener('change', () => S.saveSettings({ minConfidence: +$('minConf').value }));
  $('allFramesPerm').addEventListener('change', async (e) => {
    const want = e.target.checked;
    try {
      const ok = want ? await chrome.permissions.request({ origins: ['<all_urls>'] }) : await chrome.permissions.remove({ origins: ['<all_urls>'] });
      if (!ok) e.target.checked = !want;
    } catch (err) { e.target.checked = !want; }
  });
  $('openShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
}

// ---------- backup ----------
function bindBackup() {
  $('exportForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('exportMsg');
    if ($('expPass').value !== $('expPass2').value) { msg.className = 'msg err'; msg.textContent = 'Passphrases do not match.'; return; }
    msg.className = 'msg'; msg.textContent = 'Encrypting...';
    try {
      const json = await S.exportBackup($('expPass').value, { includeRules: $('expRules').checked, includeSettings: $('expSettings').checked });
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = h('a', { href: url, download: `smart-autofill-backup-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      msg.className = 'msg ok'; msg.textContent = 'Backup downloaded. Keep the passphrase somewhere safe.';
      e.target.reset();
      $('expRules').checked = $('expSettings').checked = true;
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
  });
  $('importForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('importMsg');
    const file = $('impFile').files[0];
    if (!file) return;
    msg.className = 'msg'; msg.textContent = 'Importing...';
    try {
      const text = await file.text();
      const info = S.inspectBackup(text);
      if (info.encrypted && !$('impPass').value) throw new Error('Enter the backup passphrase.');
      const mode = document.querySelector('input[name=impMode]:checked').value;
      if (mode === 'replace' && !(await dialog({ title: 'Replace all profiles?', body: 'Your current profiles will be overwritten by the backup.', okLabel: 'Replace', danger: true }))) { msg.textContent = ''; return; }
      const r = await S.importBackup(text, $('impPass').value, mode);
      data = null;
      msg.className = 'msg ok';
      msg.textContent = `Imported ${r.profiles} profile${r.profiles === 1 ? '' : 's'}` + (r.rules ? ` and rules for ${r.rules} site${r.rules === 1 ? '' : 's'}` : '') + '.';
      e.target.reset();
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
  });
}

// ---------- boot ----------
function init() {
  window.addEventListener('hashchange', route);
  $('newProfile').addEventListener('click', createProfile);
  $('ruleSearch').addEventListener('input', renderRules);
  $('clearAllRules').addEventListener('click', async () => { if (await dialog({ title: 'Clear every site rule?', okLabel: 'Clear all', danger: true })) { await S.clearRules(); renderRules(); } });
  $('lockNow').addEventListener('click', async () => { await S.lock(); data = null; route(); });
  $('unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('unlockErr').textContent = '';
    try { await S.unlock($('unlockPass').value); $('unlockPass').value = ''; data = null; route(); } catch (err) { $('unlockErr').textContent = err.message; }
  });
  bindSettings();
  bindBackup();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.siteRules && !$('view-rules').hidden) renderRules();
    if (area === 'session' && changes.vaultKey && !changes.vaultKey.newValue) { data = null; route(); }
  });
  route();
}
init();
