// Word-level diff using Myers' O(ND) algorithm.
// Pure functions, no DOM: shared by the service worker, the dashboard and node:test.

/** Split text into word, whitespace and punctuation tokens. Joining the tokens gives back the text. */
export function tokenize(text) {
  if (!text) return [];
  return text.match(/\r?\n|[^\S\r\n]+|\p{N}+(?:[.,:]\p{N}+)*(?![\p{L}\p{N}_])|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_]/gu) || [];
}

/**
 * Myers shortest edit script over two arrays of primitives.
 * Returns an array of [op, index] steps (op: 0 equal, 1 insert from b, -1 delete from a),
 * or null when the edit distance exceeds maxD.
 */
export function myers(a, b, maxD = Infinity) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  v[off + 1] = 0;
  const trace = [];
  for (let d = 0; d <= max; d++) {
    // Snapshot of v before step d, limited to the diagonals step d reads: k in [-d-1, d+1].
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, d);
    }
  }
  return null;
}

function backtrack(trace, n, m, dEnd) {
  const steps = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d >= 0; d--) {
    const snap = trace[d];
    const at = (k) => snap[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; steps.push([0, x]); }
    if (d > 0) {
      if (x === prevX) steps.push([1, prevY]);
      else steps.push([-1, prevX]);
    }
    x = prevX;
    y = prevY;
  }
  return steps.reverse();
}

/** Classic LCS fallback used for small blocks when Myers gives up (never on huge inputs). */
function lcsSteps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const steps = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { steps.push([0, i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { steps.push([-1, i]); i++; }
    else { steps.push([1, j]); j++; }
  }
  while (i < n) steps.push([-1, i++]);
  while (j < m) steps.push([1, j++]);
  return steps;
}

function pushOp(ops, type, text) {
  if (!text) return;
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}

function stepsToOps(steps, a, b, ops) {
  for (const [op, i] of steps) {
    if (op === 0) pushOp(ops, 'eq', a[i]);
    else if (op === 1) pushOp(ops, 'add', b[i]);
    else pushOp(ops, 'del', a[i]);
  }
}

/** Diff two token arrays into ops, trimming common prefix/suffix first. */
function diffTokens(a, b, ops, maxD) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  pushOp(ops, 'eq', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length || midB.length) {
    const steps = myers(midA, midB, maxD);
    if (steps) stepsToOps(steps, midA, midB, ops);
    else if (midA.length * midB.length <= 4e6 && midA.length < 65535 && midB.length < 65535) stepsToOps(lcsSteps(midA, midB), midA, midB, ops);
    else return false;
  }
  pushOp(ops, 'eq', a.slice(endA).join(''));
  return true;
}

/**
 * Readability cleanup: absorb whitespace-only equalities sitting between changes, then
 * emit each change region as one deletion followed by one insertion
 * ("Sold out" -> "In stock" instead of interleaved single words).
 */
export function cleanupOps(ops) {
  const out = [];
  let del = '';
  let add = '';
  const flush = () => {
    pushOp(out, 'del', del);
    pushOp(out, 'add', add);
    del = '';
    add = '';
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'del') del += op.text;
    else if (op.type === 'add') add += op.text;
    else {
      const prev = ops[i - 1];
      const next = ops[i + 1];
      if (prev && next && prev.type !== 'eq' && next.type !== 'eq' && /^[^\S\n]+$/.test(op.text)) {
        del += op.text;
        add += op.text;
      } else {
        flush();
        pushOp(out, 'eq', op.text);
      }
    }
  }
  flush();
  return out;
}

function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * Word-level diff of two strings.
 * Returns [{type: 'eq'|'add'|'del', text}]. Concatenating eq+del gives `before`, eq+add gives `after`.
 * Large inputs fall back to a line diff whose changed blocks are refined word by word.
 */
export function diffWords(before = '', after = '', { maxD = 2000 } = {}) {
  before = String(before ?? '');
  after = String(after ?? '');
  const ops = [];
  if (before === after) { pushOp(ops, 'eq', before); return ops; }
  const ta = tokenize(before);
  const tb = tokenize(after);
  if (diffTokens(ta, tb, ops, maxD)) return cleanupOps(ops);

  // Fallback: line-level Myers, then word-level inside replaced line blocks.
  const out = [];
  const la = splitLines(before);
  const lb = splitLines(after);
  const lineOps = [];
  if (!diffTokens(la, lb, lineOps, 4000)) {
    pushOp(out, 'del', before);
    pushOp(out, 'add', after);
    return out;
  }
  for (let i = 0; i < lineOps.length; i++) {
    const op = lineOps[i];
    const next = lineOps[i + 1];
    if (op.type === 'del' && next && next.type === 'add') {
      const sub = [];
      if (diffTokens(tokenize(op.text), tokenize(next.text), sub, 500)) sub.forEach((s) => pushOp(out, s.type, s.text));
      else { pushOp(out, 'del', op.text); pushOp(out, 'add', next.text); }
      i++;
    } else {
      pushOp(out, op.type, op.text);
    }
  }
  return cleanupOps(out);
}

const WORD = /[\p{L}\p{N}]/u;

/** Count added / removed words (whitespace and punctuation-only tokens are ignored). */
export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'eq') continue;
    const words = tokenize(op.text).filter((t) => WORD.test(t)).length;
    if (op.type === 'add') added += words;
    else removed += words;
  }
  return { added, removed, changed: added + removed > 0 || ops.some((o) => o.type !== 'eq') };
}

/** Short human summary of a change, for notifications. */
export function changeSummary(ops, maxLen = 160) {
  const squash = (s) => s.replace(/\s+/g, ' ').trim();
  const added = squash(ops.filter((o) => o.type === 'add').map((o) => o.text).join(' … '));
  const removed = squash(ops.filter((o) => o.type === 'del').map((o) => o.text).join(' … '));
  const clip = (s) => (s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s);
  if (added && removed) return clip(`+ ${added}  − ${removed}`);
  if (added) return clip(`+ ${added}`);
  if (removed) return clip(`− ${removed}`);
  return 'Content changed';
}

/** Group ops into rows for a side-by-side view: [{left: ops[], right: ops[]}] split on newlines. */
export function sideBySide(ops) {
  const left = [[]];
  const right = [[]];
  const push = (side, type, text) => {
    const parts = text.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) side.push([]);
      if (p) side[side.length - 1].push({ type, text: p });
    });
  };
  // Keep the two sides aligned at equal newlines.
  for (const op of ops) {
    if (op.type === 'eq') {
      const parts = op.text.split('\n');
      parts.forEach((p, i) => {
        if (i > 0) {
          while (left.length < right.length) left.push([]);
          while (right.length < left.length) right.push([]);
          left.push([]);
          right.push([]);
        }
        if (p) {
          left[left.length - 1].push({ type: 'eq', text: p });
          right[right.length - 1].push({ type: 'eq', text: p });
        }
      });
    } else if (op.type === 'del') push(left, 'del', op.text);
    else push(right, 'add', op.text);
  }
  while (left.length < right.length) left.push(null);
  while (right.length < left.length) right.push(null);
  return left.map((l, i) => ({ left: l, right: right[i] }));
}
