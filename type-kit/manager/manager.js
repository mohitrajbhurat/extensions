/* Type Kit manager: snippets and folders, clipboard history, stats, settings, import/export. */
(function () {
  'use strict';
  const S = window.TKStore, E = window.TKEngine;
  const $ = (id) => document.getElementById(id);

  const st = {
    view: 'snippets',
    snippets: [], folders: [], settings: {}, clips: [],
    folder: 'all',
    selectedId: null,
    isNew: false,
    original: null,          // serialized form state when the editor was loaded
    format: 'plain',
    richRange: null,
  };

  /* ---------- helpers ---------- */

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  function relTime(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString();
  }

  function fmtDuration(sec) {
    sec = Math.round(sec || 0);
    if (sec < 60) return sec + ' s';
    const m = Math.floor(sec / 60);
    if (m < 60) return m + ' min';
    const hh = Math.floor(m / 60);
    return hh + ' h ' + (m % 60) + ' min';
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function ctxForPreview() {
    return { snippets: st.snippets, clips: st.clips, settings: st.settings, pageUrl: 'https://example.com/page', pageTitle: 'Example page', pageHost: 'example.com' };
  }

  async function reload() {
    const data = await S.loadAll();
    st.snippets = data.snippets;
    st.folders = data.folders.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    st.settings = data.settings;
    st.clips = await S.getClips();
  }

  /* ---------- routing ---------- */

  function route() {
    const hash = location.hash.replace(/^#/, '');
    let view = 'snippets';
    if (/^snippet=/.test(hash)) {
      const id = decodeURIComponent(hash.slice(8));
      if (st.snippets.some((s) => s.id === id)) selectSnippet(id, true);
    } else if (hash === 'welcome') {
      $('welcome').hidden = false;
    } else if (['clipboard', 'stats', 'settings', 'data', 'snippets'].includes(hash)) view = hash;
    showView(view);
  }

  function showView(view) {
    st.view = view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
    document.querySelectorAll('.nav a').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (view === 'snippets') renderSnippetsView();
    if (view === 'clipboard') renderClipboard();
    if (view === 'stats') renderStats();
    if (view === 'settings') renderSettings();
    document.title = 'Type Kit · ' + ({ snippets: 'Snippets', clipboard: 'Clipboard', stats: 'Stats', settings: 'Settings', data: 'Import / Export' })[view];
  }

  /* ---------- folders ---------- */

  function folderName(id) { return (st.folders.find((f) => f.id === id) || {}).name || 'General'; }

  function renderFolders() {
    const ul = $('folder-list');
    ul.textContent = '';
    const countIn = (id) => st.snippets.filter((s) => s.folderId === id).length;
    const item = (id, name, count, editable) => {
      const li = h('li', { 'aria-current': String(st.folder === id) });
      const sel = h('button', { class: 'f-sel', type: 'button', onclick: () => { if (confirmDiscard()) { st.folder = id; renderSnippetsView(); } } },
        h('span', { text: name }), h('span', { class: 'muted', text: String(count) }));
      li.append(sel);
      if (editable) {
        li.append(h('span', { class: 'f-acts' },
          h('button', { class: 'btn ghost', type: 'button', title: 'Rename', 'aria-label': 'Rename ' + name, text: '✎', onclick: () => renameFolderInline(li, id, name) }),
          id === 'f_general' ? null : h('button', { class: 'btn ghost danger', type: 'button', title: 'Delete folder', 'aria-label': 'Delete folder ' + name, text: '✕', onclick: () => removeFolder(id, name) })));
      }
      return li;
    };
    ul.append(item('all', 'All snippets', st.snippets.length, false));
    for (const f of st.folders) ul.append(item(f.id, f.name, countIn(f.id), true));
  }

  function renameFolderInline(li, id, name) {
    const input = h('input', { class: 'input small', value: name, 'aria-label': 'Folder name' });
    li.textContent = '';
    li.append(input);
    input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== name) {
        await S.renameFolder(id, input.value.trim());
        await reload();
      }
      renderFolders(); fillFolderSelect();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function removeFolder(id, name) {
    const n = st.snippets.filter((s) => s.folderId === id).length;
    if (!confirm(`Delete the folder "${name}"?` + (n ? ` Its ${n} snippet${n === 1 ? '' : 's'} move to General.` : ''))) return;
    await S.deleteFolder(id);
    await reload();
    if (st.folder === id) st.folder = 'all';
    renderSnippetsView();
    toast('Folder deleted');
  }

  async function addFolder() {
    const li = h('li');
    const input = h('input', { class: 'input small', placeholder: 'Folder name', 'aria-label': 'New folder name' });
    li.append(input);
    $('folder-list').append(li);
    input.focus();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) {
        const f = await S.addFolder(input.value.trim());
        await reload();
        st.folder = f.id;
        toast('Folder created');
      }
      renderSnippetsView();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function fillFolderSelect() {
    const sel = $('f-folder');
    const cur = sel.value;
    sel.textContent = '';
    for (const f of st.folders) sel.append(h('option', { value: f.id, text: f.name }));
    if (cur && st.folders.some((f) => f.id === cur)) sel.value = cur;
  }

  /* ---------- snippet list ---------- */

  function visibleSnippets() {
    let list = st.snippets.filter((s) => st.folder === 'all' || s.folderId === st.folder);
    const q = $('snip-q').value.trim();
    if (q) return E.search(q, list, (s) => [s.shortcut, s.name, s.format === 'rich' ? E.htmlToText(s.body) : s.body]).map((r) => r.item);
    const sort = $('snip-sort').value;
    const by = {
      name: (a, b) => String(a.name).localeCompare(String(b.name)),
      uses: (a, b) => (b.uses || 0) - (a.uses || 0) || String(a.name).localeCompare(String(b.name)),
      recent: (a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0),
      updated: (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0),
    }[sort] || (() => 0);
    return list.slice().sort(by);
  }

  function renderSnippetList() {
    const ul = $('snip-list');
    ul.textContent = '';
    const list = visibleSnippets();
    $('snip-count').textContent = list.length + ' of ' + st.snippets.length;
    if (!list.length) {
      ul.append(h('li', { class: 'empty', role: 'presentation', text: $('snip-q').value ? 'No matching snippets' : 'No snippets in this folder' }));
      return;
    }
    for (const s of list) {
      const prev = E.preview(s, ctxForPreview()).replace(/\s+/g, ' ').slice(0, 120);
      const li = h('li', {
        role: 'option', tabindex: s.id === st.selectedId ? '0' : '-1', 'aria-selected': String(s.id === st.selectedId),
        'data-id': s.id, class: s.enabled === false ? 'disabled' : '',
      },
      h('div', { class: 's-top' },
        h('span', { class: 's-name', text: s.name }),
        s.format === 'rich' ? h('span', { class: 's-badge', text: 'rich' }) : null,
        s.enabled === false ? h('span', { class: 's-badge', text: 'off' }) : null,
        s.shortcut ? h('span', { class: 'kbd', text: s.shortcut }) : null),
      h('div', { class: 's-prev', text: prev || '(empty)' }),
      h('div', { class: 's-badge', text: (s.uses || 0) + ' use' + (s.uses === 1 ? '' : 's') + (st.folder === 'all' ? ' · ' + folderName(s.folderId) : '') }));
      li.addEventListener('click', () => selectSnippet(s.id));
      ul.append(li);
    }
    if (!ul.querySelector('[tabindex="0"]') && ul.firstElementChild) ul.firstElementChild.setAttribute('tabindex', '0');
  }

  $('snip-list').addEventListener('keydown', (e) => {
    const items = Array.from($('snip-list').querySelectorAll('li[role=option]'));
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Enter') { e.preventDefault(); selectSnippet(items[i].dataset.id); $('f-name').focus(); return; }
    if (next < 0) return;
    e.preventDefault();
    const id = items[next].dataset.id;
    if (selectSnippet(id)) {
      const li = $('snip-list').querySelector(`li[data-id="${CSS.escape(id)}"]`);
      if (li) li.focus();
    }
  });

  function renderSnippetsView() {
    renderFolders();
    fillFolderSelect();
    renderSnippetList();
    if (!st.selectedId && !st.isNew) showEditor(false);
  }

  /* ---------- editor ---------- */

  function showEditor(on) {
    $('snip-form').hidden = !on;
    $('editor-empty').hidden = on;
  }

  function formState() {
    return {
      name: $('f-name').value.trim(),
      shortcut: $('f-shortcut').value.trim(),
      folderId: $('f-folder').value,
      format: st.format,
      enabled: $('f-enabled').checked,
      body: st.format === 'rich' ? E.sanitizeHTML($('f-rich').innerHTML, document) : $('f-body').value,
    };
  }

  function isDirty() {
    if ($('snip-form').hidden) return false;
    return JSON.stringify(formState()) !== st.original;
  }

  function confirmDiscard() {
    if (!isDirty()) return true;
    return confirm('Discard unsaved changes to this snippet?');
  }

  function setFormat(fmt, convert) {
    if (convert && fmt !== st.format) {
      if (fmt === 'rich') {
        $('f-rich').innerHTML = E.sanitizeHTML(E.textToHTML($('f-body').value), document);
      } else {
        const html = $('f-rich').innerHTML;
        const plain = E.htmlToText(html);
        if (/<(b|strong|i|em|u|a|ul|ol)\b/i.test(html) && !confirm('Switching to plain text removes formatting. Continue?')) return;
        $('f-body').value = plain;
      }
    }
    st.format = fmt;
    $('fmt-plain').setAttribute('aria-pressed', String(fmt === 'plain'));
    $('fmt-rich').setAttribute('aria-pressed', String(fmt === 'rich'));
    $('f-body').hidden = fmt === 'rich';
    $('f-rich').hidden = fmt !== 'rich';
    $('rich-toolbar').hidden = fmt !== 'rich';
    if (fmt === 'rich') $('body-label').removeAttribute('for'); else $('body-label').setAttribute('for', 'f-body');
    updateEditorState();
  }

  function loadEditor(s, isNew) {
    st.isNew = !!isNew;
    st.selectedId = isNew ? null : s.id;
    showEditor(true);
    fillFolderSelect();
    $('f-name').value = s.name || '';
    $('f-shortcut').value = s.shortcut || '';
    $('f-folder').value = s.folderId && st.folders.some((f) => f.id === s.folderId) ? s.folderId : (st.folders[0] || {}).id;
    $('f-enabled').checked = s.enabled !== false;
    st.format = s.format === 'rich' ? 'rich' : 'plain';
    $('f-body').value = st.format === 'plain' ? (s.body || '') : '';
    $('f-rich').innerHTML = st.format === 'rich' ? E.sanitizeHTML(s.body || '', document) : '';
    setFormat(st.format, false);
    st.original = JSON.stringify(formState());
    $('snip-delete').hidden = !!isNew;
    $('snip-dup').hidden = !!isNew;
    renderMeta(s, isNew);
    updateEditorState();
  }

  function renderMeta(s, isNew) {
    $('ed-meta').textContent = isNew ? 'New snippet' :
      `Used ${s.uses || 0} time${s.uses === 1 ? '' : 's'} · last used ${relTime(s.lastUsedAt)} · ${(s.charsSaved || 0).toLocaleString()} characters saved · edited ${relTime(s.updatedAt)}`;
  }

  function selectSnippet(id, force) {
    if (!force && id === st.selectedId) return true;
    if (!force && !confirmDiscard()) return false;
    const s = st.snippets.find((x) => x.id === id);
    if (!s) return false;
    loadEditor(s, false);
    renderSnippetList();
    return true;
  }

  function newSnippet() {
    if (!confirmDiscard()) return;
    showView('snippets');
    if (location.hash && location.hash !== '#snippets') history.replaceState(null, '', '#snippets');
    const folderId = st.folder !== 'all' ? st.folder : (st.folders[0] || {}).id;
    loadEditor({ name: '', shortcut: '', body: '', format: 'plain', folderId, enabled: true }, true);
    renderSnippetList();
    $('f-name').focus();
  }

  function validateShortcut() {
    const msg = $('shortcut-msg');
    const sc = $('f-shortcut').value.trim();
    msg.className = 'hint';
    msg.textContent = '';
    if (!sc) { msg.textContent = 'No shortcut: the snippet is still available in the picker (Alt+Shift+V) and popup.'; return true; }
    if (/\s/.test(sc)) { msg.className = 'hint err'; msg.textContent = 'Shortcuts cannot contain spaces.'; return false; }
    const ci = !st.settings.caseSensitive;
    const norm = (x) => (ci ? String(x || '').toLowerCase() : String(x || ''));
    const others = st.snippets.filter((s) => s.id !== st.selectedId && s.shortcut);
    const dup = others.find((s) => norm(s.shortcut) === norm(sc));
    if (dup) { msg.className = 'hint err'; msg.textContent = `"${dup.name}" already uses ${dup.shortcut}.`; return false; }
    const longer = others.find((s) => norm(s.shortcut).startsWith(norm(sc)));
    const shorter = others.find((s) => norm(sc).startsWith(norm(s.shortcut)));
    if (longer && st.settings.triggerMode !== 'space') {
      msg.className = 'hint warn';
      msg.textContent = `${sc} is the start of ${longer.shortcut}, so it expands once you type a space or punctuation after it.`;
    } else if (shorter && st.settings.triggerMode !== 'space') {
      msg.className = 'hint warn';
      msg.textContent = `${shorter.shortcut} is the start of ${sc}; type ${shorter.shortcut} followed by a space to use that one.`;
    } else if (/^[A-Za-z0-9]/.test(sc) && sc.length < 4) {
      msg.className = 'hint warn';
      msg.textContent = 'Short shortcuts that are plain letters can expand by accident. Starting with / or ; is safer.';
    }
    return true;
  }

  function renderPreview() {
    const box = $('preview');
    const body = st.format === 'rich' ? E.sanitizeHTML($('f-rich').innerHTML, document) : $('f-body').value;
    const ctx = ctxForPreview();
    const fields = E.collectFields(body, ctx);
    const values = {};
    for (const f of fields) values[f.key] = f.default || ('‹' + f.label + '›');
    let r;
    try {
      r = E.render(body, Object.assign({}, ctx, { values, rich: st.format === 'rich' }));
    } catch (e) {
      box.textContent = 'Preview error: ' + e.message;
      return;
    }
    box.textContent = '';
    box.classList.toggle('rich', st.format === 'rich');
    if (st.format === 'rich') {
      const marker = '⁣';
      const html = r.cursor >= 0 ? r.text.slice(0, r.cursor) + marker + r.text.slice(r.cursor) : r.text;
      box.innerHTML = E.sanitizeHTML(html, document);
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const i = n.data.indexOf(marker);
        if (i >= 0) {
          const after = n.splitText(i);
          after.data = after.data.slice(1);
          after.parentNode.insertBefore(h('span', { class: 'caret', title: 'Cursor lands here' }), after);
          break;
        }
      }
    } else if (r.cursor >= 0) {
      box.append(r.text.slice(0, r.cursor), h('span', { class: 'caret', title: 'Cursor lands here' }), r.text.slice(r.cursor));
    } else {
      box.textContent = r.text;
    }
    if (!r.text) box.append(h('span', { class: 'muted', text: 'Nothing to preview yet' }));
  }

  function updateEditorState() {
    if ($('snip-form').hidden) return;
    validateShortcut();
    renderPreview();
    const dirty = isDirty();
    $('dirty').textContent = dirty ? 'Unsaved changes' : (st.isNew ? '' : 'Saved');
    $('snip-revert').disabled = !dirty;
  }

  async function saveSnippet() {
    if (!validateShortcut()) { $('f-shortcut').focus(); toast('Fix the shortcut first'); return; }
    const f = formState();
    if (!f.name && !f.shortcut) { $('f-name').focus(); toast('Give the snippet a name or a shortcut'); return; }
    const base = st.isNew ? {} : (st.snippets.find((s) => s.id === st.selectedId) || {});
    const saved = await S.upsertSnippet(Object.assign({}, base, f, { id: st.isNew ? undefined : st.selectedId }));
    await reload();
    st.isNew = false;
    st.selectedId = saved.id;
    loadEditor(st.snippets.find((s) => s.id === saved.id) || saved, false);
    renderFolders();
    renderSnippetList();
    toast('Saved');
  }

  async function deleteCurrent() {
    const s = st.snippets.find((x) => x.id === st.selectedId);
    if (!s || !confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
    await S.deleteSnippet(s.id);
    await reload();
    st.selectedId = null; st.isNew = false;
    showEditor(false);
    renderSnippetsView();
    toast('Deleted');
  }

  async function duplicateCurrent() {
    if (!confirmDiscard()) return;
    const copy = await S.duplicateSnippet(st.selectedId);
    await reload();
    if (copy) { loadEditor(copy, false); renderSnippetsView(); $('f-name').focus(); toast('Duplicated'); }
  }

  /* placeholders menu */
  const PLACEHOLDERS = [
    ['Today’s date', '{date}'],
    ['Date in 3 days', '{date:+3d:YYYY-MM-DD}'],
    ['Long date', '{date:dddd, MMMM D, YYYY}'],
    ['Time', '{time}'],
    ['Time in 1 hour', '{time:+1h:h:mm A}'],
    ['Clipboard', '{clipboard}'],
    ['Cursor position', '{cursor}'],
    ['Fill-in field', '{input:Name}'],
    ['Multi-line field', '{input:Notes:multiline}'],
    ['Dropdown', '{select:Choice:Option A|Option B}'],
    ['Another snippet', '{snippet:/sig}'],
    ['Page URL', '{url}'],
    ['Page title', '{title}'],
  ];

  function buildPlaceholderMenu() {
    const ul = $('ph-list');
    for (const [label, code] of PLACEHOLDERS) {
      ul.append(h('li', { role: 'none' }, h('button', {
        type: 'button', role: 'menuitem', tabindex: '-1',
        onclick: () => { closeMenu(); insertPlaceholder(code); },
      }, h('span', { text: label }), h('code', { text: code }))));
    }
  }

  function openMenu() {
    $('ph-list').hidden = false;
    $('ph-btn').setAttribute('aria-expanded', 'true');
    const first = $('ph-list').querySelector('button');
    if (first) first.focus();
  }
  function closeMenu(focusBtn) {
    $('ph-list').hidden = true;
    $('ph-btn').setAttribute('aria-expanded', 'false');
    if (focusBtn) $('ph-btn').focus();
  }

  function insertPlaceholder(code) {
    if (code === '{snippet:/sig}') {
      const other = st.snippets.find((s) => s.id !== st.selectedId && s.shortcut);
      if (other) code = '{snippet:' + other.shortcut + '}';
    }
    if (st.format === 'rich') {
      const rich = $('f-rich');
      rich.focus();
      const sel = window.getSelection();
      if (st.richRange && rich.contains(st.richRange.commonAncestorContainer)) { sel.removeAllRanges(); sel.addRange(st.richRange); }
      document.execCommand('insertText', false, code);
    } else {
      const ta = $('f-body');
      ta.focus();
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (!document.execCommand('insertText', false, code)) ta.setRangeText(code, s, e, 'end');
      const m = /\{(input|select):([^:}|]+)/.exec(code);
      if (m) {
        const start = s + code.indexOf(m[2]);
        ta.setSelectionRange(start, start + m[2].length);
      }
    }
    updateEditorState();
  }

  /* ---------- clipboard view ---------- */

  function renderClipboard() {
    const s = st.settings;
    $('clip-status').textContent = s.historyEnabled
      ? `Recording is on. Keeping the last ${s.historyLimit} items` + (Number(s.historyExpiryDays) ? `, deleting items older than ${s.historyExpiryDays} days` : '') + '. Pinned items are always kept.'
      : 'Recording is off. Turn it on in Settings.';
    const q = $('clip-q').value.trim();
    let list = st.clips.slice().sort((a, b) => (b.pinned - a.pinned) || (new Date(b.createdAt) - new Date(a.createdAt)));
    if ($('clip-pinned-only').checked) list = list.filter((c) => c.pinned);
    if (q) list = E.search(q, list, (c) => [c.text.slice(0, 5000), c.title, c.host]).map((r) => r.item);
    const ul = $('clip-list');
    ul.textContent = '';
    if (!list.length) {
      ul.append(h('li', { class: 'empty', text: q ? 'No matches' : 'Nothing here yet. Copy text on any web page.' }));
      return;
    }
    for (const c of list) {
      const text = h('div', { class: 'clip-text', text: c.text });
      const meta = h('div', { class: 'clip-meta' },
        c.pinned ? h('strong', { text: 'Pinned' }) : null,
        c.url ? h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: c.title || c.url, text: c.host || c.url }) : h('span', { text: 'Unknown source' }),
        h('span', { text: relTime(c.createdAt) }),
        h('span', { text: c.text.length.toLocaleString() + ' chars' }),
        c.text.length > 300 || c.text.split('\n').length > 5 ? h('button', {
          class: 'btn ghost', type: 'button', text: 'Show all', onclick: (e) => {
            const open = text.classList.toggle('open');
            e.target.textContent = open ? 'Show less' : 'Show all';
          },
        }) : null);
      ul.append(h('li', { class: c.pinned ? 'pinned' : '' },
        h('div', { class: 'clip-body' }, text, meta),
        h('div', { class: 'clip-acts' },
          h('button', { class: 'btn', type: 'button', text: 'Copy', onclick: async () => {
            try { await navigator.clipboard.writeText(c.text); toast('Copied'); } catch (e) { toast('Could not copy'); }
          } }),
          h('button', { class: 'btn', type: 'button', text: c.pinned ? 'Unpin' : 'Pin', onclick: async () => {
            await S.updateClip(c.id, { pinned: !c.pinned }); await reload(); renderClipboard();
          } }),
          h('button', { class: 'btn', type: 'button', text: 'Save as snippet', onclick: () => clipToSnippet(c) }),
          h('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: async () => {
            await S.deleteClip(c.id); await reload(); renderClipboard();
          } }))));
    }
  }

  function clipToSnippet(c) {
    if (!confirmDiscard()) return;
    location.hash = '#snippets';
    const name = c.text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const body = c.text.replace(/\{/g, '{{').replace(/\}/g, '}}');
    setTimeout(() => {
      loadEditor({ name, shortcut: '', body, format: 'plain', folderId: (st.folders[0] || {}).id, enabled: true }, true);
      renderSnippetList();
      $('f-shortcut').focus();
    }, 0);
  }

  /* ---------- stats ---------- */

  async function renderStats() {
    const s = await S.stats();
    const cards = $('stat-cards');
    cards.textContent = '';
    const card = (num, lbl) => h('div', { class: 'card stat' }, h('div', { class: 'num', text: num }), h('div', { class: 'lbl', text: lbl }));
    cards.append(
      card(s.uses.toLocaleString(), 'Expansions'),
      card(fmtDuration(s.secondsSaved), 'Time saved'),
      card(s.charsSaved.toLocaleString(), 'Characters saved'),
      card(String(s.snippetCount), 'Snippets'),
      card(String(s.clipCount), 'Clipboard items (' + s.pinnedCount + ' pinned)'));
    const tbody = $('top-table').querySelector('tbody');
    tbody.textContent = '';
    const top = st.snippets.filter((x) => (x.uses || 0) > 0).sort((a, b) => (b.uses || 0) - (a.uses || 0)).slice(0, 15);
    const max = Math.max(1, ...top.map((x) => x.uses || 0));
    if (!top.length) {
      tbody.append(h('tr', {}, h('td', { colspan: '5', class: 'muted', text: 'No expansions yet. Type a shortcut like /sig in any text field.' })));
      return;
    }
    for (const x of top) {
      tbody.append(h('tr', {},
        h('td', {}, h('a', { href: '#snippet=' + encodeURIComponent(x.id), text: x.name })),
        h('td', {}, x.shortcut ? h('span', { class: 'kbd', text: x.shortcut }) : '—'),
        h('td', {}, String(x.uses || 0), h('div', { class: 'bar', style: `width:${Math.round(((x.uses || 0) / max) * 100)}%`, 'aria-hidden': 'true' })),
        h('td', { text: (x.charsSaved || 0).toLocaleString() }),
        h('td', { text: relTime(x.lastUsedAt) })));
    }
  }

  /* ---------- settings ---------- */

  const LIST_FIELDS = ['excludedSites', 'expanderExcludedSites'];
  const NUM_FIELDS = { historyLimit: [5, 1000], historyExpiryDays: [0, 3650], minClipLength: [1, 100], wpm: [5, 200] };

  function renderSettings() {
    const form = $('settings-form');
    const s = st.settings;
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') el.checked = !!s[el.name];
      else if (LIST_FIELDS.includes(el.name)) el.value = (s[el.name] || []).join('\n');
      else el.value = s[el.name] == null ? '' : s[el.name];
    }
    updateFormatExamples();
    updatePermStatus();
    chrome.commands.getAll((cmds) => {
      const c = (cmds || []).find((x) => x.name === 'open-picker');
      $('cmd-key').textContent = c && c.shortcut ? c.shortcut : 'Not set';
    });
  }

  function updateFormatExamples() {
    const now = new Date();
    $('s-df-ex').textContent = 'Example: ' + E.formatDate(now, $('s-df').value || 'YYYY-MM-DD');
    $('s-tf-ex').textContent = 'Example: ' + E.formatDate(now, $('s-tf').value || 'HH:mm');
  }

  let settingsTimer;
  function scheduleSettingsSave() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(saveSettingsNow, 350);
  }

  async function saveSettingsNow() {
    const form = $('settings-form');
    const patch = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') patch[el.name] = el.checked;
      else if (LIST_FIELDS.includes(el.name)) patch[el.name] = el.value.split(/[\n,]+/).map((x) => x.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
      else if (NUM_FIELDS[el.name]) {
        const [lo, hi] = NUM_FIELDS[el.name];
        const n = Number(el.value);
        if (el.value === '' || !Number.isFinite(n)) continue;
        patch[el.name] = Math.min(hi, Math.max(lo, Math.round(n)));
      } else patch[el.name] = el.value.trim() || S.DEFAULT_SETTINGS[el.name];
    }
    st.settings = await S.saveSettings(patch);
    if ('historyLimit' in patch || 'historyExpiryDays' in patch) st.clips = await S.getClips();
    $('set-saved').textContent = 'Saved';
    setTimeout(() => { $('set-saved').textContent = ''; }, 1500);
  }

  async function updatePermStatus() {
    let has = false;
    try { has = await chrome.permissions.contains({ permissions: ['clipboardRead'] }); } catch (e) { has = false; }
    $('perm-status').innerHTML = '';
    $('perm-status').append(has
      ? document.createTextNode('On: {clipboard} reads what is on your system clipboard right now, including text copied in other apps.')
      : document.createTextNode('Off: {clipboard} uses your latest clipboard history item. Allowing this asks Chrome for permission to read the clipboard.'));
    $('perm-btn').textContent = has ? 'Turn off' : 'Allow';
    $('perm-btn').dataset.has = String(has);
  }

  /* ---------- import / export ---------- */

  const today = () => new Date().toISOString().slice(0, 10);

  async function doImport(text) {
    const mode = $('imp-mode').value;
    if (mode === 'replace' && !confirm('Replace ALL your snippets and folders with the imported ones?')) return;
    const out = $('imp-result');
    try {
      const r = await S.importData(text, mode);
      await reload();
      out.className = 'hint';
      out.textContent = `Imported: ${r.added} added, ${r.updated} updated. You now have ${r.total} snippets in ${r.folders} folders.`;
      toast('Import complete');
    } catch (e) {
      out.className = 'hint err';
      out.textContent = 'Import failed: ' + (e && e.message ? e.message : e);
    }
  }

  /* ---------- events ---------- */

  function wire() {
    window.addEventListener('hashchange', () => {
      if (st.view === 'snippets' && !/^#snippet=/.test(location.hash) && location.hash !== '#snippets' && location.hash !== '#welcome' && isDirty() && !confirm('Leave with unsaved changes?')) {
        history.replaceState(null, '', '#snippets');
        return;
      }
      route();
    });
    window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });

    $('welcome-close').addEventListener('click', () => { $('welcome').hidden = true; history.replaceState(null, '', '#snippets'); });
    $('folder-add').addEventListener('click', addFolder);
    $('snip-new').addEventListener('click', newSnippet);
    $('snip-new-2').addEventListener('click', newSnippet);
    $('snip-q').addEventListener('input', renderSnippetList);
    $('snip-sort').addEventListener('change', renderSnippetList);
    $('snip-q').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); const li = $('snip-list').querySelector('li[role=option]'); if (li) { li.focus(); selectSnippet(li.dataset.id); } }
    });

    const form = $('snip-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); saveSnippet(); });
    form.addEventListener('input', updateEditorState);
    form.addEventListener('change', updateEditorState);
    $('fmt-plain').addEventListener('click', () => setFormat('plain', true));
    $('fmt-rich').addEventListener('click', () => setFormat('rich', true));
    $('snip-delete').addEventListener('click', deleteCurrent);
    $('snip-dup').addEventListener('click', duplicateCurrent);
    $('snip-revert').addEventListener('click', () => {
      if (st.isNew) { st.isNew = false; showEditor(false); renderSnippetList(); return; }
      const s = st.snippets.find((x) => x.id === st.selectedId);
      if (s) loadEditor(s, false);
    });
    $('f-rich').addEventListener('input', updateEditorState);
    $('f-body').addEventListener('keydown', (e) => {
      // Tab inserts a tab character in the body instead of leaving the field (Esc then Tab leaves).
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && $('f-body').dataset.esc !== '1') {
        e.preventDefault();
        document.execCommand('insertText', false, '\t');
      }
      $('f-body').dataset.esc = e.key === 'Escape' ? '1' : '';
    });
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (sel.rangeCount && $('f-rich').contains(sel.getRangeAt(0).commonAncestorContainer)) st.richRange = sel.getRangeAt(0).cloneRange();
    });
    $('rich-toolbar').addEventListener('mousedown', (e) => e.preventDefault());
    $('rich-toolbar').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cmd]');
      if (!b) return;
      $('f-rich').focus();
      const cmd = b.dataset.cmd;
      if (cmd === 'createLink') {
        const url = prompt('Link address (https://…)', 'https://');
        if (!url || !/^(https?:|mailto:|tel:)/i.test(url.trim())) return;
        const sel = window.getSelection();
        if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${E.escapeHTML(url.trim()).replace(/"/g, '&quot;')}">${E.escapeHTML(url.trim())}</a>`);
        else document.execCommand('createLink', false, url.trim());
      } else document.execCommand(cmd, false);
      updateEditorState();
    });

    buildPlaceholderMenu();
    $('ph-btn').addEventListener('click', () => ($('ph-list').hidden ? openMenu() : closeMenu(true)));
    $('ph-btn').addEventListener('mousedown', (e) => { if (st.format === 'rich') e.preventDefault(); });
    $('ph-list').addEventListener('mousedown', (e) => { if (st.format === 'rich') e.preventDefault(); });
    $('ph-list').addEventListener('keydown', (e) => {
      const items = Array.from($('ph-list').querySelectorAll('button'));
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(true); }
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.ph-menu') && !$('ph-list').hidden) closeMenu(false); });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's' && st.view === 'snippets' && !$('snip-form').hidden) { e.preventDefault(); saveSnippet(); }
      else if (e.altKey && !mod && e.code === 'KeyN') { e.preventDefault(); newSnippet(); }
      else if (e.key === '/' && !mod && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
        e.preventDefault();
        if (st.view === 'clipboard') $('clip-q').focus(); else if (st.view === 'snippets') $('snip-q').focus();
      }
    });

    $('clip-q').addEventListener('input', renderClipboard);
    $('clip-pinned-only').addEventListener('change', renderClipboard);
    $('clip-clear').addEventListener('click', async () => {
      if (!confirm('Clear clipboard history? Pinned items are kept.')) return;
      await S.clearClips(true); await reload(); renderClipboard(); toast('History cleared');
    });
    $('clip-clear-all').addEventListener('click', async () => {
      if (!confirm('Delete ALL clipboard items, including pinned ones?')) return;
      await S.clearClips(false); await reload(); renderClipboard(); toast('All items deleted');
    });

    const sform = $('settings-form');
    sform.addEventListener('input', (e) => { if (e.target.name === 'dateFormat' || e.target.name === 'timeFormat') updateFormatExamples(); scheduleSettingsSave(); });
    sform.addEventListener('change', scheduleSettingsSave);
    sform.addEventListener('submit', (e) => e.preventDefault());
    $('perm-btn').addEventListener('click', async () => {
      try {
        if ($('perm-btn').dataset.has === 'true') await chrome.permissions.remove({ permissions: ['clipboardRead'] });
        else {
          const ok = await chrome.permissions.request({ permissions: ['clipboardRead'] });
          toast(ok ? 'Clipboard access allowed' : 'Permission not granted');
        }
      } catch (e) { toast('Could not change the permission'); }
      updatePermStatus();
    });
    $('cmd-change').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

    $('exp-json').addEventListener('click', async () => download(`type-kit-${today()}.json`, await S.exportJSON(), 'application/json'));
    $('exp-csv').addEventListener('click', async () => download(`type-kit-snippets-${today()}.csv`, '﻿' + await S.exportCSV(), 'text/csv'));
    $('imp-file-label').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('imp-file').click(); } });
    $('imp-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { $('imp-result').textContent = 'That file is too large (10 MB max).'; return; }
      await doImport(await file.text());
      e.target.value = '';
    });
    $('imp-go').addEventListener('click', () => {
      const text = $('imp-text').value;
      if (!text.trim()) { $('imp-result').textContent = 'Paste JSON or CSV first.'; return; }
      doImport(text);
    });

    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') return;
      await reload();
      if (st.view === 'snippets') {
        renderFolders();
        renderSnippetList();
        const s = st.snippets.find((x) => x.id === st.selectedId);
        if (s && !st.isNew) renderMeta(s, false);
      } else if (st.view === 'clipboard') renderClipboard();
      else if (st.view === 'stats') renderStats();
    });
  }

  (async function init() {
    await reload();
    wire();
    route();
    if (!location.hash) history.replaceState(null, '', '#snippets');
  })();
})();
