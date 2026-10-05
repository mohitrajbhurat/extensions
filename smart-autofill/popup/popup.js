import * as S from '../shared/store.js';
import { PROFILE_KINDS } from '../shared/profile.js';

const $ = (id) => document.getElementById(id);
let tab = null;

function send(msg) {
  return chrome.runtime.sendMessage({ ...msg, tabId: tab && tab.id });
}

function showResult(html, kind = 'ok') {
  const r = $('result');
  r.hidden = false;
  r.className = 'result ' + kind;
  r.replaceChildren();
  if (typeof html === 'string') r.textContent = html; else r.append(html);
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('lockBtn').addEventListener('click', async () => { await S.lock(); render(); });
  $('unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('unlockErr').textContent = '';
    const btn = e.submitter;
    btn.disabled = true;
    btn.textContent = 'Unlocking...';
    try {
      await S.unlock($('pass').value);
      $('pass').value = '';
      await render();
    } catch (err) {
      $('unlockErr').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock';
    }
  });
  $('profileSel').addEventListener('change', () => S.setActiveProfile($('profileSel').value));
  $('editProfile').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#profile=' + encodeURIComponent($('profileSel').value)) });
  });
  $('previewBtn').addEventListener('click', () => run('preview'));
  $('fillBtn').addEventListener('click', () => run('fill'));
  $('undoBtn').addEventListener('click', () => run('undo'));
  for (const k of ['learnMode', 'fillRepeatables', 'overwrite']) {
    $(k).addEventListener('change', () => S.saveSettings({ [k]: $(k).checked }));
  }
  await render();
}

async function render() {
  const lock = await S.getLockState();
  $('lockBtn').hidden = !(lock.lockEnabled && !lock.locked);
  if (lock.locked) {
    $('lockedView').hidden = false;
    $('mainView').hidden = true;
    $('pass').focus();
    return;
  }
  $('lockedView').hidden = true;
  $('mainView').hidden = false;
  const [data, settings] = await Promise.all([S.loadData(), S.getSettings()]);
  const sel = $('profileSel');
  sel.replaceChildren(...data.profiles.map(p => {
    const kind = (PROFILE_KINDS.find(k => k.id === p.kind) || {}).label || 'Custom';
    const o = new Option(p.name.toLowerCase() === kind.toLowerCase() ? p.name : `${p.name} (${kind})`, p.id);
    return o;
  }));
  sel.value = data.activeProfileId;
  for (const k of ['learnMode', 'fillRepeatables', 'overwrite']) $(k).checked = !!settings[k];
  detect();
}

async function detect() {
  const info = $('pageInfo');
  if (!tab) { info.textContent = 'No active tab.'; return; }
  try {
    const r = await send({ type: 'detect' });
    if (!r || !r.ok) {
      info.textContent = r && r.restricted ? 'This page cannot be filled. Open the form you want to fill and try again.' : 'Could not read this page.';
      for (const id of ['previewBtn', 'fillBtn']) $(id).disabled = true;
      return;
    }
    info.replaceChildren();
    if (!r.controls) {
      info.textContent = 'No form fields found on this page yet.';
    } else {
      const b = document.createElement('b');
      b.textContent = r.matched;
      info.append(b, ` of ${r.controls} form field${r.controls === 1 ? '' : 's'} recognized`);
      if (r.frames > 1) info.append(` across ${r.frames} frames`);
      info.append('.');
    }
    $('undoBtn').disabled = !r.canUndo;
  } catch (e) {
    info.textContent = 'Could not read this page.';
  }
}

async function run(type) {
  const btns = ['previewBtn', 'fillBtn', 'undoBtn'].map($);
  btns.forEach(b => (b.disabled = true));
  try {
    const r = await send({ type, profileId: $('profileSel').value });
    if (!r) throw new Error('No response from the extension.');
    if (r.locked) { await render(); return; }
    if (!r.ok) { showResult(r.error || 'Something went wrong.', 'err'); return; }
    if (type === 'preview') {
      if (!r.total) showResult('No fillable fields were recognized on this page.', 'err');
      else {
        showResult(`Previewing ${r.ready} of ${r.total} matched fields on the page. Use the panel on the page to fill, or close this popup to review.`);
        setTimeout(() => window.close(), 900);
      }
    } else if (type === 'fill') {
      const frag = document.createDocumentFragment();
      const p = document.createElement('div');
      p.textContent = `Filled ${r.filled} field${r.filled === 1 ? '' : 's'} with "${r.profileName}"` + (r.added ? `, added ${r.added} extra section${r.added > 1 ? 's' : ''}` : '') + '.';
      frag.append(p);
      if (r.failures && r.failures.length) {
        const ul = document.createElement('ul');
        for (const f of r.failures.slice(0, 5)) {
          const li = document.createElement('li');
          li.textContent = `${f.label}: ${f.reason}`;
          ul.append(li);
        }
        frag.append(ul);
      }
      showResult(frag, r.filled ? 'ok' : 'err');
      $('undoBtn').disabled = !r.filled;
    } else if (type === 'undo') {
      showResult(r.restored ? 'Restored the previous values.' : 'Nothing to undo on this page.');
    }
  } catch (e) {
    showResult(e.message || String(e), 'err');
  } finally {
    $('previewBtn').disabled = false;
    $('fillBtn').disabled = false;
    if (type === 'undo') $('undoBtn').disabled = true;
    else if (type === 'preview') $('undoBtn').disabled = true;
  }
}

init();
