/* Accessibility Auditor - ARIA role and attribute tables (WAI-ARIA 1.2 subset).
 * Exposes window.A11Y.aria
 */
(function (root) {
  'use strict';
  const A11Y = (root.A11Y = root.A11Y || {});
  if (A11Y.aria) return;

  const GLOBAL_ATTRS = [
    'aria-atomic', 'aria-braillelabel', 'aria-brailleroledescription', 'aria-busy',
    'aria-controls', 'aria-current', 'aria-describedby', 'aria-description', 'aria-details',
    'aria-dropeffect', 'aria-flowto', 'aria-grabbed', 'aria-hidden', 'aria-keyshortcuts',
    'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant',
    'aria-roledescription',
    // Deprecated as global in ARIA 1.2 but still valid on every role; flagging them
    // would only produce noise.
    'aria-disabled', 'aria-errormessage', 'aria-haspopup', 'aria-invalid',
  ];

  // Roles that never take a name from their own content and must not be labelled.
  const NO_NAME_ROLES = new Set([
    'caption', 'code', 'deletion', 'emphasis', 'generic', 'insertion', 'paragraph',
    'presentation', 'none', 'strong', 'subscript', 'superscript',
  ]);

  // role -> { required: [], supported: [], children: [], parent: [], abstract: bool, nameFrom: 'content'|'author'|'prohibited' }
  const ROLES = {
    alert: { supported: ['aria-expanded'], live: true },
    alertdialog: { supported: ['aria-expanded', 'aria-modal'], nameRequired: true },
    application: { nameRequired: true },
    article: { supported: ['aria-posinset', 'aria-setsize', 'aria-expanded'] },
    associationlist: {},
    associationlistitemkey: {},
    associationlistitemvalue: {},
    banner: {},
    blockquote: {},
    button: {
      supported: ['aria-expanded', 'aria-pressed', 'aria-haspopup', 'aria-disabled'],
      nameFrom: 'content', nameRequired: true,
    },
    caption: { nameFrom: 'prohibited' },
    cell: { supported: ['aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan', 'aria-expanded'], parent: ['row'], nameFrom: 'content' },
    checkbox: { required: ['aria-checked'], supported: ['aria-readonly', 'aria-required', 'aria-disabled', 'aria-expanded'], nameFrom: 'content', nameRequired: true },
    code: { nameFrom: 'prohibited' },
    columnheader: { supported: ['aria-sort', 'aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan', 'aria-expanded', 'aria-readonly', 'aria-required', 'aria-selected'], parent: ['row'], nameFrom: 'content' },
    combobox: {
      required: ['aria-expanded'],
      supported: ['aria-controls', 'aria-autocomplete', 'aria-readonly', 'aria-required', 'aria-activedescendant', 'aria-haspopup', 'aria-disabled'],
      nameRequired: true,
    },
    command: { abstract: true },
    comment: { supported: ['aria-level', 'aria-posinset', 'aria-setsize'] },
    complementary: {},
    composite: { abstract: true },
    contentinfo: {},
    definition: {},
    deletion: { nameFrom: 'prohibited' },
    dialog: { supported: ['aria-modal', 'aria-expanded'], nameRequired: true },
    directory: {},
    document: {},
    emphasis: { nameFrom: 'prohibited' },
    feed: { children: ['article'], supported: ['aria-expanded'] },
    figure: { nameFrom: 'content' },
    form: {},
    generic: { nameFrom: 'prohibited' },
    grid: { children: ['row', 'rowgroup'], supported: ['aria-level', 'aria-multiselectable', 'aria-readonly', 'aria-activedescendant', 'aria-colcount', 'aria-rowcount', 'aria-expanded'], nameRequired: true },
    gridcell: { supported: ['aria-readonly', 'aria-required', 'aria-selected', 'aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan', 'aria-expanded', 'aria-disabled'], parent: ['row'], nameFrom: 'content' },
    group: { supported: ['aria-activedescendant', 'aria-disabled', 'aria-expanded'] },
    heading: { required: ['aria-level'], nameFrom: 'content', nameRequired: true },
    image: { nameRequired: true },
    img: { nameRequired: true, supported: ['aria-expanded'] },
    input: { abstract: true },
    insertion: { nameFrom: 'prohibited' },
    landmark: { abstract: true },
    link: { supported: ['aria-expanded', 'aria-haspopup', 'aria-disabled', 'aria-current'], nameFrom: 'content', nameRequired: true },
    list: { children: ['listitem', 'group'] },
    listbox: {
      children: ['option', 'group'],
      supported: ['aria-multiselectable', 'aria-readonly', 'aria-required', 'aria-activedescendant', 'aria-orientation', 'aria-expanded', 'aria-disabled', 'aria-invalid'],
      nameRequired: true,
    },
    listitem: { supported: ['aria-level', 'aria-posinset', 'aria-setsize', 'aria-expanded'], parent: ['list', 'group'] },
    log: { live: true },
    main: {},
    marquee: { live: true },
    math: {},
    menu: { children: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group'], supported: ['aria-activedescendant', 'aria-orientation', 'aria-expanded'] },
    menubar: { children: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'group'], supported: ['aria-activedescendant', 'aria-orientation', 'aria-expanded'] },
    menuitem: { supported: ['aria-expanded', 'aria-haspopup', 'aria-posinset', 'aria-setsize', 'aria-disabled'], parent: ['menu', 'menubar', 'group'], nameFrom: 'content', nameRequired: true },
    menuitemcheckbox: { required: ['aria-checked'], supported: ['aria-posinset', 'aria-setsize', 'aria-disabled'], parent: ['menu', 'menubar', 'group'], nameFrom: 'content', nameRequired: true },
    menuitemradio: { required: ['aria-checked'], supported: ['aria-posinset', 'aria-setsize', 'aria-disabled'], parent: ['menu', 'menubar', 'group'], nameFrom: 'content', nameRequired: true },
    meter: { required: ['aria-valuenow'], supported: ['aria-valuemin', 'aria-valuemax', 'aria-valuetext'], nameRequired: true },
    navigation: {},
    none: { nameFrom: 'prohibited' },
    note: {},
    option: { required: ['aria-selected'], supported: ['aria-checked', 'aria-posinset', 'aria-setsize', 'aria-disabled'], parent: ['listbox', 'group'], nameFrom: 'content', nameRequired: true },
    paragraph: { nameFrom: 'prohibited' },
    presentation: { nameFrom: 'prohibited' },
    progressbar: { supported: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-expanded'], nameRequired: true },
    radio: { required: ['aria-checked'], supported: ['aria-posinset', 'aria-setsize', 'aria-disabled'], nameFrom: 'content', nameRequired: true },
    radiogroup: { children: ['radio'], supported: ['aria-readonly', 'aria-required', 'aria-activedescendant', 'aria-orientation', 'aria-expanded', 'aria-invalid', 'aria-disabled'], nameRequired: true },
    range: { abstract: true },
    region: { supported: ['aria-expanded'], nameRequired: true },
    roletype: { abstract: true },
    row: { children: ['cell', 'columnheader', 'gridcell', 'rowheader'], supported: ['aria-colindex', 'aria-level', 'aria-rowindex', 'aria-selected', 'aria-setsize', 'aria-posinset', 'aria-expanded', 'aria-activedescendant'], parent: ['grid', 'rowgroup', 'table', 'treegrid'], nameFrom: 'content' },
    rowgroup: { children: ['row'], parent: ['grid', 'table', 'treegrid'] },
    rowheader: { supported: ['aria-sort', 'aria-colindex', 'aria-colspan', 'aria-rowindex', 'aria-rowspan', 'aria-expanded', 'aria-readonly', 'aria-required', 'aria-selected'], parent: ['row'], nameFrom: 'content' },
    scrollbar: { required: ['aria-valuenow', 'aria-controls'], supported: ['aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-orientation', 'aria-disabled'] },
    search: {},
    searchbox: { supported: ['aria-activedescendant', 'aria-autocomplete', 'aria-multiline', 'aria-placeholder', 'aria-readonly', 'aria-required', 'aria-disabled', 'aria-invalid'], nameRequired: true },
    section: { abstract: true },
    sectionhead: { abstract: true },
    select: { abstract: true },
    separator: { supported: ['aria-orientation', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-disabled'] },
    slider: { required: ['aria-valuenow'], supported: ['aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-orientation', 'aria-readonly', 'aria-required', 'aria-disabled'], nameRequired: true },
    spinbutton: { supported: ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext', 'aria-readonly', 'aria-required', 'aria-activedescendant', 'aria-disabled', 'aria-invalid'], nameRequired: true },
    status: { supported: ['aria-expanded'], live: true },
    strong: { nameFrom: 'prohibited' },
    structure: { abstract: true },
    subscript: { nameFrom: 'prohibited' },
    suggestion: {},
    superscript: { nameFrom: 'prohibited' },
    switch: { required: ['aria-checked'], supported: ['aria-readonly', 'aria-required', 'aria-disabled', 'aria-expanded'], nameFrom: 'content', nameRequired: true },
    tab: { supported: ['aria-selected', 'aria-expanded', 'aria-posinset', 'aria-setsize', 'aria-disabled'], parent: ['tablist', 'group'], nameFrom: 'content', nameRequired: true },
    table: { children: ['row', 'rowgroup'], supported: ['aria-colcount', 'aria-rowcount', 'aria-expanded'], nameFrom: 'author' },
    tablist: { children: ['tab'], supported: ['aria-level', 'aria-multiselectable', 'aria-orientation', 'aria-activedescendant', 'aria-expanded'] },
    tabpanel: { supported: ['aria-expanded'], nameRequired: true },
    term: {},
    textbox: { supported: ['aria-activedescendant', 'aria-autocomplete', 'aria-multiline', 'aria-placeholder', 'aria-readonly', 'aria-required', 'aria-disabled', 'aria-invalid'], nameRequired: true },
    time: {},
    timer: { live: true },
    toolbar: { supported: ['aria-orientation', 'aria-activedescendant', 'aria-expanded'] },
    tooltip: { nameFrom: 'content' },
    tree: { children: ['treeitem', 'group'], supported: ['aria-multiselectable', 'aria-required', 'aria-activedescendant', 'aria-orientation', 'aria-expanded'], nameRequired: true },
    treegrid: { children: ['row', 'rowgroup'], supported: ['aria-activedescendant', 'aria-colcount', 'aria-rowcount', 'aria-multiselectable', 'aria-readonly', 'aria-required', 'aria-orientation', 'aria-expanded'], nameRequired: true },
    treeitem: { supported: ['aria-checked', 'aria-expanded', 'aria-level', 'aria-posinset', 'aria-setsize', 'aria-selected', 'aria-disabled'], parent: ['tree', 'group'], nameFrom: 'content', nameRequired: true },
    widget: { abstract: true },
    window: { abstract: true },
  };

  // Attribute value types for aria-* validation.
  const ATTR_TYPES = {
    'aria-activedescendant': { type: 'id' },
    'aria-atomic': { type: 'boolean' },
    'aria-autocomplete': { type: 'token', values: ['inline', 'list', 'both', 'none'] },
    'aria-braillelabel': { type: 'string' },
    'aria-brailleroledescription': { type: 'string' },
    'aria-busy': { type: 'boolean' },
    'aria-checked': { type: 'token', values: ['true', 'false', 'mixed', 'undefined'] },
    'aria-colcount': { type: 'integer' },
    'aria-colindex': { type: 'integer' },
    'aria-colspan': { type: 'integer' },
    'aria-controls': { type: 'idlist' },
    'aria-current': { type: 'token', values: ['page', 'step', 'location', 'date', 'time', 'true', 'false'] },
    'aria-describedby': { type: 'idlist' },
    'aria-description': { type: 'string' },
    'aria-details': { type: 'idlist' },
    'aria-disabled': { type: 'boolean' },
    'aria-dropeffect': { type: 'tokenlist', values: ['copy', 'execute', 'link', 'move', 'none', 'popup'] },
    'aria-errormessage': { type: 'idlist' },
    'aria-expanded': { type: 'token', values: ['true', 'false', 'undefined'] },
    'aria-flowto': { type: 'idlist' },
    'aria-grabbed': { type: 'token', values: ['true', 'false', 'undefined'] },
    'aria-haspopup': { type: 'token', values: ['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog'] },
    'aria-hidden': { type: 'token', values: ['true', 'false', 'undefined'] },
    'aria-invalid': { type: 'token', values: ['grammar', 'false', 'spelling', 'true'] },
    'aria-keyshortcuts': { type: 'string' },
    'aria-label': { type: 'string' },
    'aria-labelledby': { type: 'idlist' },
    'aria-level': { type: 'integer' },
    'aria-live': { type: 'token', values: ['assertive', 'off', 'polite'] },
    'aria-modal': { type: 'boolean' },
    'aria-multiline': { type: 'boolean' },
    'aria-multiselectable': { type: 'boolean' },
    'aria-orientation': { type: 'token', values: ['horizontal', 'vertical', 'undefined'] },
    'aria-owns': { type: 'idlist' },
    'aria-placeholder': { type: 'string' },
    'aria-posinset': { type: 'integer' },
    'aria-pressed': { type: 'token', values: ['true', 'false', 'mixed', 'undefined'] },
    'aria-readonly': { type: 'boolean' },
    'aria-relevant': { type: 'tokenlist', values: ['additions', 'all', 'removals', 'text', 'additions text'] },
    'aria-required': { type: 'boolean' },
    'aria-roledescription': { type: 'string' },
    'aria-rowcount': { type: 'integer' },
    'aria-rowindex': { type: 'integer' },
    'aria-rowspan': { type: 'integer' },
    'aria-selected': { type: 'token', values: ['true', 'false', 'undefined'] },
    'aria-setsize': { type: 'integer' },
    'aria-sort': { type: 'token', values: ['ascending', 'descending', 'none', 'other'] },
    'aria-valuemax': { type: 'number' },
    'aria-valuemin': { type: 'number' },
    'aria-valuenow': { type: 'number' },
    'aria-valuetext': { type: 'string' },
  };

  // Native elements whose semantics ARIA must not override with role=presentation/none,
  // plus elements that take no role at all.
  const NO_ROLE_ELEMENTS = new Set(['base', 'head', 'html', 'link', 'meta', 'script', 'style', 'title']);

  const LANDMARK_ROLES = new Set(['banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search']);

  const INTERACTIVE_ROLES = new Set([
    'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch',
    'tab', 'textbox', 'treeitem', 'scrollbar',
  ]);

  // DPUB-ARIA 1.1 and Graphics-ARIA roles are valid too (they map onto core roles).
  const EXTRA_ROLES = new Set([
    'doc-abstract', 'doc-acknowledgments', 'doc-afterword', 'doc-appendix', 'doc-backlink',
    'doc-biblioentry', 'doc-bibliography', 'doc-biblioref', 'doc-chapter', 'doc-colophon',
    'doc-conclusion', 'doc-cover', 'doc-credit', 'doc-credits', 'doc-dedication', 'doc-endnote',
    'doc-endnotes', 'doc-epigraph', 'doc-epilogue', 'doc-errata', 'doc-example', 'doc-footnote',
    'doc-foreword', 'doc-glossary', 'doc-glossref', 'doc-index', 'doc-introduction', 'doc-noteref',
    'doc-notice', 'doc-pagebreak', 'doc-pagefooter', 'doc-pageheader', 'doc-pagelist', 'doc-part',
    'doc-preface', 'doc-prologue', 'doc-pullquote', 'doc-qna', 'doc-subtitle', 'doc-tip', 'doc-toc',
    'graphics-document', 'graphics-object', 'graphics-symbol',
  ]);

  function isValidRole(role) {
    if (EXTRA_ROLES.has(role)) return true;
    const def = ROLES[role];
    return !!def && !def.abstract;
  }

  function isAbstract(role) {
    return !!(ROLES[role] && ROLES[role].abstract);
  }

  function allowedAttrs(role) {
    const def = ROLES[role];
    const list = GLOBAL_ATTRS.slice();
    if (!def) return list;
    (def.required || []).forEach((a) => list.push(a));
    (def.supported || []).forEach((a) => list.push(a));
    // aria-errormessage/invalid/required ride along with anything form-ish.
    return list;
  }

  function validateValue(attr, raw) {
    const spec = ATTR_TYPES[attr];
    if (!spec) return { ok: true };
    const value = (raw == null ? '' : String(raw)).trim();
    switch (spec.type) {
      case 'boolean':
        return { ok: value === 'true' || value === 'false', expected: 'true or false' };
      case 'token':
        return { ok: spec.values.indexOf(value.toLowerCase()) !== -1, expected: spec.values.join(', ') };
      case 'tokenlist': {
        const parts = value.toLowerCase().split(/\s+/).filter(Boolean);
        return { ok: parts.length > 0 && parts.every((p) => spec.values.indexOf(p) !== -1), expected: spec.values.join(', ') };
      }
      case 'integer': {
        const n = Number(value);
        return { ok: value !== '' && Number.isInteger(n), expected: 'an integer' };
      }
      case 'number': {
        const n = Number(value);
        return { ok: value !== '' && !isNaN(n), expected: 'a number' };
      }
      case 'id':
      case 'idlist':
        return { ok: value !== '', expected: 'one or more element ids' };
      case 'string':
        return { ok: true };
      default:
        return { ok: true };
    }
  }

  A11Y.aria = {
    ROLES, ATTR_TYPES, GLOBAL_ATTRS, NO_NAME_ROLES, NO_ROLE_ELEMENTS,
    LANDMARK_ROLES, INTERACTIVE_ROLES, EXTRA_ROLES,
    isValidRole, isAbstract, allowedAttrs, validateValue,
  };
})(typeof window !== 'undefined' ? window : self);
