// Response pane: status line, body viewers (tree / pretty / raw / preview / image), headers, cookies, tests.
import { h, clear, formatBytes, formatMs, copyText, download, safeFilename } from '../lib/util.js';
import '../lib/jsontree.js';
import { short } from '../lib/assert.js';
import { toast } from './ui.js';

const RAW_LIMIT = 2_000_000; // characters rendered in text views
const RES_TABS = [['body', 'Body'], ['headers', 'Headers'], ['cookies', 'Cookies'], ['tests', 'Tests'], ['request', 'Request']];

let imgUrl = null;

function viewsFor(kind) {
  if (kind === 'json') return [['tree', 'Tree'], ['pretty', 'Pretty'], ['raw', 'Raw']];
  if (kind === 'html') return [['preview', 'Preview'], ['raw', 'Raw']];
  if (kind === 'image') return [['image', 'Image']];
  if (kind === 'xml') return [['pretty', 'Pretty'], ['raw', 'Raw']];
  if (kind === 'binary') return [['binary', 'Binary']];
  return [['raw', 'Raw']];
}

function prettyXml(xml) {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return xml;
    let out = '';
    const walk = (n, d) => {
      const pad = '  '.repeat(d);
      if (n.nodeType === 1) {
        const attrs = [...n.attributes].map(a => ` ${a.name}="${a.value.replace(/"/g, '&quot;')}"`).join('');
        const kids = [...n.childNodes].filter(c => !(c.nodeType === 3 && !c.nodeValue.trim()));
        if (!kids.length) out += `${pad}<${n.nodeName}${attrs}/>\n`;
        else if (kids.length === 1 && kids[0].nodeType === 3) out += `${pad}<${n.nodeName}${attrs}>${kids[0].nodeValue.trim()}</${n.nodeName}>\n`;
        else { out += `${pad}<${n.nodeName}${attrs}>\n`; kids.forEach(k => walk(k, d + 1)); out += `${pad}</${n.nodeName}>\n`; }
      } else if (n.nodeType === 3) out += pad + n.nodeValue.trim() + '\n';
      else if (n.nodeType === 4) out += `${pad}<![CDATA[${n.nodeValue}]]>\n`;
      else if (n.nodeType === 8) out += `${pad}<!--${n.nodeValue}-->\n`;
    };
    walk(doc.documentElement, 0);
    return (/^<\?xml[^>]*\?>/.exec(xml.trim())?.[0] ? /^<\?xml[^>]*\?>/.exec(xml.trim())[0] + '\n' : '') + out.trimEnd();
  } catch { return xml; }
}

function statusClass(s) { return s ? 's' + String(s)[0] : 's0'; }

export function renderResponsePane(app, tab) {
  const pane = clear(document.getElementById('resPane'));
  if (imgUrl) { URL.revokeObjectURL(imgUrl); imgUrl = null; }
  const r = tab.result;
  if (tab.sending) {
    pane.append(h('div.res-empty', h('h2', h('span.spinner'), ' Sending…'), h('p', 'Press ', h('kbd', 'Esc'), ' or Cancel to stop.')));
    return;
  }
  if (!r) {
    pane.append(h('div.res-empty',
      h('h2', 'Send a request to see the response'),
      h('p', 'Enter a URL and press ', h('kbd', 'Ctrl'), ' + ', h('kbd', 'Enter'), '. Paste a cURL command into the URL field to import it.'),
      h('p.faint', 'The first request to a new host asks for access to that site so the response is not blocked by CORS.')));
    return;
  }
  const res = r.response;
  if (!res.ok) {
    pane.append(h('div.err-box', h('h2', res.error), res.hint ? h('p', res.hint) : null,
      r.prepared ? h('p.mono.faint', `${r.prepared.method} ${r.prepared.url}`) : null,
      warningsList(r.warnings)));
    return;
  }
  const passed = r.tests.filter(t => t.pass).length;
  const head = h('div.res-head',
    h('span.status-pill', { class: statusClass(res.status), title: res.opaqueRedirect ? 'Redirect not followed (opaque)' : '' }, res.opaqueRedirect ? 'Redirect' : `${res.status} ${res.statusText}`),
    h('div.meta',
      h('span', 'Time ', h('b', formatMs(res.time))),
      h('span', 'Size ', h('b', formatBytes(res.size))),
      res.redirected ? h('span', { title: res.finalUrl }, 'Redirected') : null,
      r.tests.length ? h('span.chip', { class: passed === r.tests.length ? 'chip-good' : 'chip-bad' }, `Tests ${passed}/${r.tests.length}`) : null,
      r.extracted?.length ? h('span.chip', { title: r.extracted.map(e => e.missing ? `${e.variable}: not found` : `${e.variable} = ${e.value}`).join('\n') }, `Vars ${r.extracted.filter(e => !e.missing).length}/${r.extracted.length}`) : null,
      r.warnings.length ? h('span.chip.chip-warn', { title: r.warnings.join('\n') }, `${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}`) : null),
    h('span.grow'),
    h('button.btn.btn-sm', { type: 'button', title: 'Copy response body', on: { click: async () => { await copyText(res.text || ''); toast('Response copied'); } }, disabled: !res.text }, 'Copy'),
    h('button.btn.btn-sm', { type: 'button', title: 'Save response body to a file', on: { click: () => saveBody(res, r) } }, 'Save'));

  const tabs = h('div.etabs', { role: 'tablist', 'aria-label': 'Response sections' });
  const body = h('div.res-body', { role: 'tabpanel' });
  const counts = {
    headers: res.headers.length, cookies: r.cookies ? r.cookies.length : 0,
    tests: r.tests.length ? `${passed}/${r.tests.length}` : 0,
  };
  for (const [k, l] of RES_TABS) {
    tabs.append(h('button.etab', {
      type: 'button', role: 'tab', class: tab.ui.resTab === k ? 'active' : '', 'aria-selected': String(tab.ui.resTab === k), dataset: { tab: k },
      on: { click: () => { tab.ui.resTab = k; app.saveTabsSoon(); renderResponsePane(app, tab); } },
    }, l, counts[k] ? h('span.count', String(counts[k])) : null));
  }
  pane.append(head, tabs, body);

  switch (tab.ui.resTab) {
    case 'headers': body.append(headersTable(res.headers)); break;
    case 'cookies': body.append(cookiesView(r)); break;
    case 'tests': body.append(testsView(r)); break;
    case 'request': body.append(requestView(r)); break;
    default: bodyView(app, tab, res, body, head);
  }
}

function warningsList(w) {
  if (!w || !w.length) return null;
  return h('div.note', { style: { marginTop: '8px' } }, w.map(x => h('div', '⚠ ', x)));
}

function saveBody(res, r) {
  const ct = (res.contentType || '').split(';')[0].trim() || 'application/octet-stream';
  const ext = { json: 'json', html: 'html', xml: 'xml', image: (ct.split('/')[1] || 'img').replace(/\+.*/, ''), text: 'txt' }[res.kind] || 'bin';
  let name = 'response';
  try { name = new URL(r.prepared.url).pathname.split('/').filter(Boolean).pop() || 'response'; } catch { /* default */ }
  name = safeFilename(name.replace(/\.[a-z0-9]+$/i, ''));
  download(`${name}.${ext}`, new Blob([res.bytes], { type: ct }));
}

function bodyView(app, tab, res, body, head) {
  const views = viewsFor(res.kind);
  if (!views.some(v => v[0] === tab.ui.resView)) tab.ui.resView = views[0][0];
  if (res.kind === 'json' && !tab.ui.resViewChosen && tab.ui.resView === 'tree') tab.ui.resView = app.state.settings.jsonViewer?.defaultView === 'raw' ? 'pretty' : 'tree';
  const sw = h('div.view-switch', { role: 'radiogroup', 'aria-label': 'Body view' });
  for (const [k, l] of views) {
    sw.append(h('button', {
      type: 'button', role: 'radio', class: tab.ui.resView === k ? 'active' : '', 'aria-checked': String(tab.ui.resView === k),
      on: { click: () => { tab.ui.resView = k; tab.ui.resViewChosen = true; app.saveTabsSoon(); renderResponsePane(app, tab); } },
    }, l));
  }
  const toolbar = h('div.res-head', sw);
  void head;
  body.before(toolbar); // the view toolbar sits between the tab bar and the body
  body.className = 'res-body';
  const wrap = app.state.settings.wrapResponse;
  const wrapBtn = h('button.btn.btn-sm.btn-ghost', { type: 'button', 'aria-pressed': String(!!wrap), on: { click: () => { app.state.settings.wrapResponse = !wrap; app.saveSettings(); renderResponsePane(app, tab); } } }, wrap ? 'No wrap' : 'Wrap');

  if (!res.size) { body.append(h('div.res-empty', h('p', 'Empty response body.'))); return; }
  const v = tab.ui.resView;
  if (v === 'tree') {
    const tree = globalThis.AWJsonTree.render(res.json, {
      expandDepth: Number(app.state.settings.jsonViewer?.expandDepth ?? 3),
      onCopyPath: p => { copyText(p); toast(`Copied ${p}`); },
    });
    const q = h('input', { type: 'search', placeholder: 'Search keys and values', 'aria-label': 'Search response', id: 'resSearch' });
    const count = h('span.faint', { style: { fontSize: '11.5px' }, 'aria-live': 'polite' });
    let hits = [], cur = -1;
    const go = d => {
      if (!hits.length) return;
      hits[cur]?.classList.remove('jt-current');
      cur = (cur + d + hits.length) % hits.length;
      hits[cur].classList.add('jt-current');
      hits[cur].scrollIntoView({ block: 'nearest' });
      count.textContent = `${cur + 1} / ${hits.length}`;
    };
    let timer;
    q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const n = tree.search(q.value.trim());
        hits = tree.hits(); cur = -1;
        count.textContent = q.value.trim() ? (n ? `${n} match${n > 1 ? 'es' : ''}` : 'No matches') : '';
        if (hits.length) go(1);
      }, 160);
    });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } });
    toolbar.append(h('div.search-box', q, count),
      h('span.grow'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'Expand all', on: { click: () => tree.expandAll() } }, 'Expand'),
      h('button.btn.btn-sm.btn-ghost', { type: 'button', title: 'Collapse all', on: { click: () => tree.collapseAll() } }, 'Collapse'));
    if (tree.dataset.truncated === '1') body.append(h('div.note', { style: { marginBottom: '8px' } }, 'Very large document: the tree shows the first 20,000 nodes. Use Pretty or Raw for the rest.'));
    body.append(tree);
    return;
  }
  if (v === 'pretty' || v === 'raw') {
    let text = res.text;
    if (v === 'pretty' && res.kind === 'json') text = JSON.stringify(res.json, null, 2);
    if (v === 'pretty' && res.kind === 'xml') text = prettyXml(res.text);
    const cut = text.length > RAW_LIMIT;
    toolbar.append(h('span.grow'), wrapBtn);
    if (cut) body.append(h('div.note', { style: { marginBottom: '8px' } }, `Showing the first ${RAW_LIMIT.toLocaleString()} characters. Save the response to see all of it.`));
    body.append(h('pre.raw', { class: wrap ? 'wrap' : '', tabindex: '0' }, cut ? text.slice(0, RAW_LIMIT) : text));
    body.classList.add('pad0');
    return;
  }
  if (v === 'preview') {
    body.classList.add('pad0');
    // sandbox without allow-scripts: markup and styles render, scripts and forms do not run.
    const base = `<base href="${res.finalUrl.replace(/"/g, '&quot;')}" target="_blank">`;
    const frame = h('iframe.preview-frame', { sandbox: '', title: 'HTML preview', referrerpolicy: 'no-referrer' });
    frame.srcdoc = base + res.text;
    toolbar.append(h('span.faint', { style: { fontSize: '11.5px' } }, 'Sandboxed preview: scripts are disabled.'));
    body.append(frame);
    return;
  }
  if (v === 'image') {
    imgUrl = URL.createObjectURL(new Blob([res.bytes], { type: res.contentType.split(';')[0] }));
    const img = h('img.img-preview', { src: imgUrl, alt: 'Response image' });
    const dims = h('span.faint', { style: { fontSize: '11.5px' } });
    img.addEventListener('load', () => { dims.textContent = `${img.naturalWidth} × ${img.naturalHeight} px, ${res.contentType}`; });
    img.addEventListener('error', () => { dims.textContent = 'The image could not be decoded.'; });
    toolbar.append(dims);
    body.append(img);
    return;
  }
  // binary: hex preview of the first bytes
  const n = Math.min(res.bytes.length, 512);
  let hex = '';
  for (let i = 0; i < n; i += 16) {
    const row = [...res.bytes.slice(i, i + 16)];
    hex += i.toString(16).padStart(6, '0') + '  ' + row.map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48) + '  ' + row.map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('') + '\n';
  }
  toolbar.append(h('span.faint', { style: { fontSize: '11.5px' } }, `Binary content (${res.contentType || 'unknown type'}). First ${n} bytes:`));
  body.append(h('pre.raw', hex));
}

function headersTable(headers, cookieNote = true) {
  if (!headers.length) return h('div.empty-note', 'No headers exposed.');
  return h('div',
    h('table.cookie-tbl', h('thead', h('tr', h('th', { style: { width: '32%' } }, 'Name'), h('th', 'Value'))),
      h('tbody', headers.map(([k, v]) => h('tr', h('td', k), h('td', v))))),
    cookieNote && h('p.faint', { style: { fontSize: '12px' } }, 'Set-Cookie is never readable from the response in a browser; see the Cookies tab for the cookies stored for this URL.'));
}

function cookiesView(r) {
  if (r.cookies == null) return h('div.empty-note', 'Cookies are shown when the extension has access to this host.');
  if (!r.cookies.length) return h('div.empty-note', 'No cookies stored for this URL.');
  return h('table.cookie-tbl',
    h('thead', h('tr', ['Name', 'Value', 'Domain', 'Path', 'Expires', 'Flags'].map(x => h('th', x)))),
    h('tbody', r.cookies.map(c => h('tr',
      h('td', c.name), h('td', c.value), h('td', c.domain), h('td', c.path),
      h('td', c.session ? 'Session' : new Date(c.expirationDate * 1000).toLocaleString()),
      h('td', [c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite && c.sameSite !== 'unspecified' && `SameSite=${c.sameSite}`].filter(Boolean).join(' '))))));
}

function testsView(r) {
  if (!r.tests.length) return h('div.empty-note', 'No assertions. Add them in the request’s Tests tab.');
  return h('ul.test-list', r.tests.map(t => h('li',
    h('span.test-badge', { class: t.pass ? 'pass' : 'fail' }, t.pass ? 'PASS' : 'FAIL'),
    h('div.grow', h('div', t.label), !t.pass && t.message ? h('div.muted', { style: { fontSize: '12px' } }, t.message) : (t.pass && t.actual !== undefined ? h('div.faint', { style: { fontSize: '12px' } }, 'Actual: ' + short(t.actual)) : null)))));
}

function requestView(r) {
  const p = r.prepared;
  if (!p) return h('div.empty-note', 'Nothing sent.');
  let bodyText = '';
  if (p.body.kind === 'text' || p.body.kind === 'urlencoded') bodyText = p.body.text;
  else if (p.body.kind === 'formdata') bodyText = p.body.fields.map(f => `${f.key}=${f.type === 'file' ? '@' + f.fileName : f.value}`).join('\n');
  else if (p.body.kind === 'binary') bodyText = `<file ${p.body.fileName}>`;
  return h('div',
    h('pre.raw.wrap', { style: { padding: '0 0 8px' } }, `${p.method} ${p.url}`),
    headersTable(p.headers, false),
    bodyText ? h('pre.raw.wrap', { style: { marginTop: '8px', background: 'var(--bg-sunken)', borderRadius: '6px' } }, bodyText.length > RAW_LIMIT ? bodyText.slice(0, RAW_LIMIT) : bodyText) : null,
    warningsList(r.warnings));
}
