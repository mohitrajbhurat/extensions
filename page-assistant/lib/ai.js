// Page Assistant: wrappers around Chrome's built-in AI APIs (Summarizer, LanguageModel,
// Writer, Rewriter). Everything is feature-detected; callers check availability() and
// fall back to lib/nlp.js when an API is missing.
import { chunkText, compressDocument, searchPassages } from './nlp.js';

const g = globalThis;
const LEGACY = { LanguageModel: 'languageModel', Summarizer: 'summarizer', Writer: 'writer', Rewriter: 'rewriter' };
export const API_NAMES = ['Summarizer', 'LanguageModel', 'Writer', 'Rewriter'];
export const SUPPORTED_OUTPUT = ['en', 'es', 'ja'];

function api(name) {
  if (g[name] && typeof g[name].create === 'function') return { kind: 'std', obj: g[name] };
  const legacy = g.ai && g.ai[LEGACY[name]];
  if (legacy && typeof legacy.create === 'function') return { kind: 'legacy', obj: legacy };
  return null;
}

export function hasAnyApi() { return API_NAMES.some((n) => !!api(n)); }

function langOpts(name, lang) {
  const l = SUPPORTED_OUTPUT.includes(lang) ? lang : 'en';
  if (name === 'LanguageModel') return { expectedInputs: [{ type: 'text', languages: [l] }], expectedOutputs: [{ type: 'text', languages: [l] }] };
  return { expectedInputLanguages: [l], expectedContextLanguages: [l], outputLanguage: l };
}

/** 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' */
export async function availability(name, { lang = 'en', options = {} } = {}) {
  const a = api(name);
  if (!a) return 'unsupported';
  try {
    if (a.kind === 'std') {
      let r;
      try { r = await a.obj.availability({ ...options, ...langOpts(name, lang) }); } catch (e) { r = await a.obj.availability(); }
      if (r === 'readily') return 'available';
      if (r === 'after-download') return 'downloadable';
      if (r === 'no') return 'unavailable';
      return r || 'unavailable';
    }
    const caps = await a.obj.capabilities();
    return caps.available === 'readily' ? 'available' : caps.available === 'after-download' ? 'downloadable' : 'unavailable';
  } catch (e) {
    return 'unavailable';
  }
}

export async function allAvailability(lang) {
  const out = {};
  await Promise.all(API_NAMES.map(async (n) => { out[n] = await availability(n, { lang }); }));
  return out;
}

const listeners = new Set();
/** Subscribe to download progress: fn({api, progress 0..1}). */
export function onDownloadProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emitProgress(apiName, progress) { for (const fn of listeners) { try { fn({ api: apiName, progress }); } catch (e) { /* ignore */ } } }

async function create(name, opts = {}, signal) {
  const a = api(name);
  if (!a) throw new Error(`${name} is not supported in this browser.`);
  const o = { ...opts };
  if (signal) o.signal = signal;
  o.monitor = (m) => {
    m.addEventListener('downloadprogress', (e) => {
      const p = e.total && e.total !== 1 ? e.loaded / e.total : e.loaded;
      emitProgress(name, Math.max(0, Math.min(1, p || 0)));
    });
  };
  try {
    return await a.obj.create(o);
  } catch (e) {
    // Older builds reject unknown language keys; retry with the bare options.
    if (e && (e.name === 'NotSupportedError' || e.name === 'TypeError') && (o.outputLanguage || o.expectedInputs)) {
      const { outputLanguage, expectedInputLanguages, expectedContextLanguages, expectedInputs, expectedOutputs, ...rest } = o;
      return a.obj.create(rest);
    }
    throw e;
  }
}

/** Trigger a model download (needs a user gesture). Resolves when ready. */
export async function prepare(name, lang = 'en') {
  const inst = await create(name, langOpts(name, lang));
  try { inst.destroy && inst.destroy(); } catch (e) { /* ignore */ }
  return true;
}

/** Read a streaming response; supports both delta and cumulative chunk styles. */
export async function readStream(stream, onText) {
  let acc = '';
  let mode = null; // 'delta' | 'cumulative'
  let first = null;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const v = String(value ?? '');
      if (first === null) { first = v; acc = v; }
      else {
        if (!mode) mode = v.length >= acc.length && v.startsWith(acc) && acc.length > 0 ? 'cumulative' : 'delta';
        acc = mode === 'cumulative' ? v : acc + v;
      }
      onText && onText(acc);
    }
  } else if (stream && stream[Symbol.asyncIterator]) {
    for await (const value of stream) {
      const v = String(value ?? '');
      if (first === null) { first = v; acc = v; }
      else {
        if (!mode) mode = v.length >= acc.length && v.startsWith(acc) && acc.length > 0 ? 'cumulative' : 'delta';
        acc = mode === 'cumulative' ? v : acc + v;
      }
      onText && onText(acc);
    }
  }
  return acc;
}

// ---------------- Summarizer ----------------
const summarizers = new Map();
async function getSummarizer({ type, length, lang, sharedContext }, signal) {
  const key = [type, length, lang].join('|');
  if (summarizers.has(key)) return summarizers.get(key);
  const s = await create('Summarizer', { type, length, format: 'markdown', sharedContext, ...langOpts('Summarizer', lang) }, signal);
  summarizers.set(key, s);
  return s;
}

async function fits(model, text) {
  const quota = model.inputQuota;
  if (!quota || !Number.isFinite(quota)) return text.length < 12000;
  if (text.length > quota * 6) return false;
  if (typeof model.measureInputUsage === 'function') {
    try { return (await model.measureInputUsage(text)) <= quota * 0.92; } catch (e) { /* fall through */ }
  }
  return text.length < quota * 2.5;
}

function chunkSizeFor(model) {
  const q = model.inputQuota;
  return q && Number.isFinite(q) ? Math.max(1500, Math.floor(q * 2.6)) : 8000;
}

/**
 * Summarize text of any length. Long inputs are split into chunks, each chunk is summarized
 * (map), and the partial summaries are summarized again (reduce) with the requested type.
 */
export async function summarize(text, { type = 'key-points', length = 'medium', lang = 'en', title = '', onText, onStatus, signal } = {}) {
  const shared = title ? `This is the text of a web page titled "${title}".` : undefined;
  onStatus && onStatus('Preparing on-device summarizer…');
  const finalModel = await getSummarizer({ type, length, lang, sharedContext: shared }, signal);
  let input = text;
  let round = 0;
  while (!(await fits(finalModel, input))) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    round++;
    const mapper = await getSummarizer({ type: 'tldr', length: round > 1 ? 'medium' : 'long', lang, sharedContext: shared }, signal);
    const chunks = chunkText(input, chunkSizeFor(mapper));
    if (round > 3 || chunks.length <= 1) { input = input.slice(0, chunkSizeFor(finalModel)); break; }
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      onStatus && onStatus(`Reading part ${i + 1} of ${chunks.length}${round > 1 ? ` (pass ${round})` : ''}…`);
      let part = chunks[i];
      if (!(await fits(mapper, part))) part = part.slice(0, Math.floor(part.length * 0.7));
      partials.push(await mapper.summarize(part, { context: `Part ${i + 1} of ${chunks.length} of the page.`, signal }));
    }
    input = partials.join('\n\n');
  }
  onStatus && onStatus(round ? `Combining ${round > 1 ? 'summaries' : 'part summaries'}…` : 'Summarizing…');
  let out;
  if (typeof finalModel.summarizeStreaming === 'function') {
    out = await readStream(finalModel.summarizeStreaming(input, { signal }), onText);
  } else {
    out = await finalModel.summarize(input, { signal });
    onText && onText(out);
  }
  return { text: out, chunked: round > 0 };
}

// ---------------- Language model (Prompt API) ----------------
let lastQuota = 0;
const SYSTEM_BASE = 'You are Page Assistant, a concise and accurate reading assistant running on the user\'s device. Answer in the same language as the question. Use Markdown for lists and emphasis. Base answers on the provided page content; if the page does not contain the answer, say so briefly and then give your best general knowledge, clearly labelled.';

async function lmCreate(system, lang, signal) {
  return create('LanguageModel', { initialPrompts: [{ role: 'system', content: system }], ...langOpts('LanguageModel', lang) }, signal);
}

/** Multi-turn chat grounded in one page. Long pages use retrieval per question. */
export class PageChat {
  constructor(doc, { lang = 'en', passages = [] } = {}) {
    this.doc = doc; // {title, url, text, blocks}
    this.lang = lang;
    this.passages = passages;
    this.session = null;
    this.mode = 'full';
    this.onOverflow = null;
  }

  async ensure(signal) {
    if (this.session) return this.session;
    const budget = lastQuota ? Math.floor(lastQuota * 2.2 * 0.55) : 7000;
    const full = this.doc.text || '';
    let content;
    if (full.length <= budget) { this.mode = 'full'; content = full; }
    else { this.mode = 'rag'; content = compressDocument(this.doc.blocks || full, { maxChars: Math.floor(budget * 0.6), title: this.doc.title }); }
    const sys = `${SYSTEM_BASE}\n\nPage title: ${this.doc.title || 'Untitled'}\nURL: ${this.doc.url || ''}\n\n${this.mode === 'full' ? 'Full page content' : 'Condensed page content (relevant excerpts will be added to each question)'}:\n"""\n${content}\n"""`;
    this.session = await lmCreate(sys, this.lang, signal);
    lastQuota = this.session.inputQuota || this.session.maxTokens || lastQuota;
    const ov = () => { this.onOverflow && this.onOverflow(); };
    try { this.session.addEventListener('quotaoverflow', ov); this.session.addEventListener('contextoverflow', ov); } catch (e) { /* ignore */ }
    return this.session;
  }

  sources(question) {
    return searchPassages(this.passages, question, { k: 3 });
  }

  async ask(question, { onText, signal } = {}) {
    const session = await this.ensure(signal);
    const found = this.sources(question);
    let prompt = question;
    if (this.mode === 'rag' && found.results.length) {
      const ex = found.results.map((r, i) => `[${i + 1}] ${r.passage.text}`).join('\n\n');
      prompt = `Relevant excerpts from the page:\n${ex}\n\nQuestion: ${question}`;
    }
    let text;
    if (typeof session.promptStreaming === 'function') text = await readStream(session.promptStreaming(prompt, { signal }), onText);
    else { text = await session.prompt(prompt, { signal }); onText && onText(text); }
    return { text, sources: found };
  }

  usage() {
    const s = this.session;
    if (!s) return null;
    const used = s.inputUsage ?? s.tokensSoFar;
    const quota = s.inputQuota ?? s.maxTokens;
    return used != null && quota ? { used, quota } : null;
  }

  destroy() { try { this.session && this.session.destroy(); } catch (e) { /* ignore */ } this.session = null; }
}

/** One-shot prompt with streaming, in a fresh session. */
export async function promptOnce(system, prompt, { lang = 'en', onText, signal, responseConstraint } = {}) {
  const s = await lmCreate(system, lang, signal);
  try {
    if (responseConstraint) {
      try { return await s.prompt(prompt, { signal, responseConstraint }); }
      catch (e) { if (e && e.name === 'AbortError') throw e; /* constraint unsupported: plain prompt */ }
      return await s.prompt(prompt + '\n\nRespond with JSON only.', { signal });
    }
    if (typeof s.promptStreaming === 'function') return await readStream(s.promptStreaming(prompt, { signal }), onText);
    const t = await s.prompt(prompt, { signal });
    onText && onText(t);
    return t;
  } finally {
    try { s.destroy(); } catch (e) { /* ignore */ }
  }
}

export function explain(selection, { title = '', context = '', lang, onText, signal } = {}) {
  const sys = 'You explain passages from web pages in plain language for a curious non-expert. Be concise: one short paragraph, then up to 4 bullet points for key terms or background. Use Markdown.';
  const prompt = `Page: ${title}\n${context ? `Surrounding context:\n"""${context}"""\n\n` : ''}Explain this passage:\n"""${selection}"""`;
  return promptOnce(sys, prompt, { lang, onText, signal });
}

export function simplify(text, { lang, onText, signal } = {}) {
  const sys = 'You rewrite text so a 12-year-old can understand it. Keep all key facts, use short sentences and everyday words, and do not add new information. Output only the rewritten text.';
  return promptOnce(sys, `Rewrite this in simple language:\n"""${text}"""`, { lang, onText, signal });
}

function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch (e) { /* continue */ }
  const m = String(s).match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* ignore */ } }
  return null;
}

export async function flashcards(doc, { count = 8, lang, signal } = {}) {
  const content = compressDocument(doc.blocks || doc.text, { maxChars: Math.floor((lastQuota ? lastQuota * 2.2 : 7000) * 0.6), title: doc.title });
  const schema = { type: 'object', properties: { cards: { type: 'array', minItems: 1, maxItems: count, items: { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' } }, required: ['front', 'back'] } } }, required: ['cards'] };
  const sys = 'You create high-quality study flashcards from a text. Each card tests one important fact or concept from the text. Fronts are short questions; backs are short, precise answers (one sentence).';
  const raw = await promptOnce(sys, `Create ${count} flashcards from this page titled "${doc.title}". Return JSON {"cards":[{"front","back"}]}.\n"""${content}"""`, { lang, signal, responseConstraint: schema });
  const data = parseJsonLoose(raw);
  const cards = data && Array.isArray(data.cards) ? data.cards : Array.isArray(data) ? data : [];
  return cards.filter((c) => c && c.front && c.back).slice(0, count).map((c) => ({ front: String(c.front), back: String(c.back), kind: 'ai' }));
}

export async function quiz(doc, { count = 5, lang, signal } = {}) {
  const content = compressDocument(doc.blocks || doc.text, { maxChars: Math.floor((lastQuota ? lastQuota * 2.2 : 7000) * 0.6), title: doc.title });
  const schema = { type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: count, items: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string' } }, answer: { type: 'integer', minimum: 0, maximum: 3 }, explanation: { type: 'string' } }, required: ['question', 'options', 'answer', 'explanation'] } } }, required: ['questions'] };
  const sys = 'You write fair multiple-choice quiz questions that check understanding of a text. Each question has exactly 4 options, one correct answer (0-based index), plausible distractors, and a one-sentence explanation citing the text.';
  const raw = await promptOnce(sys, `Write ${count} questions about this page titled "${doc.title}". Return JSON {"questions":[{"question","options","answer","explanation"}]}.\n"""${content}"""`, { lang, signal, responseConstraint: schema });
  const data = parseJsonLoose(raw);
  const qs = data && Array.isArray(data.questions) ? data.questions : [];
  return qs.filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answer) && q.answer < q.options.length)
    .slice(0, count).map((q) => ({ question: String(q.question), options: q.options.map(String), answer: q.answer, explanation: String(q.explanation || '') }));
}

// ---------------- Writer / Rewriter ----------------
export async function write(task, { context = '', tone = 'neutral', length = 'medium', lang = 'en', onText, signal } = {}) {
  const w = await create('Writer', { tone, length, format: 'markdown', sharedContext: context ? 'The user is reading a web page and wants to write about it.' : undefined, ...langOpts('Writer', lang) }, signal);
  try {
    if (typeof w.writeStreaming === 'function') return await readStream(w.writeStreaming(task, { context, signal }), onText);
    const t = await w.write(task, { context, signal });
    onText && onText(t);
    return t;
  } finally { try { w.destroy(); } catch (e) { /* ignore */ } }
}

export async function rewrite(text, { tone = 'as-is', length = 'as-is', context = '', lang = 'en', onText, signal } = {}) {
  const r = await create('Rewriter', { tone, length, format: 'as-is', sharedContext: context || undefined, ...langOpts('Rewriter', lang) }, signal);
  try {
    if (typeof r.rewriteStreaming === 'function') return await readStream(r.rewriteStreaming(text, { context, signal }), onText);
    const t = await r.rewrite(text, { context, signal });
    onText && onText(t);
    return t;
  } finally { try { r.destroy(); } catch (e) { /* ignore */ } }
}

export function resetCaches() {
  for (const s of summarizers.values()) { try { s.destroy(); } catch (e) { /* ignore */ } }
  summarizers.clear();
}
