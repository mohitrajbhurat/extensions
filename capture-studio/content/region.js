// Region selection overlay. Injected on demand (activeTab + scripting).
// Reports the selected rectangle (CSS pixels, viewport coordinates) to the service worker.
(() => {
  if (window.__captureStudioRegion) return;
  window.__captureStudioRegion = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(10, 12, 18, .38); user-select: none; }
      .layer.selecting { background: transparent; }
      .sel { position: fixed; display: none; outline: 1.5px solid #fff; box-shadow: 0 0 0 100vmax rgba(10, 12, 18, .45), 0 0 0 1px rgba(0,0,0,.35) inset; }
      .size { position: fixed; display: none; font: 600 12px/1 system-ui, sans-serif; color: #fff; background: rgba(17, 19, 24, .85); padding: 4px 8px; border-radius: 6px; pointer-events: none; }
      .bar { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
             background: rgba(17, 19, 24, .92); color: #e9ebf1; padding: 8px 8px 8px 16px; border-radius: 12px;
             font: 13px/1.3 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0, 0, 0, .35); cursor: default; }
      .bar button { font: 500 13px system-ui, sans-serif; color: #fff; background: rgba(255,255,255,.12); border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; }
      .bar button:hover { background: rgba(255,255,255,.22); }
      .bar button:focus-visible { outline: 2px solid #6b93ff; outline-offset: 1px; }
      kbd { font: 11px ui-monospace, monospace; background: rgba(255,255,255,.16); border-radius: 4px; padding: 1px 5px; margin-left: 4px; }
    </style>
    <div class="layer" part="layer"></div>
    <div class="sel"></div>
    <div class="size"></div>
    <div class="bar" role="toolbar" aria-label="Screenshot options">
      <span>Drag to select an area</span>
      <button data-act="visible">Visible area<kbd>Enter</kbd></button>
      <button data-act="full">Full page<kbd>F</kbd></button>
      <button data-act="cancel">Cancel<kbd>Esc</kbd></button>
    </div>`;
  const layer = root.querySelector('.layer');
  const sel = root.querySelector('.sel');
  const size = root.querySelector('.size');
  const bar = root.querySelector('.bar');
  (document.documentElement || document.body).appendChild(host);

  let start = null;
  let rect = null;

  function cleanup() {
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    window.__captureStudioRegion = false;
  }

  async function finish(payload) {
    cleanup();
    // Wait until the overlay is really gone from the rendered frame.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 60));
    chrome.runtime.sendMessage({ type: 'region-result', ...payload, viewport: { width: window.innerWidth, height: window.innerHeight } });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish({ cancel: true }); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish({ switchTo: 'visible' }); }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); e.stopPropagation(); finish({ switchTo: 'full' }); }
  }
  window.addEventListener('keydown', onKey, true);

  bar.addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'visible' || act === 'full') finish({ switchTo: act });
    else if (act === 'cancel') finish({ cancel: true });
  });

  layer.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    layer.setPointerCapture(e.pointerId);
    layer.classList.add('selecting');
    bar.style.display = 'none';
  });

  layer.addEventListener('pointermove', e => {
    if (!start) return;
    const x = Math.max(0, Math.min(start.x, e.clientX));
    const y = Math.max(0, Math.min(start.y, e.clientY));
    const w = Math.min(window.innerWidth, Math.max(start.x, e.clientX)) - x;
    const h = Math.min(window.innerHeight, Math.max(start.y, e.clientY)) - y;
    rect = { x, y, width: w, height: h };
    Object.assign(sel.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    const dpr = window.devicePixelRatio || 1;
    size.textContent = `${Math.round(w * dpr)} × ${Math.round(h * dpr)}`;
    const ly = y > 28 ? y - 26 : y + h + 6;
    Object.assign(size.style, { display: 'block', left: x + 'px', top: ly + 'px' });
  });

  layer.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    if (!rect || rect.width < 4 || rect.height < 4) {
      layer.classList.remove('selecting');
      sel.style.display = 'none';
      size.style.display = 'none';
      bar.style.display = '';
      rect = null;
      return;
    }
    finish({ rect });
  });
})();
