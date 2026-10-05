// AcroForm fields and links rendered as HTML over each page, and writing values back with pdf-lib.

const WIDGET = 20;
const LINK = 2;

export class FieldLayer {
  /**
   * opts: { onChange(), onLink(dest), onSignField(field), toUnitsRect(pageIndex, rect) -> {x,y,w,h} }
   */
  constructor(opts) {
    this.o = opts;
    this.values = new Map(); // fieldName -> value
    this.initial = new Map();
    this.inputs = new Map(); // fieldName -> [elements]
    this.changed = new Set();
    this.fieldCount = 0;
    this.attached = new Set();
    this.highlight = true;
  }

  reset() {
    this.values.clear();
    this.initial.clear();
    this.inputs.clear();
    this.changed.clear();
    this.attached.clear();
    this.fieldCount = 0;
  }

  /** Count fields up front so the toolbar can say "12 fillable fields". */
  async scan(pdf) {
    try {
      const objs = await pdf.getFieldObjects();
      if (!objs) return 0;
      this.fieldCount = Object.values(objs).filter((list) => list.some((f) => ['text', 'checkbox', 'radiobutton', 'combobox', 'listbox'].includes(f.type))).length;
    } catch {
      this.fieldCount = 0;
    }
    return this.fieldCount;
  }

  async attach(pageIndex, pdfPage, layerEl, size) {
    if (this.attached.has(pageIndex)) return;
    this.attached.add(pageIndex);
    layerEl.style.width = size.w + 'px';
    layerEl.style.height = size.h + 'px';
    let annots;
    try {
      annots = await pdfPage.getAnnotations({ intent: 'display' });
    } catch {
      return;
    }
    const frag = document.createDocumentFragment();
    for (const a of annots) {
      if (a.hidden || !a.rect) continue;
      const r = this.o.toUnitsRect(pageIndex, a.rect);
      if (r.w < 1 || r.h < 1) continue;
      if (a.annotationType === LINK && (a.url || a.dest || a.unsafeUrl)) {
        frag.append(this._link(a, r));
      } else if (a.annotationType === WIDGET && a.fieldName) {
        const el = this._widget(a, r, pageIndex);
        if (el) frag.append(el);
      }
    }
    layerEl.append(frag);
    layerEl.classList.toggle('hide-fields', !this.highlight);
  }

  setHighlight(on) {
    this.highlight = on;
    document.querySelectorAll('.form-layer').forEach((el) => el.classList.toggle('hide-fields', !on));
  }

  _place(el, r) {
    Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  }

  _link(a, r) {
    const el = document.createElement('a');
    el.className = 'link';
    this._place(el, r);
    const url = a.url || a.unsafeUrl;
    if (url && /^(https?:|mailto:)/i.test(url)) {
      el.href = url;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.title = url;
    } else if (a.dest) {
      el.href = '#';
      el.title = 'Go to destination';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.o.onLink(a.dest);
      });
    } else {
      return document.createComment('unsupported link');
    }
    return el;
  }

  _register(name, el) {
    if (!this.inputs.has(name)) this.inputs.set(name, []);
    this.inputs.get(name).push(el);
  }

  _setValue(name, value, source) {
    this.values.set(name, value);
    if (JSON.stringify(value) !== JSON.stringify(this.initial.get(name))) this.changed.add(name);
    else this.changed.delete(name);
    for (const el of this.inputs.get(name) || []) {
      if (el === source) continue;
      this._show(el, value);
    }
    this.o.onChange();
  }

  _show(el, value) {
    if (el.type === 'checkbox') el.checked = value === el.dataset.on;
    else if (el.type === 'radio') el.checked = value === el.dataset.on;
    else if (el.multiple) [...el.options].forEach((o) => { o.selected = Array.isArray(value) && value.includes(o.value); });
    else el.value = value ?? '';
  }

  _widget(a, r, pageIndex) {
    const name = a.fieldName;
    const fs = Math.max(6, Math.min(a.defaultAppearanceData?.fontSize || 0 || Math.min(r.h * 0.68, 12), 48));
    let el;
    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input');
      if (!a.multiLine) el.type = 'text';
      if (a.maxLen) el.maxLength = a.maxLen;
      el.style.fontSize = (a.multiLine ? Math.min(fs, 12) : fs) + 'px';
      if (a.comb && a.maxLen) el.style.letterSpacing = `calc(${r.w / a.maxLen}px - 1ch)`;
      el.style.textAlign = ['left', 'center', 'right'][a.textAlignment || 0];
      if (!this.values.has(name)) this._init(name, a.fieldValue ?? '');
      el.value = this.values.get(name) ?? '';
      el.addEventListener('input', () => this._setValue(name, el.value, el));
    } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
      el = document.createElement('input');
      el.type = a.checkBox ? 'checkbox' : 'radio';
      const on = a.checkBox ? a.exportValue : a.buttonValue;
      el.dataset.on = on;
      el.name = 'f_' + name;
      if (!this.values.has(name)) {
        const v = a.fieldValue;
        const init = a.checkBox ? (v && v !== 'Off' ? v : 'Off') : (v && v !== 'Off' ? v : null);
        this._init(name, init);
      }
      el.checked = this.values.get(name) === on;
      el.addEventListener('change', () => {
        if (a.checkBox) this._setValue(name, el.checked ? on : 'Off', el);
        else if (el.checked) this._setValue(name, on, el);
      });
      // Allow unchecking a radio by clicking it again (like most PDF viewers).
      if (a.radioButton) {
        el.addEventListener('pointerdown', () => { el._wasChecked = el.checked; });
        el.addEventListener('click', () => {
          if (el._wasChecked && !a.radiosInUnison) {
            el.checked = false;
            this._setValue(name, null, el);
          }
        });
      }
    } else if (a.fieldType === 'Ch') {
      el = document.createElement('select');
      el.style.fontSize = fs + 'px';
      if (a.multiSelect) el.multiple = true;
      if (a.combo && !a.multiSelect) {
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '';
        el.append(blank);
      }
      for (const opt of a.options || []) {
        const o = document.createElement('option');
        o.value = opt.exportValue ?? opt.displayValue;
        o.textContent = opt.displayValue ?? opt.exportValue;
        el.append(o);
      }
      if (!this.values.has(name)) {
        const v = a.fieldValue;
        this._init(name, a.multiSelect ? (Array.isArray(v) ? v : v ? [v] : []) : (Array.isArray(v) ? v[0] ?? '' : v ?? ''));
      }
      this._show(el, this.values.get(name));
      el.addEventListener('change', () => {
        const v = el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value;
        this._setValue(name, v, el);
      });
    } else if (a.fieldType === 'Sig') {
      el = document.createElement('button');
      el.type = 'button';
      el.textContent = 'Click to sign';
      el.style.fontSize = Math.min(r.h * 0.4, 12) + 'px';
      el.style.color = '#1d4ed8';
      el.addEventListener('click', () => this.o.onSignField({ page: pageIndex, ...r }));
    } else {
      return null;
    }
    el.classList.add('ff');
    el.title = a.alternativeText || name;
    el.setAttribute('aria-label', a.alternativeText || name);
    if (a.readOnly) {
      el.disabled = true;
      el.tabIndex = -1;
    }
    this._place(el, r);
    this._register(name, el);
    return el;
  }

  _init(name, value) {
    this.values.set(name, value);
    this.initial.set(name, value);
  }

  get dirty() {
    return this.changed.size > 0;
  }

  /** Write changed values into a pdf-lib document. Returns { filled, failed: [names], replacedChars } */
  apply(doc, { flatten = false } = {}) {
    const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, StandardFonts } = globalThis.PDFLib;
    const result = { filled: 0, failed: [], replacedChars: 0 };
    let form;
    try {
      form = doc.getForm();
    } catch {
      return result;
    }
    if (!this.changed.size && !flatten) return result;
    for (const name of this.changed) {
      const v = this.values.get(name);
      try {
        const field = form.getFieldMaybe ? form.getFieldMaybe(name) : form.getField(name);
        if (!field) throw new Error('missing');
        if (field instanceof PDFTextField) {
          const { text, replaced } = winAnsi(String(v ?? ''));
          result.replacedChars += replaced;
          const max = field.getMaxLength();
          field.setText(max !== undefined ? text.slice(0, max) : text);
        } else if (field instanceof PDFCheckBox) {
          if (v && v !== 'Off') field.check();
          else field.uncheck();
        } else if (field instanceof PDFRadioGroup) {
          if (v == null) field.clear();
          else {
            const opts = field.getOptions();
            field.select(opts.includes(v) ? v : opts.find((o) => o.toLowerCase() === String(v).toLowerCase()) ?? v);
          }
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
          const list = Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [];
          if (!list.length) field.clear();
          else field.select(list.length === 1 ? list[0] : list);
        }
        result.filled++;
      } catch (e) {
        result.failed.push(name);
      }
    }
    if (result.filled) {
      try {
        const helv = doc.embedStandardFont(StandardFonts.Helvetica);
        form.updateFieldAppearances(helv);
      } catch {
        /* appearances are regenerated on save as a fallback */
      }
    }
    if (flatten) {
      try {
        form.flatten();
      } catch {
        result.failed.push('(flatten)');
      }
    }
    return result;
  }
}

// Helvetica (WinAnsi) can't encode everything; replace what it can't with "?" so saving never fails.
const WIN_ANSI_EXTRA = new Set([0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);
function winAnsi(str) {
  let replaced = 0;
  let text = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c === 10 || c === 13 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(c)) text += ch;
    else {
      text += '?';
      replaced++;
    }
  }
  return { text, replaced };
}
