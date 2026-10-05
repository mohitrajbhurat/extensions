/* Stylesheet for the shadow-DOM UI. Kept in JS so no CSS file has to be
   web-accessible and nothing on the page can restyle us. */
export const CSS = String.raw`
:host, * { box-sizing: border-box; }
:host {
  --di-bg: #ffffff;
  --di-bg-soft: #f6f6f9;
  --di-bg-sunken: #ececf3;
  --di-fg: #16161d;
  --di-fg-dim: #5c5c6e;
  --di-line: #d8d8e3;
  --di-accent: #6d28d9;
  --di-accent-soft: #ede9fe;
  --di-on-accent: #ffffff;
  --di-ok: #047857;
  --di-warn: #b45309;
  --di-bad: #b91c1c;
  --di-shadow: 0 10px 30px rgba(16, 16, 32, .18), 0 2px 6px rgba(16, 16, 32, .12);
  --di-radius: 12px;
  --di-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --di-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  all: initial;
  font-family: var(--di-font);
  color: var(--di-fg);
}
@media (prefers-color-scheme: dark) {
  :host {
    --di-bg: #17171e;
    --di-bg-soft: #20202a;
    --di-bg-sunken: #0f0f15;
    --di-fg: #f2f2f7;
    --di-fg-dim: #a3a3b4;
    --di-line: #33333f;
    --di-accent: #a78bfa;
    --di-accent-soft: #2b2140;
    --di-on-accent: #1a1033;
    --di-ok: #34d399;
    --di-warn: #fbbf24;
    --di-bad: #f87171;
    --di-shadow: 0 10px 34px rgba(0, 0, 0, .55), 0 2px 8px rgba(0, 0, 0, .4);
  }
}

.root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: var(--di-font);
  font-size: 12px;
  line-height: 1.45;
  color: var(--di-fg);
  text-align: left;
  z-index: 2147483647;
}
.root > * { pointer-events: auto; }

/* ---------- box model overlay ---------- */
.overlay { position: fixed; inset: 0; pointer-events: none; contain: strict; }
.box { position: fixed; pointer-events: none; }
.box-margin   { background: rgba(246, 183, 60, .28); }
.box-border   { background: rgba(255, 221, 153, .45); }
.box-padding  { background: rgba(130, 212, 167, .35); }
.box-content  { background: rgba(110, 168, 254, .38); outline: 1px solid rgba(60, 110, 200, .8); outline-offset: -1px; }
.box-outline  { outline: 1px dashed rgba(109, 40, 217, .85); outline-offset: -1px; }
.box-sec      { background: rgba(34, 211, 238, .22); outline: 1px dashed rgba(14, 116, 144, .9); outline-offset: -1px; }
.boxlabel {
  position: fixed; pointer-events: none;
  font: 10px/1.1 var(--di-mono);
  color: #1b1b22; background: rgba(255,255,255,.86);
  padding: 1px 3px; border-radius: 3px; white-space: nowrap;
  transform: translate(-50%, -50%);
}

.tip {
  position: fixed; pointer-events: none; max-width: 340px;
  background: var(--di-bg); color: var(--di-fg);
  border: 1px solid var(--di-line); border-radius: 8px;
  box-shadow: var(--di-shadow); padding: 7px 9px;
  font-size: 11px;
}
.tip .tip-tag { font: 11px/1.3 var(--di-mono); color: var(--di-accent); word-break: break-all; }
.tip .tip-dim { color: var(--di-fg-dim); }
.tip .tip-grid { display: grid; grid-template-columns: auto 1fr; gap: 1px 8px; margin-top: 4px; }
.tip .tip-grid b { font-weight: 600; color: var(--di-fg-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .03em; }
.tip .tip-grid span { font-family: var(--di-mono); font-size: 10.5px; word-break: break-word; }
.chip-color { display: inline-block; width: 9px; height: 9px; border-radius: 2px; border: 1px solid rgba(128,128,140,.6); margin-right: 4px; vertical-align: -1px; }

/* ---------- rulers & guides ---------- */
.ruler { position: fixed; background: rgba(250,250,252,.94); color: #333; pointer-events: auto; font: 9px/1 var(--di-mono); }
.ruler-h { top: 0; left: 0; right: 0; height: 18px; border-bottom: 1px solid #c9c9d4; }
.ruler-v { top: 0; left: 0; bottom: 0; width: 18px; border-right: 1px solid #c9c9d4; }
.ruler canvas { display: block; width: 100%; height: 100%; }
.guide { position: fixed; background: #e11d8f; pointer-events: auto; }
.guide-h { left: 0; right: 0; height: 1px; cursor: ns-resize; }
.guide-v { top: 0; bottom: 0; width: 1px; cursor: ew-resize; }
.guide::after { content: attr(data-pos); position: absolute; left: 2px; top: 2px; font: 9px/1.2 var(--di-mono); color: #fff; background: #e11d8f; padding: 1px 3px; border-radius: 2px; }
.guide-v::after { left: 2px; top: 20px; }

/* ---------- measure ---------- */
.mline { position: fixed; background: #e11d8f; pointer-events: none; }
.mlabel {
  position: fixed; pointer-events: none; transform: translate(-50%, -50%);
  background: #e11d8f; color: #fff; font: 10px/1.2 var(--di-mono);
  padding: 1px 4px; border-radius: 3px; white-space: nowrap;
}

/* ---------- toolbar ---------- */
.bar {
  position: fixed; left: 16px; bottom: 16px;
  display: flex; align-items: center; gap: 2px;
  background: var(--di-bg); border: 1px solid var(--di-line);
  border-radius: 14px; box-shadow: var(--di-shadow); padding: 6px;
  max-width: calc(100vw - 32px); flex-wrap: wrap;
}
.bar .grip {
  cursor: grab; width: 14px; height: 24px; border-radius: 6px;
  background: repeating-linear-gradient(to bottom, var(--di-line) 0 2px, transparent 2px 4px);
  background-size: 6px 100%; background-repeat: no-repeat; background-position: center;
  flex: 0 0 auto;
}
.bar .brand { font-weight: 700; font-size: 11px; letter-spacing: .02em; padding: 0 6px 0 2px; color: var(--di-accent); white-space: nowrap; }
.bar .sep { width: 1px; align-self: stretch; background: var(--di-line); margin: 2px 4px; }

button.tool, button.btn, button.icon {
  font-family: var(--di-font); font-size: 11.5px; color: var(--di-fg);
  background: var(--di-bg-soft); border: 1px solid transparent;
  border-radius: 8px; padding: 5px 9px; cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center; gap: 5px;
}
button.tool:hover, button.btn:hover, button.icon:hover { background: var(--di-bg-sunken); }
button.tool[aria-pressed="true"] { background: var(--di-accent); color: var(--di-on-accent); }
button.tool:focus-visible, button.btn:focus-visible, button.icon:focus-visible,
input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--di-accent); outline-offset: 1px;
}
button.icon { padding: 5px 7px; }
button.btn.primary { background: var(--di-accent); color: var(--di-on-accent); }
button.btn.ghost { background: transparent; border-color: var(--di-line); }
button.tool kbd {
  font: 9px/1 var(--di-mono); background: rgba(128,128,140,.22);
  border-radius: 3px; padding: 2px 3px;
}
button.tool[aria-pressed="true"] kbd { background: rgba(255,255,255,.25); }

/* ---------- panel ---------- */
.panel {
  position: fixed; right: 16px; top: 16px; width: 392px;
  max-height: calc(100vh - 32px); display: flex; flex-direction: column;
  background: var(--di-bg); border: 1px solid var(--di-line);
  border-radius: var(--di-radius); box-shadow: var(--di-shadow); overflow: hidden;
}
.panel.wide { width: 440px; }
.panel-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 1px solid var(--di-line); background: var(--di-bg-soft); cursor: grab;
}
.panel-head h2 { margin: 0; font-size: 12.5px; font-weight: 700; flex: 1; }
.panel-head .sub { font-size: 10.5px; color: var(--di-fg-dim); font-weight: 500; }
.panel-body > * { flex-shrink: 0; }
.panel-body { overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
.panel-foot { border-top: 1px solid var(--di-line); padding: 8px 10px; display: flex; gap: 6px; flex-wrap: wrap; background: var(--di-bg-soft); }

.sect { border: 1px solid var(--di-line); border-radius: 10px; overflow: hidden; }
.sect > summary, .sect > .sect-head {
  list-style: none; cursor: pointer; padding: 7px 9px; font-weight: 650; font-size: 11.5px;
  background: var(--di-bg-soft); display: flex; align-items: center; gap: 6px;
}
.sect > summary::-webkit-details-marker { display: none; }
.sect > summary::before { content: "▸"; color: var(--di-fg-dim); font-size: 9px; }
.sect[open] > summary::before { content: "▾"; }
.sect .count { margin-left: auto; color: var(--di-fg-dim); font-weight: 500; font-size: 10.5px; }
.sect-body { padding: 8px 9px; display: flex; flex-direction: column; gap: 7px; }

.kv { display: grid; grid-template-columns: 112px 1fr; gap: 2px 8px; align-items: baseline; }
.kv dt { color: var(--di-fg-dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; }
.kv dd { margin: 0; font-family: var(--di-mono); font-size: 11px; word-break: break-word; }
.mono { font-family: var(--di-mono); }
.dim { color: var(--di-fg-dim); }
.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.row.tight { gap: 4px; }
.spread { justify-content: space-between; }
.grow { flex: 1 1 auto; min-width: 0; }
.scroll-x { overflow-x: auto; }
label.field { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--di-fg-dim); }
input[type="text"], input[type="number"], select, textarea {
  font-family: var(--di-mono); font-size: 11px; color: var(--di-fg);
  background: var(--di-bg-sunken); border: 1px solid var(--di-line);
  border-radius: 7px; padding: 5px 7px; width: 100%;
}
textarea { resize: vertical; min-height: 92px; line-height: 1.5; white-space: pre; }
input[type="color"] { width: 32px; height: 26px; padding: 0; border: 1px solid var(--di-line); border-radius: 6px; background: none; }
input[type="range"] { width: 100%; }

.swatches { display: flex; flex-wrap: wrap; gap: 5px; }
.swatch {
  width: 34px; height: 30px; border-radius: 7px; border: 1px solid rgba(128,128,140,.45);
  cursor: pointer; position: relative; display: flex; align-items: flex-end; justify-content: center;
  font: 8px/1 var(--di-mono); padding-bottom: 2px; overflow: hidden;
}
.swatch.lg { width: 46px; height: 40px; }
.swatch .n { background: rgba(255,255,255,.75); color: #111; border-radius: 3px; padding: 0 2px; }
.swatch.alpha { background-image: linear-gradient(45deg, #ccc 25%, transparent 25% 75%, #ccc 75%), linear-gradient(45deg, #ccc 25%, transparent 25% 75%, #ccc 75%); background-size: 8px 8px; background-position: 0 0, 4px 4px; }
.pill {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px;
  background: var(--di-bg-sunken); border: 1px solid var(--di-line);
  font: 10.5px/1.5 var(--di-mono);
}
.pill.ok { color: var(--di-ok); border-color: currentColor; }
.pill.bad { color: var(--di-bad); border-color: currentColor; }
.pill.warn { color: var(--di-warn); border-color: currentColor; }
.bigratio { font: 700 22px/1 var(--di-font); }

.list { display: flex; flex-direction: column; gap: 6px; }
.item {
  display: flex; gap: 8px; align-items: center; padding: 6px;
  border: 1px solid var(--di-line); border-radius: 9px; background: var(--di-bg-soft);
}
.item .thumb {
  width: 46px; height: 46px; flex: 0 0 auto; border-radius: 6px; border: 1px solid var(--di-line);
  background: #fff center/contain no-repeat;
  background-image: linear-gradient(45deg, #e6e6ee 25%, transparent 25% 75%, #e6e6ee 75%), linear-gradient(45deg, #e6e6ee 25%, transparent 25% 75%, #e6e6ee 75%);
  background-size: 10px 10px; background-position: 0 0, 5px 5px;
}
.item .thumb img, .item .thumb svg { width: 100%; height: 100%; object-fit: contain; display: block; }
.item .meta { min-width: 0; flex: 1; }
.item .meta .name { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .meta .sub { font: 10px/1.4 var(--di-mono); color: var(--di-fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.tabs { display: flex; gap: 3px; border-bottom: 1px solid var(--di-line); padding: 0 10px; background: var(--di-bg-soft); }
.tabs button {
  font: 11px/1 var(--di-font); background: none; border: 0; border-bottom: 2px solid transparent;
  color: var(--di-fg-dim); padding: 7px 7px; cursor: pointer;
}
.tabs button[aria-selected="true"] { color: var(--di-fg); border-bottom-color: var(--di-accent); font-weight: 650; }

.hint { font-size: 10.5px; color: var(--di-fg-dim); }
.hint kbd { font: 10px/1 var(--di-mono); background: var(--di-bg-sunken); border: 1px solid var(--di-line); border-radius: 3px; padding: 1px 3px; }
.empty { padding: 14px 8px; text-align: center; color: var(--di-fg-dim); font-size: 11px; }

.bars { display: flex; flex-direction: column; gap: 4px; }
.barrow { display: grid; grid-template-columns: 1fr 44px; gap: 6px; align-items: center; font: 10.5px/1.3 var(--di-mono); }
.barrow .track { background: var(--di-bg-sunken); border-radius: 4px; overflow: hidden; height: 16px; position: relative; }
.barrow .fill { position: absolute; inset: 0 auto 0 0; background: var(--di-accent-soft); }
.barrow .lbl { position: relative; padding: 0 5px; line-height: 16px; white-space: nowrap; }
.barrow .cnt { text-align: right; color: var(--di-fg-dim); }

/* ---------- eyedropper loupe ---------- */
.loupe {
  position: fixed; width: 132px; height: 132px; border-radius: 50%;
  border: 3px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.45), var(--di-shadow);
  pointer-events: none; overflow: hidden; image-rendering: pixelated;
  transform: translate(-50%, -50%);
}
.loupe canvas { display: block; width: 100%; height: 100%; }
.loupe .cross { position: absolute; left: 50%; top: 50%; width: 13px; height: 13px; margin: -7px 0 0 -7px; border: 2px solid #fff; box-shadow: 0 0 0 1px #000; border-radius: 2px; }
.loupe-label {
  position: fixed; transform: translate(-50%, 0); pointer-events: none;
  font: 10px/1.3 var(--di-mono); background: #111; color: #fff;
  padding: 2px 5px; border-radius: 4px; white-space: nowrap;
}
.grab-layer { position: fixed; inset: 0; cursor: crosshair; background: transparent; }

.toast {
  position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%);
  background: #111827; color: #fff; font-size: 11.5px; padding: 7px 12px;
  border-radius: 999px; box-shadow: var(--di-shadow); pointer-events: none;
  opacity: 0; transition: opacity .16s ease, transform .16s ease;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }

.editing-outline { position: fixed; pointer-events: none; outline: 2px solid #e11d8f; outline-offset: 1px; }
`;
