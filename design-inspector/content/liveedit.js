/* Live edit mode: edit text, nudge spacing, change colors and fonts, and copy the resulting CSS. */
import { h, clear, elementAt, cssPath, tagLabel, copyText, num } from './util.js';
import { parseColor, toHex } from './color.js';
import { drawBox, outlineBox } from './inspect.js';

const SIDES = ['top', 'right', 'bottom', 'left'];
const FONT_SUGGESTIONS = ['system-ui, sans-serif', 'Inter, sans-serif', 'Helvetica, Arial, sans-serif', 'Georgia, serif', '"Times New Roman", serif', 'ui-monospace, Menlo, Consolas, monospace'];

/** Build the CSS text for a list of change records. Pure, so it can be unit tested. */
export function changesToCss(records, { source = '' } = {}) {
  const blocks = [];
  for (const r of records) {
    const props = [...r.props];
    if (props.length) blocks.push(`${r.selector} {\n${props.map(([p, v]) => `  ${p}: ${v};`).join('\n')}\n}`);
    if (r.text && r.text.after != null && r.text.after !== r.text.before) {
      const clip = s => (s.length > 120 ? s.slice(0, 119) + '…' : s).replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
      blocks.push(`/* Text in ${r.selector}: "${clip(r.text.before)}" → "${clip(r.text.after)}" */`);
    }
  }
  if (!blocks.length) return '';
  return `${source ? `/* Design Inspector edits on ${source} */\n` : ''}${blocks.join('\n\n')}\n`;
}

/** Parse "prop: value; prop2: value2" into pairs. */
export function parseDeclarations(text) {
  const out = [];
  for (const part of String(text).replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).replace(/!important\s*$/i, '').trim();
    if (/^(--)?[a-z][a-z0-9-]*$/.test(prop) && value) out.push([prop, value]);
  }
  return out;
}

export function createLiveEdit(app) {
  const changes = new Map(); // el -> {selector, original: Map, props: Map, text}
  let hover = null;
  let selected = null;
  let editing = null; // element with contenteditable on
  let fields = null; // {refresh()}
  const layer = () => app.layer('edit');

  /* ----------------------------------------------------------- records */
  function record(el) {
    let r = changes.get(el);
    if (!r) {
      r = { selector: cssPath(el), original: new Map(), props: new Map(), text: null };
      changes.set(el, r);
    }
    return r;
  }

  function setProp(el, prop, value) {
    const r = record(el);
    if (!r.original.has(prop)) r.original.set(prop, { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    const restore = () => {
      const o = r.original.get(prop);
      if (o.value) el.style.setProperty(prop, o.value, o.priority);
      else el.style.removeProperty(prop);
      r.props.delete(prop);
    };
    value = String(value == null ? '' : value).trim();
    if (!value) {
      restore();
    } else {
      el.style.setProperty(prop, value, 'important');
      if (!el.style.getPropertyValue(prop)) {
        restore();
        updateOutput();
        return false;
      }
      r.props.set(prop, value);
    }
    cleanup(el);
    updateOutput();
    app.requestRedraw();
    return true;
  }

  function cleanup(el) {
    const r = changes.get(el);
    if (r && !r.props.size && !r.text && el !== editing) changes.delete(el);
  }

  function resetElement(el) {
    const r = changes.get(el);
    if (!r) return;
    if (el === editing) stopText();
    for (const [prop, o] of r.original) {
      if (o.value) el.style.setProperty(prop, o.value, o.priority);
      else el.style.removeProperty(prop);
    }
    if (r.text && r.text.beforeHTML != null) el.innerHTML = r.text.beforeHTML;
    changes.delete(el);
  }

  /* -------------------------------------------------------------- text */
  function startText(el) {
    stopText();
    const r = record(el);
    if (!r.text) r.text = { before: el.innerText, beforeHTML: el.innerHTML, after: null, attr: el.getAttribute('contenteditable') };
    editing = el;
    el.setAttribute('contenteditable', 'true');
    el.focus({ preventScroll: true });
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
    el.addEventListener('input', onTextInput);
    renderPanel();
    app.requestRedraw();
  }

  function onTextInput() {
    if (!editing) return;
    const r = record(editing);
    r.text.after = editing.innerText;
    updateOutput();
  }

  function stopText() {
    if (!editing) return;
    const el = editing;
    editing = null;
    el.removeEventListener('input', onTextInput);
    const r = changes.get(el);
    if (r && r.text) {
      r.text.after = el.innerText;
      if (r.text.attr == null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', r.text.attr);
      if (r.text.after === r.text.before) r.text = null;
    }
    if (el.blur) el.blur();
    cleanup(el);
    if (selected) renderPanel();
    app.requestRedraw();
  }

  /* -------------------------------------------------------------- panel */
  let outputEl = null;
  function updateOutput() {
    if (outputEl) outputEl.value = changesToCss([...changes.values()], { source: location.host }) || '/* No changes yet */';
  }

  function textField(prop, label, opts = {}) {
    const input = h('input', { type: 'text', spellcheck: 'false', 'aria-label': label, list: opts.list || null, placeholder: opts.placeholder || '' });
    const read = () => {
      if (!selected) return;
      input.value = opts.read ? opts.read(getComputedStyle(selected)) : getComputedStyle(selected).getPropertyValue(prop);
      input.classList.remove('invalid');
    };
    input.addEventListener('input', () => {
      if (!selected) return;
      const ok = setProp(selected, prop, opts.write ? opts.write(input.value) : input.value);
      input.style.borderColor = ok || !input.value ? '' : 'var(--di-bad)';
    });
    input.addEventListener('keydown', e => {
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && /^-?[\d.]+(px|em|rem|%)?$/.test(input.value.trim())) {
        e.preventDefault();
        const m = /^(-?[\d.]+)(\D*)$/.exec(input.value.trim());
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1) * (/(em|rem)$/.test(m[2]) ? 0.1 : 1);
        input.value = `${Math.round((parseFloat(m[1]) + step) * 100) / 100}${m[2] || 'px'}`;
        input.dispatchEvent(new Event('input'));
      }
    });
    return { el: h('label.field', label, input), read, input };
  }

  function colorField(prop, label) {
    const picker = h('input', { type: 'color', 'aria-label': `${label} picker` });
    const text = h('input', { type: 'text', spellcheck: 'false', 'aria-label': label });
    const read = () => {
      if (!selected) return;
      const c = parseColor(getComputedStyle(selected).getPropertyValue(prop));
      if (c) {
        picker.value = toHex(c);
        if (app.shadow.activeElement !== text) text.value = c.a === 0 ? 'transparent' : toHex(c, true);
      }
    };
    picker.addEventListener('input', () => {
      if (!selected) return;
      text.value = picker.value;
      setProp(selected, prop, picker.value);
    });
    text.addEventListener('input', () => {
      if (!selected || !parseColor(text.value)) return;
      setProp(selected, prop, text.value);
      const c = parseColor(text.value);
      picker.value = toHex(c);
    });
    return { el: h('label.field', label, h('div.row', picker, h('div.grow', text))), read };
  }

  function sideFields(kind) {
    const inputs = SIDES.map(side => {
      const prop = `${kind}-${side}`;
      const input = h('input', { type: 'number', step: '1', 'aria-label': `${kind} ${side}`, title: `${kind}-${side} (Shift+Arrow = 10px)` });
      input.addEventListener('input', () => {
        if (selected && input.value !== '') setProp(selected, prop, `${input.value}px`);
      });
      input.addEventListener('keydown', e => {
        if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          input.value = String((parseFloat(input.value) || 0) + (e.key === 'ArrowUp' ? 10 : -10));
          input.dispatchEvent(new Event('input'));
        }
      });
      return { side, prop, input };
    });
    const read = () => {
      if (!selected) return;
      const cs = getComputedStyle(selected);
      for (const i of inputs) if (app.shadow.activeElement !== i.input) i.input.value = String(num(cs.getPropertyValue(i.prop)));
    };
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '64px repeat(4, 1fr)', gap: '4px', alignItems: 'center' } },
      h('span.hint', kind === 'margin' ? 'Margin' : 'Padding'), inputs.map(i => i.input));
    return { el: grid, read };
  }

  function renderPanel() {
    if (!selected) {
      outputEl = h('textarea', { readonly: true, 'aria-label': 'Resulting CSS', spellcheck: 'false' });
      app.showPanel('edit', {
        title: 'Live edit',
        body: [
          h('div.hint', 'Click any element on the page to edit it. Arrow keys nudge margin, Shift+Arrow nudges padding (hold Alt for 10px).'),
          h('section.sect', h('div.sect-head', 'Resulting CSS', h('span.count', String(changes.size))), h('div.sect-body', outputEl)),
        ],
        foot: footButtons(),
        onClose: replacing => { if (!replacing && app.mode === 'edit') app.setMode(null); },
      });
      updateOutput();
      return;
    }
    const el = selected;
    const fontList = h('datalist#di-fonts', [...new Set([...fontFacesOnPage(), ...FONT_SUGGESTIONS])].map(f => h('option', { value: f })));
    const margin = sideFields('margin');
    const padding = sideFields('padding');
    const color = colorField('color', 'Text color');
    const bg = colorField('background-color', 'Background');
    const border = colorField('border-top-color', 'Border color');
    border.el.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        // Apply to all sides so the whole border changes.
        const v = el.style.getPropertyValue('border-top-color');
        if (v) for (const s of ['right', 'bottom', 'left']) setProp(el, `border-${s}-color`, v);
      });
    });
    const family = textField('font-family', 'Font family', { list: 'di-fonts' });
    const size = textField('font-size', 'Size');
    const weight = h('select', { 'aria-label': 'Font weight' }, [100, 200, 300, 400, 500, 600, 700, 800, 900].map(w => h('option', { value: String(w) }, String(w))));
    weight.addEventListener('change', () => setProp(el, 'font-weight', weight.value));
    const lineH = textField('line-height', 'Line height');
    const letter = textField('letter-spacing', 'Letter spacing');
    const radius = textField('border-radius', 'Radius');
    const width = textField('width', 'Width');
    const height = textField('height', 'Height');
    const all = [margin, padding, color, bg, border, family, size, lineH, letter, radius, width, height];
    fields = {
      refresh() {
        for (const f of all) f.read();
        weight.value = String(Math.round(Number(getComputedStyle(el).fontWeight) / 100) * 100 || 400);
      },
    };
    const extra = h('textarea', { 'aria-label': 'Extra declarations', placeholder: 'display: flex;\ngap: 12px;', spellcheck: 'false' });
    extra.style.minHeight = '56px';
    outputEl = h('textarea', { readonly: true, 'aria-label': 'Resulting CSS', spellcheck: 'false' });

    const textBtn = h('button.btn' + (editing === el ? '.primary' : ''), {
      type: 'button', 'aria-pressed': String(editing === el), title: 'Toggle text editing (Enter). Esc to finish',
      onclick: () => (editing === el ? stopText() : startText(el)),
    }, editing === el ? 'Done editing text' : 'Edit text');

    app.showPanel('edit', {
      title: 'Live edit', sub: tagLabel(el),
      body: [
        h('div.mono.dim', { title: cssPath(el) }, cssPath(el)),
        h('div.row.tight', textBtn,
          h('button.btn', { type: 'button', disabled: !el.parentElement || el.parentElement === document.documentElement, onclick: () => select(el.parentElement) }, '↑ Parent'),
          h('button.btn', { type: 'button', disabled: !el.firstElementChild, onclick: () => select(el.firstElementChild) }, '↓ Child')),
        h('section.sect', h('div.sect-head', 'Spacing'), h('div.sect-body', margin.el, padding.el,
          h('div.hint', h('kbd', '←↑→↓'), ' margin +1px, ', h('kbd', 'Shift'), ' padding, ', h('kbd', 'Alt'), ' ×10, ', h('kbd', 'Ctrl'), ' shrink'))),
        h('section.sect', h('div.sect-head', 'Colors'), h('div.sect-body', color.el, bg.el, border.el)),
        h('section.sect', h('div.sect-head', 'Typography'), h('div.sect-body', fontList, family.el,
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } }, size.el, h('label.field', 'Weight', weight), lineH.el, letter.el))),
        h('section.sect', h('div.sect-head', 'Box'), h('div.sect-body',
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' } }, width.el, height.el, radius.el))),
        h('section.sect', h('div.sect-head', 'More CSS'), h('div.sect-body', extra,
          h('div.row', h('button.btn', {
            type: 'button',
            onclick: () => {
              const pairs = parseDeclarations(extra.value);
              const bad = pairs.filter(([p, v]) => !setProp(el, p, v)).map(([p]) => p);
              fields.refresh();
              app.toast(bad.length ? `Ignored invalid: ${bad.join(', ')}` : `Applied ${pairs.length} declaration${pairs.length === 1 ? '' : 's'}`);
            },
          }, 'Apply')))),
        h('section.sect', h('div.sect-head', 'Resulting CSS', h('span.count', 'all edits')), h('div.sect-body', outputEl)),
      ],
      foot: [
        ...footButtons(),
        h('button.btn.ghost', { type: 'button', onclick: () => { resetElement(el); renderPanel(); app.requestRedraw(); } }, 'Reset element'),
      ],
      onClose: replacing => { if (!replacing && app.mode === 'edit') app.setMode(null); },
    });
    fields.refresh();
    updateOutput();
  }

  function footButtons() {
    return [
      h('button.btn.primary', { type: 'button', onclick: async () => app.toast((await copyText(outputEl.value)) ? 'CSS copied' : 'Copy failed') }, 'Copy CSS'),
      h('button.btn.ghost', {
        type: 'button', title: 'Undo every live edit on this page',
        onclick: () => {
          stopText();
          for (const el of [...changes.keys()]) resetElement(el);
          renderPanel();
          app.requestRedraw();
          app.toast('All edits reset');
        },
      }, 'Reset all'),
    ];
  }

  function fontFacesOnPage() {
    const out = new Set();
    try {
      for (const f of document.fonts) out.add(f.family.replace(/^["']|["']$/g, ''));
    } catch {}
    return [...out].slice(0, 40);
  }

  function select(el) {
    if (!el || el.nodeType !== 1) return;
    if (editing && editing !== el) stopText();
    selected = el;
    renderPanel();
    app.requestRedraw();
  }

  function nudge(e) {
    const dir = { ArrowUp: 'top', ArrowDown: 'bottom', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    if (!dir || !selected) return false;
    const kind = e.shiftKey ? 'padding' : 'margin';
    const prop = `${kind}-${dir}`;
    const amount = (e.altKey ? 10 : 1) * (e.ctrlKey || e.metaKey ? -1 : 1);
    const cur = parseFloat(getComputedStyle(selected).getPropertyValue(prop)) || 0;
    let next = Math.round((cur + amount) * 10) / 10;
    if (kind === 'padding' && next < 0) next = 0;
    setProp(selected, prop, `${next}px`);
    if (fields) fields.refresh();
    return true;
  }

  return {
    name: 'edit',
    get changes() { return changes; },
    get selected() { return selected; },
    select,
    setProp,
    startText,
    stopText,
    enter() {
      hover = null;
      renderPanel();
    },
    exit() {
      stopText();
      hover = null;
      selected = null;
      fields = null;
      clear(layer());
      if (app.panelOwner === 'edit') app.closePanel(true);
      outputEl = null;
    },
    allowPageEvent(e) {
      return !!(editing && e.target instanceof Node && (editing === e.target || editing.contains(e.target)));
    },
    onMove(e) {
      hover = elementAt(e.clientX, e.clientY);
      app.requestRedraw();
    },
    onLeave() {
      hover = null;
      app.requestRedraw();
    },
    onClick(e) {
      const el = elementAt(e.clientX, e.clientY);
      if (el) select(el);
    },
    onKey(e) {
      if (editing) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          stopText();
          return true;
        }
        // Typing inside the element being edited: leave the keys to the page.
        const t = e.composedPath ? e.composedPath()[0] : e.target;
        if (t instanceof Node && (t === editing || editing.contains(t))) return true;
      }
      if (app.typingTarget(e) || app.isOwnEvent(e)) return false;
      if (selected && e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        startText(selected);
        return true;
      }
      if (selected && nudge(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return true;
      }
      return false;
    },
    onEscape() {
      if (selected) {
        selected = null;
        renderPanel();
        app.requestRedraw();
        return true;
      }
      return false;
    },
    redraw(active) {
      const l = clear(layer());
      if (!active) return;
      if (selected && !selected.isConnected) {
        selected = null;
        renderPanel();
      }
      if (selected) drawBox(l, selected);
      if (editing) {
        const r = editing.getBoundingClientRect();
        const d = h('div.editing-outline');
        Object.assign(d.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
        l.append(d);
      }
      if (hover && hover !== selected && hover.isConnected) outlineBox(l, hover);
    },
  };
}
