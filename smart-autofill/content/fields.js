// Smart Autofill field dictionary.
// Classic script: shared by the content script (injected) and the options page.
// Each field: key, label, group, type (value kind), kw (weighted keyword phrases, already
// normalized: lowercase words separated by single spaces), ac (autocomplete tokens),
// neg (phrases that make the field unlikely), only (restrict to control kinds).
(function () {
  'use strict';
  if (globalThis.SmartAutofillFields) return;

  const F = (key, label, group, type, kw, extra = {}) => ({ key, label, group, type, kw, ac: [], neg: [], ...extra });

  const FIELDS = [
    // Contact
    F('contact.fullName', 'Full name', 'contact', 'text',
      [['full name', 1], ['legal name', 0.95], ['your name', 0.9], ['candidate name', 0.95], ['applicant name', 0.95], ['fullname', 1], ['name', 0.55], ['signature', 0.5]],
      { ac: ['name'], neg: ['first', 'last', 'middle', 'company', 'employer', 'school', 'university', 'user name', 'username', 'reference', 'referrer', 'manager', 'supervisor', 'emergency', 'contact person', 'business', 'organization', 'preferred', 'nickname', 'file', 'job', 'position', 'degree', 'institution', 'college', 'recruiter', 'hiring', 'pronunciation'] }),
    F('contact.firstName', 'First name', 'contact', 'text',
      [['first name', 1], ['given name', 1], ['firstname', 1], ['fname', 0.95], ['forename', 1], ['first', 0.6], ['legal first name', 1]],
      { ac: ['given-name'], neg: ['preferred', 'nickname', 'last', 'reference', 'emergency'] }),
    F('contact.middleName', 'Middle name', 'contact', 'text',
      [['middle name', 1], ['middle initial', 1], ['middlename', 1], ['mname', 0.9], ['middle', 0.6]],
      { ac: ['additional-name'] }),
    F('contact.lastName', 'Last name', 'contact', 'text',
      [['last name', 1], ['surname', 1], ['family name', 1], ['lastname', 1], ['lname', 0.95], ['last', 0.55], ['legal last name', 1]],
      { ac: ['family-name'], neg: ['first', 'reference', 'emergency', 'last day', 'last date', 'last employer', 'last company', 'last position', 'last 4', 'last four'] }),
    F('contact.preferredName', 'Preferred name', 'contact', 'text',
      [['preferred name', 1], ['preferred first name', 1], ['nickname', 0.9], ['goes by', 0.9], ['name you prefer', 0.95], ['preferred', 0.5]],
      { ac: ['nickname'], neg: ['pronoun', 'location', 'contact method', 'language'] }),
    F('contact.pronouns', 'Pronouns', 'contact', 'text',
      [['pronouns', 1], ['pronoun', 1]], {}),
    F('contact.email', 'Email', 'contact', 'email',
      [['email address', 1], ['email', 1], ['e mail', 1], ['mail', 0.6], ['courriel', 0.9]],
      { ac: ['email'], neg: ['confirm', 'reference', 'manager', 'recruiter', 'referrer', 'emergency', 'subscribe', 'newsletter'] }),
    F('contact.emailConfirm', 'Confirm email', 'contact', 'email',
      [['confirm email', 1], ['re enter email', 1], ['retype email', 1], ['email again', 1], ['verify email', 1], ['repeat email', 1], ['email confirmation', 1]], {}),
    F('contact.phone', 'Phone', 'contact', 'phone',
      [['phone number', 1], ['phone', 1], ['mobile', 0.95], ['cell', 0.85], ['telephone', 1], ['tel', 0.6], ['contact number', 0.95], ['mobile number', 1]],
      { ac: ['tel', 'tel-national'], neg: ['country code', 'extension', 'reference', 'emergency', 'type', 'manager', 'device'] }),
    F('contact.phoneCountryCode', 'Phone country code', 'contact', 'text',
      [['country code', 1], ['phone country', 0.95], ['dial code', 1], ['calling code', 1]],
      { ac: ['tel-country-code'] }),

    // Address
    F('address.line1', 'Address line 1', 'address', 'text',
      [['street address', 1], ['address line 1', 1], ['address 1', 1], ['address1', 1], ['street', 0.9], ['mailing address', 0.95], ['home address', 0.95], ['address', 0.75], ['addr', 0.6]],
      { ac: ['address-line1', 'street-address'], neg: ['email', 'mail address', 'line 2', 'address 2', 'web', 'ip address', 'url', 'company address'] }),
    F('address.line2', 'Address line 2', 'address', 'text',
      [['address line 2', 1], ['address 2', 1], ['address2', 1], ['apartment', 0.9], ['apt', 0.85], ['suite', 0.85], ['unit', 0.6], ['building', 0.6]],
      { ac: ['address-line2'] }),
    F('address.city', 'City', 'address', 'text',
      [['city', 1], ['town', 0.85], ['locality', 0.85], ['municipality', 0.85], ['city town', 1]],
      { ac: ['address-level2'], neg: ['ethnicity', 'state', 'citizenship'] }),
    F('address.state', 'State / province', 'address', 'state',
      [['state', 0.9], ['province', 1], ['state province', 1], ['region', 0.75], ['state region', 1], ['prefecture', 0.9]],
      { ac: ['address-level1'], neg: ['statement', 'united states', 'status', 'state of', 'city state'] }),
    F('address.postalCode', 'ZIP / postal code', 'address', 'text',
      [['zip code', 1], ['zip', 1], ['postal code', 1], ['postcode', 1], ['post code', 1], ['zipcode', 1], ['postal', 0.9], ['pin code', 0.9]],
      { ac: ['postal-code'] }),
    F('address.country', 'Country', 'address', 'country',
      [['country', 1], ['country of residence', 1], ['country region', 1], ['nation', 0.6]],
      { ac: ['country', 'country-name'], neg: ['code', 'citizenship', 'country of birth', 'phone', 'dial', 'calling'] }),
    F('address.location', 'Location (City, State)', 'address', 'text',
      [['location', 0.95], ['current location', 1], ['where are you located', 1], ['where are you based', 1], ['city state', 1], ['city and state', 1], ['based in', 0.8]],
      { neg: ['job location', 'preferred location', 'office location', 'relocat', 'company location', 'work location'] }),

    // Links
    F('links.linkedin', 'LinkedIn', 'links', 'url',
      [['linkedin', 1], ['linked in', 1], ['linkedin profile', 1], ['linkedin url', 1]], {}),
    F('links.github', 'GitHub', 'links', 'url',
      [['github', 1], ['git hub', 1], ['gitlab', 0.7]], {}),
    F('links.portfolio', 'Portfolio / website', 'links', 'url',
      [['portfolio', 1], ['personal website', 1], ['website', 0.9], ['personal site', 1], ['web site', 0.9], ['homepage', 0.85], ['blog', 0.7], ['other website', 0.8], ['url', 0.5], ['link', 0.4]],
      { ac: ['url'], neg: ['linkedin', 'github', 'twitter', 'company website'] }),
    F('links.twitter', 'Twitter / X', 'links', 'url',
      [['twitter', 1], ['x handle', 0.9], ['x com', 0.9]], {}),

    // Work authorization
    F('auth.authorized', 'Authorized to work', 'auth', 'yesno',
      [['legally authorized', 1], ['authorized to work', 1], ['authorised to work', 1], ['eligible to work', 1], ['work authorization', 0.95], ['right to work', 1], ['legally eligible', 1], ['legal right', 0.9], ['permitted to work', 1]],
      { neg: ['sponsor'] }),
    F('auth.sponsorship', 'Requires sponsorship', 'auth', 'yesno',
      [['sponsorship', 1], ['require sponsorship', 1], ['visa sponsorship', 1], ['sponsor', 0.95], ['employment visa', 0.85], ['h 1b', 0.8], ['h1b', 0.8]], {}),
    F('auth.citizenship', 'Citizenship', 'auth', 'country',
      [['citizenship', 1], ['nationality', 1], ['citizen of', 0.95], ['country of citizenship', 1]], {}),
    F('auth.visaStatus', 'Visa / immigration status', 'auth', 'text',
      [['visa status', 1], ['immigration status', 1], ['current visa', 1], ['visa type', 1], ['work permit', 0.85]], {}),
    F('auth.relocate', 'Willing to relocate', 'auth', 'yesno',
      [['relocate', 1], ['relocation', 1], ['willing to move', 1], ['open to relocating', 1]], {}),
    F('auth.remote', 'Work arrangement preference', 'auth', 'text',
      [['work arrangement', 1], ['remote or', 0.9], ['remote hybrid', 0.9], ['work preference', 0.9], ['work location preference', 1], ['onsite', 0.6], ['on site', 0.6], ['hybrid', 0.6]], {}),
    F('auth.over18', 'At least 18 years old', 'auth', 'yesno',
      [['18 years', 1], ['over 18', 1], ['at least 18', 1], ['age of 18', 1], ['legal age', 0.9], ['18 or older', 1]], {}),
    F('auth.clearance', 'Security clearance', 'auth', 'text',
      [['security clearance', 1], ['clearance', 0.9]], {}),
    F('auth.backgroundCheck', 'Consent to background check', 'auth', 'yesno',
      [['background check', 1], ['drug test', 0.9], ['drug screen', 0.9]], {}),

    // Demographics (EEO)
    F('demo.gender', 'Gender', 'demo', 'text',
      [['gender', 1], ['sex', 0.85], ['gender identity', 1]], { neg: ['transgender', 'sexual orientation'] }),
    F('demo.race', 'Race / ethnicity', 'demo', 'text',
      [['race', 1], ['ethnicity', 1], ['ethnic', 0.95], ['racial', 1], ['race ethnicity', 1]], { neg: ['hispanic or latino', 'brace', 'trace', 'embrace'] }),
    F('demo.hispanic', 'Hispanic / Latino', 'demo', 'yesno',
      [['hispanic', 1], ['latino', 1], ['latinx', 1], ['hispanic latino', 1]], {}),
    F('demo.veteran', 'Veteran status', 'demo', 'text',
      [['veteran', 1], ['protected veteran', 1], ['military service', 0.9], ['military', 0.75], ['armed forces', 0.85]], {}),
    F('demo.disability', 'Disability status', 'demo', 'text',
      [['disability', 1], ['disabled', 0.95], ['disabilities', 1]], {}),
    F('demo.orientation', 'Sexual orientation', 'demo', 'text',
      [['sexual orientation', 1], ['orientation', 0.8]], {}),
    F('demo.transgender', 'Transgender', 'demo', 'yesno',
      [['transgender', 1], ['trans', 0.6]], {}),

    // Compensation
    F('salary.expected', 'Expected salary', 'salary', 'number',
      [['salary expectation', 1], ['expected salary', 1], ['desired salary', 1], ['salary requirement', 1], ['salary', 0.9], ['compensation', 0.9], ['desired pay', 1], ['pay expectation', 1], ['expected compensation', 1], ['desired compensation', 1], ['base pay', 0.8], ['rate', 0.4]],
      { neg: ['current salary', 'currency', 'minimum', 'period', 'frequency'] }),
    F('salary.current', 'Current salary', 'salary', 'number',
      [['current salary', 1], ['current compensation', 1], ['present salary', 1], ['current ctc', 1], ['current pay', 1]], {}),
    F('salary.currency', 'Salary currency', 'salary', 'text',
      [['currency', 1], ['salary currency', 1]], {}),

    // Availability & misc
    F('misc.availableStart', 'Available start date', 'misc', 'date',
      [['available start date', 1], ['earliest start', 1], ['available to start', 1], ['availability', 0.8], ['when can you start', 1], ['start date', 0.7], ['date available', 1], ['earliest available', 1]], {}),
    F('misc.noticePeriod', 'Notice period', 'misc', 'text',
      [['notice period', 1], ['notice', 0.7], ['weeks notice', 1]], {}),
    F('misc.yearsExperience', 'Years of experience', 'misc', 'number',
      [['years of experience', 1], ['years experience', 1], ['total experience', 1], ['how many years', 0.9], ['experience years', 1]], {}),
    F('misc.howHeard', 'How did you hear about us', 'misc', 'text',
      [['how did you hear', 1], ['where did you hear', 1], ['how did you find', 1], ['referral source', 1], ['source', 0.6], ['hear about', 1], ['learn about this', 0.9]], {}),
    F('misc.currentCompany', 'Current company', 'misc', 'text',
      [['current company', 1], ['current employer', 1], ['present employer', 1], ['most recent employer', 1], ['most recent company', 1], ['organization', 0.4]], {}),
    F('misc.currentTitle', 'Current title', 'misc', 'text',
      [['current title', 1], ['current job title', 1], ['current position', 1], ['current role', 1], ['headline', 0.7], ['most recent title', 1]], {}),
    F('misc.coverLetterText', 'Cover letter (text)', 'misc', 'longtext',
      [['cover letter', 1], ['letter of interest', 1], ['motivation letter', 1], ['motivational letter', 1]], { only: ['textarea', 'contenteditable'] }),
    F('misc.summary', 'Professional summary', 'misc', 'longtext',
      [['professional summary', 1], ['summary', 0.7], ['about yourself', 0.9], ['about you', 0.8], ['tell us about', 0.7], ['bio', 0.8], ['introduce yourself', 0.9]], { only: ['textarea', 'contenteditable', 'text'] }),
    F('misc.skills', 'Skills', 'misc', 'text',
      [['skills', 1], ['skill', 0.9], ['technologies', 0.85], ['tech stack', 0.9], ['competencies', 0.85], ['expertise', 0.7], ['tools', 0.5]], { neg: ['language'] }),
    F('misc.languages', 'Languages spoken', 'misc', 'text',
      [['languages spoken', 1], ['languages', 0.8], ['language proficiency', 1], ['spoken languages', 1]], { neg: ['programming'] }),

    // Work history (repeatable)
    F('work.company', 'Employer', 'work', 'text',
      [['company name', 1], ['company', 0.95], ['employer', 1], ['employer name', 1], ['organization', 0.75], ['organisation', 0.75], ['firm', 0.6]],
      { ac: ['organization'], neg: ['current company', 'company website', 'how did you hear', 'school'] }),
    F('work.title', 'Job title', 'work', 'text',
      [['job title', 1], ['title', 0.8], ['position', 0.8], ['role', 0.7], ['position title', 1], ['designation', 0.8]],
      { ac: ['organization-title'], neg: ['current title', 'pronoun', 'applying for', 'interested in', 'mr mrs', 'salutation'] }),
    F('work.location', 'Job location', 'work', 'text',
      [['location', 0.6], ['job location', 0.9], ['work location', 0.8], ['city', 0.4]], {}),
    F('work.startDate', 'Job start date', 'work', 'date',
      [['start date', 0.9], ['from', 0.6], ['start', 0.6], ['date started', 0.9], ['started', 0.6], ['date from', 0.9]], {}),
    F('work.endDate', 'Job end date', 'work', 'date',
      [['end date', 0.9], ['to', 0.4], ['end', 0.6], ['date ended', 0.9], ['date to', 0.9], ['until', 0.6]], {}),
    F('work.current', 'Currently work here', 'work', 'bool',
      [['currently work here', 1], ['current job', 0.9], ['i currently work', 1], ['current position', 0.6], ['present', 0.6], ['still working', 1], ['current employer', 0.6]], { only: ['checkbox'] }),
    F('work.description', 'Job description', 'work', 'longtext',
      [['description', 0.9], ['responsibilities', 1], ['duties', 1], ['accomplishments', 0.9], ['role description', 1], ['summary', 0.5], ['achievements', 0.9]], {}),

    // Education (repeatable)
    F('edu.school', 'School', 'edu', 'text',
      [['school', 1], ['university', 1], ['college', 1], ['institution', 1], ['school name', 1], ['university name', 1], ['academy', 0.7]], { neg: ['high school diploma'] }),
    F('edu.degree', 'Degree', 'edu', 'text',
      [['degree', 1], ['qualification', 0.85], ['degree type', 1], ['level of education', 1], ['education level', 1], ['highest degree', 0.9]], {}),
    F('edu.field', 'Field of study', 'edu', 'text',
      [['field of study', 1], ['major', 1], ['discipline', 0.9], ['concentration', 0.9], ['area of study', 1], ['specialization', 0.9], ['course of study', 1], ['program', 0.5]], {}),
    F('edu.gpa', 'GPA', 'edu', 'text',
      [['gpa', 1], ['grade point', 1], ['grade', 0.6], ['cgpa', 1], ['grades', 0.6]], {}),
    F('edu.startDate', 'Education start date', 'edu', 'date',
      [['start date', 0.85], ['from', 0.6], ['start', 0.6], ['date started', 0.9]], {}),
    F('edu.endDate', 'Graduation date', 'edu', 'date',
      [['graduation date', 1], ['graduation', 0.95], ['expected graduation', 1], ['end date', 0.85], ['to', 0.4], ['end', 0.6], ['completion date', 0.9], ['grad date', 1]], {}),

    // Files
    F('files.resume', 'Resume / CV', 'files', 'file',
      [['resume', 1], ['cv', 1], ['curriculum vitae', 1], ['resume cv', 1]], { only: ['file'], neg: ['cover'] }),
    F('files.coverLetter', 'Cover letter file', 'files', 'file',
      [['cover letter', 1], ['coverletter', 1], ['letter', 0.6]], { only: ['file'] }),
  ];

  // Section vocab: words around a field that indicate which part of a form it lives in.
  const SECTIONS = {
    work: ['work experience', 'experience', 'employment', 'work history', 'job history', 'employment history', 'professional experience', 'previous employer', 'positions', 'jobs', 'career'],
    edu: ['education', 'academic', 'school', 'university', 'degrees', 'educational background', 'schooling'],
    demo: ['voluntary', 'self identification', 'self identify', 'eeo', 'equal employment', 'demographic', 'diversity'],
    address: ['address', 'mailing', 'residence'],
  };

  const byKey = Object.fromEntries(FIELDS.map(f => [f.key, f]));
  const GROUP_LABELS = {
    contact: 'Contact', address: 'Address', links: 'Links', auth: 'Work authorization', demo: 'Demographics',
    salary: 'Compensation', misc: 'Other', work: 'Work history', edu: 'Education', files: 'Files', qa: 'Custom answers',
  };

  globalThis.SmartAutofillFields = { FIELDS, SECTIONS, byKey, GROUP_LABELS };
})();
