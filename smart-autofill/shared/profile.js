// Profile shape, defaults and normalization.
export const PROFILE_KINDS = [
  { id: 'personal', label: 'Personal' },
  { id: 'work', label: 'Work' },
  { id: 'job', label: 'Job hunting' },
  { id: 'custom', label: 'Custom' },
];

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const SHAPE = {
  contact: ['firstName', 'middleName', 'lastName', 'preferredName', 'pronouns', 'email', 'phone', 'phoneCountryCode'],
  address: ['line1', 'line2', 'city', 'state', 'postalCode', 'country'],
  links: ['linkedin', 'github', 'portfolio', 'twitter'],
  auth: ['authorized', 'sponsorship', 'citizenship', 'visaStatus', 'relocate', 'remote', 'over18', 'clearance', 'backgroundCheck'],
  demo: ['gender', 'race', 'hispanic', 'veteran', 'disability', 'orientation', 'transgender'],
  salary: ['expected', 'current', 'currency'],
  misc: ['availableStart', 'noticePeriod', 'yearsExperience', 'howHeard', 'summary', 'coverLetterText', 'skills', 'languages'],
};
export const WORK_FIELDS = ['company', 'title', 'location', 'startDate', 'endDate', 'current', 'description'];
export const EDU_FIELDS = ['school', 'degree', 'field', 'gpa', 'startDate', 'endDate'];

export function emptyWork() { return { company: '', title: '', location: '', startDate: '', endDate: '', current: false, description: '' }; }
export function emptyEdu() { return { school: '', degree: '', field: '', gpa: '', startDate: '', endDate: '' }; }

export const QA_SUGGESTIONS = [
  'Why do you want to work at {company}?',
  'Why are you interested in this role?',
  'Tell us about yourself.',
  'What is your greatest professional achievement?',
  'Describe a challenging project and how you handled it.',
  'Is there anything else you would like us to know?',
];

export function newProfile(name = 'New profile', kind = 'custom') {
  const p = { id: uid(), name, kind, createdAt: Date.now(), updatedAt: Date.now() };
  for (const [g, fields] of Object.entries(SHAPE)) p[g] = Object.fromEntries(fields.map(f => [f, '']));
  p.address.country = '';
  p.salary.currency = 'USD';
  p.work = [emptyWork()];
  p.edu = [emptyEdu()];
  p.qa = [];
  p.files = { resume: null, coverLetter: null };
  return p;
}

export function normalizeProfile(raw) {
  const base = newProfile(raw && raw.name || 'Profile', raw && raw.kind || 'custom');
  const p = { ...base, ...(raw || {}) };
  for (const g of Object.keys(SHAPE)) p[g] = { ...base[g], ...((raw && raw[g]) || {}) };
  p.work = Array.isArray(p.work) ? p.work.map(w => ({ ...emptyWork(), ...w })) : [emptyWork()];
  p.edu = Array.isArray(p.edu) ? p.edu.map(e => ({ ...emptyEdu(), ...e })) : [emptyEdu()];
  p.qa = Array.isArray(p.qa) ? p.qa.filter(Boolean).map(q => ({ id: q.id || uid(), question: q.question || '', answer: q.answer || '' })) : [];
  p.files = { resume: null, coverLetter: null, ...(p.files || {}) };
  if (!p.id) p.id = uid();
  return p;
}

export function defaultData() {
  const p = newProfile('Job hunting', 'job');
  p.qa = QA_SUGGESTIONS.slice(0, 2).map(q => ({ id: uid(), question: q, answer: '' }));
  return { version: 1, profiles: [p], activeProfileId: p.id };
}

export function normalizeData(d) {
  if (!d || !Array.isArray(d.profiles) || !d.profiles.length) return defaultData();
  const profiles = d.profiles.map(normalizeProfile);
  const activeProfileId = profiles.some(p => p.id === d.activeProfileId) ? d.activeProfileId : profiles[0].id;
  return { version: 1, profiles, activeProfileId };
}

// Rough completeness score for the profile list UI.
export function completeness(p) {
  const keys = ['contact.firstName', 'contact.lastName', 'contact.email', 'contact.phone', 'address.city', 'address.state', 'address.country',
    'links.linkedin', 'auth.authorized', 'auth.sponsorship'];
  let n = keys.filter(k => { const [g, f] = k.split('.'); return p[g] && p[g][f]; }).length;
  if (p.work.some(w => w.company)) n++;
  if (p.edu.some(e => e.school)) n++;
  if (p.files.resume) n++;
  return Math.round((n / (keys.length + 3)) * 100);
}
