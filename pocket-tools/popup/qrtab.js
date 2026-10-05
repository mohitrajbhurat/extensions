// QR code tab: page URL, text, Wi-Fi, contact; PNG/SVG export; scan.

import { encodeQR, toSVG, drawToCanvas, wifiPayload, vcardPayload } from '../lib/qr.js';
import { saveSettings, DEFAULTS } from '../lib/settings.js';
import { $, $$, debounce, downloadBlob, toast, copyText } from './util.js';

let look;
let mode = 'page';
let lastQR = null;
let lastPayload = '';

const persistLook = debounce(() => saveSettings({ qr: look }), 300);

function payload() {
  switch (mode) {
    case 'page': return $('#qr-url').value.trim();
    case 'text': return $('#qr-text').value;
    case 'wifi': {
      const ssid = $('#wifi-ssid').value;
      if (!ssid) return '';
      return wifiPayload({ ssid, password: $('#wifi-pass').value, security: $('#wifi-sec').value, hidden: $('#wifi-hidden').checked });
    }
    case 'vcard': {
      const c = {
        firstName: $('#vc-first').value.trim(), lastName: $('#vc-last').value.trim(), phone: $('#vc-phone').value.trim(),
        email: $('#vc-email').value.trim(), org: $('#vc-org').value.trim(), title: $('#vc-title').value.trim(), url: $('#vc-url').value.trim(),
      };
      if (!Object.values(c).some(Boolean)) return '';
      return vcardPayload(c);
    }
    default: return '';
  }
}

// WCAG relative luminance, to warn about colour pairs scanners struggle with.
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function render() {
  const text = payload();
  lastPayload = text;
  const canvas = $('#qr-canvas');
  const warn = $('#qr-warning');
  warn.classList.add('hidden');
  const buttons = ['#qr-png', '#qr-svg', '#qr-copy'].map(s => $(s));
  if (!text) {
    lastQR = null;
    canvas.classList.add('hidden');
    $('#qr-empty').classList.remove('hidden');
    $('#qr-meta').textContent = '';
    buttons.forEach(b => (b.disabled = true));
    return;
  }
  try {
    lastQR = encodeQR(text, { level: look.level });
  } catch (err) {
    lastQR = null;
    canvas.classList.add('hidden');
    $('#qr-empty').classList.remove('hidden');
    $('#qr-meta').textContent = err.message;
    buttons.forEach(b => (b.disabled = true));
    return;
  }
  canvas.classList.remove('hidden');
  $('#qr-empty').classList.add('hidden');
  buttons.forEach(b => (b.disabled = false));
  drawToCanvas(lastQR, canvas, { scale: look.scale, quiet: look.quiet, dark: look.dark, light: look.light });
  const px = canvas.width;
  const used = Math.ceil(lastQR.usedBits / 8);
  const cap = Math.floor(lastQR.capacityBits / 8);
  $('#qr-meta').textContent =
    `Version ${lastQR.version} (${lastQR.size}×${lastQR.size}) · level ${lastQR.level} · mask ${lastQR.mask} · ${lastQR.mode} mode · ${used}/${cap} bytes · ${px}×${px} px`;
  const ld = luminance(look.dark);
  const ll = luminance(look.light);
  const contrast = (Math.max(ld, ll) + 0.05) / (Math.min(ld, ll) + 0.05);
  if (ld > ll) {
    warn.textContent = 'Dark modules are lighter than the background; many scanners cannot read inverted codes.';
    warn.classList.remove('hidden');
  } else if (contrast < 4) {
    warn.textContent = 'Low contrast between colours may make the code hard to scan.';
    warn.classList.remove('hidden');
  } else if (look.quiet < 2) {
    warn.textContent = 'A quiet zone under 2 modules can make scanning unreliable.';
    warn.classList.remove('hidden');
  }
}

const renderSoon = debounce(render, 120);

function fileStem() {
  if (mode === 'wifi') return 'wifi-qr';
  if (mode === 'vcard') return 'contact-qr';
  try {
    const u = new URL(lastPayload);
    return (u.hostname.replace(/^www\./, '') || 'qr') + '-qr';
  } catch {
    return 'qr-code';
  }
}

function setMode(next) {
  mode = next;
  $$('#qr-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  for (const m of ['page', 'text', 'wifi', 'vcard']) $(`#qr-in-${m}`).classList.toggle('hidden', m !== mode);
  $('#qr-output').classList.toggle('hidden', mode === 'scan');
  $('#qr-scan').classList.toggle('hidden', mode !== 'scan');
  if (mode !== 'scan') render();
}

// ------------------------------------------------------------------ scanning

async function scanBlob(blob) {
  const status = $('#scan-status');
  status.classList.add('hidden');
  $('#scan-result').classList.add('hidden');
  if (!('BarcodeDetector' in self)) {
    status.textContent = 'Scanning needs the Barcode Detection API, which this browser does not provide. Chrome on macOS, Android and ChromeOS supports it.';
    status.classList.remove('hidden');
    return;
  }
  try {
    const formats = await self.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) throw new Error('QR codes are not supported by this browser’s barcode detector.');
    const detector = new self.BarcodeDetector({ formats: ['qr_code'] });
    const bitmap = await createImageBitmap(blob);
    const codes = await detector.detect(bitmap);
    bitmap.close && bitmap.close();
    if (!codes.length) throw new Error('No QR code found in that image.');
    const text = codes[0].rawValue;
    $('#scan-text').textContent = text;
    let isLink = false;
    try { isLink = /^https?:$/.test(new URL(text).protocol); } catch { /* not a URL */ }
    $('#scan-open').classList.toggle('hidden', !isLink);
    $('#scan-result').classList.remove('hidden');
    $('#scan-result').dataset.value = text;
  } catch (err) {
    status.textContent = err.message || 'Could not read that image.';
    status.classList.remove('hidden');
  }
}

function initScan() {
  const drop = $('#scan-drop');
  if (!('BarcodeDetector' in self)) {
    $('#scan-help').textContent = 'This browser has no built-in barcode detector, so scanning is unavailable here (Chrome on macOS, Android and ChromeOS supports it).';
  }
  $('#scan-file').addEventListener('change', e => { if (e.target.files[0]) scanBlob(e.target.files[0]); e.target.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = [...e.dataTransfer.files].find(x => x.type.startsWith('image/'));
    if (f) scanBlob(f);
  });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#scan-file').click(); } });
  document.addEventListener('paste', e => {
    if (mode !== 'scan' || $('#panel-qr').hidden) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); scanBlob(item.getAsFile()); }
  });
  $('#scan-copy').addEventListener('click', () => copyText($('#scan-result').dataset.value || ''));
  $('#scan-open').addEventListener('click', () => chrome.tabs.create({ url: $('#scan-result').dataset.value }));
  $('#scan-reencode').addEventListener('click', () => {
    $('#qr-text').value = $('#scan-result').dataset.value || '';
    setMode('text');
  });
}

// --------------------------------------------------------------------- init

export async function initQR(settings, pending) {
  look = { ...DEFAULTS.qr, ...settings.qr };
  $('#qr-level').value = look.level;
  $('#qr-scale').value = look.scale;
  $('#qr-scale-out').textContent = look.scale;
  $('#qr-quiet').value = look.quiet;
  $('#qr-quiet-out').textContent = look.quiet;
  $('#qr-dark').value = look.dark;
  $('#qr-light').value = look.light;

  $('#qr-mode').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  for (const sel of ['#qr-url', '#qr-text', '#wifi-ssid', '#wifi-pass', '#vc-first', '#vc-last', '#vc-phone', '#vc-email', '#vc-org', '#vc-title', '#vc-url']) {
    $(sel).addEventListener('input', renderSoon);
  }
  for (const sel of ['#wifi-sec', '#wifi-hidden']) $(sel).addEventListener('change', render);
  $('#wifi-show').addEventListener('change', e => { $('#wifi-pass').type = e.target.checked ? 'text' : 'password'; });

  const onLook = () => {
    look = {
      level: $('#qr-level').value,
      scale: Number($('#qr-scale').value),
      quiet: Number($('#qr-quiet').value),
      dark: $('#qr-dark').value,
      light: $('#qr-light').value,
    };
    $('#qr-scale-out').textContent = look.scale;
    $('#qr-quiet-out').textContent = look.quiet;
    render();
    persistLook();
  };
  for (const sel of ['#qr-level', '#qr-scale', '#qr-quiet', '#qr-dark', '#qr-light']) $(sel).addEventListener('input', onLook);
  $('#qr-reset-colors').addEventListener('click', () => {
    $('#qr-dark').value = DEFAULTS.qr.dark;
    $('#qr-light').value = DEFAULTS.qr.light;
    onLook();
  });

  $('#qr-png').addEventListener('click', () => {
    if (!lastQR) return;
    $('#qr-canvas').toBlob(blob => blob && downloadBlob(blob, fileStem() + '.png'), 'image/png');
  });
  $('#qr-svg').addEventListener('click', () => {
    if (!lastQR) return;
    const svg = toSVG(lastQR, { scale: look.scale, quiet: look.quiet, dark: look.dark, light: look.light });
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), fileStem() + '.svg');
  });
  $('#qr-copy').addEventListener('click', () => {
    if (!lastQR) return;
    $('#qr-canvas').toBlob(async blob => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('QR image copied');
      } catch {
        toast('Could not copy the image; use Download PNG instead.');
      }
    }, 'image/png');
  });

  initScan();

  // Current tab URL (available through activeTab when the popup opens).
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !new URLSearchParams(location.search).has('window')) $('#qr-url').value = tab.url;
  } catch { /* no tabs API */ }

  if (pending && pending.qr) {
    if (pending.qr.mode === 'page') {
      $('#qr-url').value = pending.qr.text || $('#qr-url').value;
      setMode('page');
    } else {
      $('#qr-text').value = pending.qr.text || '';
      setMode('text');
    }
  } else {
    setMode($('#qr-url').value ? 'page' : 'text');
  }
}
