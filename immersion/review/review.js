// Language Immersion - review, quizzes, word list and progress.
const LIM = globalThis.LIM;
const $ = (id) => document.getElementById(id);
const esc = LIM.escapeHtml;
const send = (msg) => chrome.runtime.sendMessage(msg);

const ICON = {
  speak: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 10v4a1 1 0 0 0 1 1h3l4 4V5L7 9H4a1 1 0 0 0-1 1zm13.5 2A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62A7.97 7.97 0 0 1 12.5 11c3.1 0 5.76 1.9 6.9 4.6l2.37-.78A10 10 0 0 0 12.5 8z"/></svg>',
};

const state = {
  settings: { ...LIM.DEFAULT_SETTINGS },
  vocab: {},
  activity: {},
  lang: 'all',
  tab: 'review',
  deck: [],
  deckIndex: 0,
  revealed: false,
  deckDone: 0,
  wordFilter: 'all',
  sort: 'recent',
  search: '',
  quizMode: 'mixed',
  quizPool: 'due',
  quiz: null,
};

// ---------- data ----------
async function load() {
  const [st, data] = await Promise.all([send({ type: 'getState' }), send({ type: 'getVocab' })]);
  if (st && st.settings) state.settings = st.settings;
  state.vocab = (data && data.vocab) || {};
  state.activity = (data && data.activity) || {};
}
function entries() {
  const all = Object.entries(state.vocab).map(([key, e]) => ({ ...e, key }));
  return state.lang === 'all' ? all : all.filter((e) => e.lang === state.lang);
}
function dueEntries(now = Date.now()) {
  return entries().filter((e) => e.state === 'learning' && (e.due || 0) <= now).sort((a, b) => (a.due || 0) - (b.due || 0));
}
function studyPool() {
  const all = entries();
  if (state.quizPool === 'due') { const d = dueEntries(); return d.length ? d : all.filter((e) => e.state === 'learning'); }
  if (state.quizPool === 'learning') return all.filter((e) => e.state === 'learning');
  return all.filter((e) => e.state !== 'new' || (e.seen || 0) > 0);
}
function display(e, plural) {
  const art = LIM.article(e.lang, e.g, e.tr, plural);
  return { art, tr: e.tr };
}
function speak(e) { LIM.speak(e.tr, e.lang, state.settings.speechRate); }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- tabs ----------
function setTab(tab) {
  if (!['review', 'quiz', 'words', 'stats'].includes(tab)) tab = 'review';
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(`panel-${b.dataset.tab}`).hidden = !on;
  }
  if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
  render();
}

function render() {
  renderLangFilter();
  if (state.tab === 'review') renderReview();
  else if (state.tab === 'quiz') renderQuiz();
  else if (state.tab === 'words') renderWords();
  else renderStats();
}

function renderLangFilter() {
  const sel = $('langFilter');
  const langs = [...new Set(Object.values(state.vocab).map((e) => e.lang))].sort();
  const want = ['all', ...langs].includes(state.lang) ? state.lang : 'all';
  state.lang = want;
  const html = ['<option value="all">All languages</option>', ...langs.map((l) => `<option value="${esc(l)}">${esc(LIM.langName(l))}</option>`)].join('');
  if (sel.dataset.sig !== html) { sel.innerHTML = html; sel.dataset.sig = html; }
  sel.value = want;
  sel.parentElement.classList.toggle('hidden', langs.length < 2);
}

// ---------- review deck ----------
function buildDeck() {
  const due = dueEntries();
  const extra = entries().filter((e) => e.state === 'learning' && !due.includes(e)).sort((a, b) => (a.due || 0) - (b.due || 0));
  state.deck = due.length ? due.slice(0, 40) : extra.slice(0, 20);
  state.deckIndex = 0;
  state.revealed = false;
  state.deckDone = 0;
}

function renderBoxes() {
  const counts = [0, 0, 0, 0, 0], dues = [0, 0, 0, 0, 0];
  const now = Date.now();
  for (const e of entries()) {
    if (e.state !== 'learning') continue;
    const b = Math.min(5, Math.max(1, e.box || 1));
    counts[b - 1]++;
    if ((e.due || 0) <= now) dues[b - 1]++;
  }
  const labels = ['every day', 'after 1 day', 'after 3 days', 'after a week', 'after 16 days'];
  $('boxes').innerHTML = counts.map((c, i) =>
    `<div class="lbox ${dues[i] ? 'hasdue' : ''}"><b>${c}</b><span>Box ${i + 1} &middot; ${labels[i]}${dues[i] ? ` &middot; ${dues[i]} due` : ''}</span></div>`).join('');
}

function renderReview() {
  renderBoxes();
  const deck = $('deck');
  if (!state.deck.length) buildDeck();
  if (!state.deck.length) {
    const total = entries().length;
    deck.innerHTML = `<div class="card empty">
      <h3>${total ? 'Nothing due right now' : 'No words yet'}</h3>
      <p>${total
        ? 'Keep browsing: words you meet are tracked automatically, and anything you save with "Save to review" turns up here.'
        : 'Browse the web with immersion on. Hover a swapped word and choose "Save to review", or let words join your deck automatically after you have seen them a few times.'}</p>
      ${total ? '<button class="btn" id="studyAhead">Study ahead</button>' : ''}
    </div>`;
    const ahead = $('studyAhead');
    if (ahead) ahead.onclick = () => {
      const pool = entries().filter((e) => e.state !== 'known').sort((a, b) => (a.due || 0) - (b.due || 0));
      if (!pool.length) return toast('Every word is already marked known');
      state.deck = pool.slice(0, 20);
      state.deckIndex = 0; state.revealed = false; state.deckDone = 0;
      renderReview();
    };
    return;
  }
  const e = state.deck[state.deckIndex];
  if (!e) return finishDeck();
  const d = display(e);
  const pct = Math.round((state.deckIndex / state.deck.length) * 100);
  deck.innerHTML = `
    <div class="fc-progress"><i style="width:${pct}%"></i></div>
    <div class="flashcard">
      <div class="fc-prompt" lang="${esc(e.lang)}">${d.art ? `<span class="art">${esc(d.art)}</span>` : ''}${esc(d.tr)}</div>
      <div class="fc-sub">${esc(LIM.langName(e.lang))}${e.pos ? ' &middot; ' + esc(LIM.POS_LABEL[e.pos] || e.pos) : ''}${e.g && e.g !== 'x' ? ' &middot; ' + esc(LIM.genderLabel(e.g)) : ''}</div>
      ${state.revealed ? `
        <div class="fc-answer">
          <div class="word">${esc(e.en)}</div>
          ${e.context ? `<div class="fc-ctx">&ldquo;${esc(e.context)}&rdquo;${e.url ? ` <a href="${esc(e.url)}" target="_blank" rel="noreferrer">source</a>` : ''}</div>` : ''}
        </div>
        <div class="fc-actions">
          <button class="btn danger" data-act="again">Again <span class="kbd">1</span></button>
          <button class="btn primary" data-act="good">I knew it <span class="kbd">2</span></button>
          <button class="btn ghost" data-act="speak">${ICON.speak} Listen</button>
        </div>` : `
        <div class="fc-actions">
          <button class="btn primary" data-act="reveal">Show answer <span class="kbd">Space</span></button>
          <button class="btn ghost" data-act="speak">${ICON.speak} Listen</button>
        </div>`}
      <div class="fc-meta">
        <span>Card ${state.deckIndex + 1} of ${state.deck.length}</span>
        <span>Box ${e.box || 1} of 5</span>
        <span>Seen ${e.seen || 0}&times;</span>
        ${e.correct || e.wrong ? `<span>${e.correct || 0} right / ${e.wrong || 0} wrong</span>` : ''}
      </div>
    </div>`;
  deck.querySelectorAll('button[data-act]').forEach((b) => { b.onclick = () => deckAction(b.dataset.act); });
}

async function deckAction(act) {
  const e = state.deck[state.deckIndex];
  if (!e) return;
  if (act === 'speak') return speak(e);
  if (act === 'reveal') { state.revealed = true; return renderReview(); }
  if (act === 'again' || act === 'good') {
    const r = await send({ type: 'reviewResult', key: e.key, correct: act === 'good' });
    if (r && r.entry) state.vocab[e.key] = r.entry;
    state.deckDone++;
    state.deckIndex++;
    state.revealed = false;
    if (state.deckIndex >= state.deck.length) return finishDeck();
    renderReview();
  }
}

function finishDeck() {
  const done = state.deckDone;
  state.deck = [];
  renderBoxes();
  $('deck').innerHTML = `<div class="card empty">
    <h3>Session complete</h3>
    <p>${done} card${done === 1 ? '' : 's'} reviewed. Correct answers come back later; the ones you missed return today.</p>
    <div class="row" style="justify-content:center">
      <button class="btn primary" id="again">Review more</button>
      <button class="btn" id="toQuiz">Take a quiz</button>
    </div>
  </div>`;
  $('again').onclick = () => { buildDeck(); renderReview(); };
  $('toQuiz').onclick = () => setTab('quiz');
}

// ---------- quiz ----------
function renderQuiz() {
  if (state.quiz) return renderQuizQuestion();
  $('quizSetup').classList.remove('hidden');
  $('quizRun').classList.add('hidden');
  for (const [id, val] of [['quizMode', state.quizMode], ['quizPool', state.quizPool]]) {
    for (const b of $(id).querySelectorAll('button')) {
      const on = b.dataset.v === val;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  const pool = studyPool();
  const hasVoice = typeof speechSynthesis !== 'undefined';
  $('quizPoolInfo').textContent = pool.length
    ? `${pool.length} word${pool.length === 1 ? '' : 's'} available${!hasVoice && state.quizMode === 'listen' ? ' · speech is unavailable in this browser' : ''}`
    : 'No words available yet - browse with immersion on, or save words from the hover card.';
  $('startQuiz').disabled = pool.length < 1;
}

function buildQuiz() {
  const pool = studyPool();
  const all = entries().filter((e) => e.tr);
  const picked = shuffle(pool.slice()).slice(0, 10);
  const questions = picked.map((e) => {
    let mode = state.quizMode;
    if (mode === 'mixed') {
      const modes = ['choice', 'choice', 'type'];
      if (typeof speechSynthesis !== 'undefined' && LIM.pickVoice(e.lang)) modes.push('listen');
      mode = modes[Math.floor(Math.random() * modes.length)];
    }
    const q = { entry: e, mode, answered: false, correct: false, given: '' };
    if (mode === 'choice') {
      const dir = Math.random() < 0.5 ? 'toNative' : 'toTarget';
      q.dir = dir;
      const distractors = shuffle(all.filter((o) => o.key !== e.key && o.lang === e.lang && (!e.pos || !o.pos || o.pos === e.pos)))
        .slice(0, 3);
      while (distractors.length < 3) {
        const extra = all.filter((o) => o.key !== e.key && !distractors.includes(o));
        if (!extra.length) break;
        distractors.push(extra[Math.floor(Math.random() * extra.length)]);
      }
      q.options = shuffle([e, ...distractors]).map((o) => ({ key: o.key, text: dir === 'toNative' ? o.en : o.tr, lang: dir === 'toNative' ? 'en' : o.lang }));
    }
    return q;
  });
  state.quiz = { questions, index: 0, score: 0 };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function renderQuizQuestion() {
  $('quizSetup').classList.add('hidden');
  const run = $('quizRun');
  run.classList.remove('hidden');
  const q = state.quiz.questions[state.quiz.index];
  if (!q) return renderQuizResult();
  const e = q.entry;
  const d = display(e);
  const head = `<div class="q-head"><span>Question ${state.quiz.index + 1} of ${state.quiz.questions.length}</span><span>${state.quiz.score} correct</span></div>
    <div class="fc-progress"><i style="width:${Math.round((state.quiz.index / state.quiz.questions.length) * 100)}%"></i></div>`;
  let body = '';
  if (q.mode === 'choice') {
    const prompt = q.dir === 'toNative' ? `What does this ${LIM.langName(e.lang)} word mean?` : `How do you say this in ${LIM.langName(e.lang)}?`;
    const word = q.dir === 'toNative' ? `<span lang="${esc(e.lang)}">${d.art ? `<span class="art">${esc(d.art)}</span>` : ''}${esc(d.tr)}</span>` : esc(e.en);
    body = `<div class="q-prompt">${prompt}</div><div class="q-word">${word}</div>
      <div class="choices">${q.options.map((o, i) => `<button class="choice" data-key="${esc(o.key)}" lang="${esc(o.lang)}"><span class="num">${i + 1}</span>${esc(o.text)}</button>`).join('')}</div>`;
  } else if (q.mode === 'type') {
    body = `<div class="q-prompt">Type the ${LIM.langName(e.lang)} translation</div><div class="q-word">${esc(e.en)}</div>
      <form class="answer-form"><input type="text" id="answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" lang="${esc(e.lang)}" placeholder="Your answer" aria-label="Your answer"><button class="btn primary" type="submit">Check</button></form>`;
  } else {
    body = `<div class="q-prompt">Listen and type what you hear</div>
      <button class="big-speak" id="playAgain" aria-label="Play audio">${ICON.speak}</button>
      <form class="answer-form"><input type="text" id="answer" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" lang="${esc(e.lang)}" placeholder="What did you hear?" aria-label="What did you hear?"><button class="btn primary" type="submit">Check</button></form>`;
  }
  run.innerHTML = `<div class="quiz-card">${head}${body}<div id="verdict"></div>
    <div class="q-foot"><button class="btn ghost sm" id="quitQuiz">End quiz</button><span class="muted small" id="hint"></span></div></div>`;
  $('quitQuiz').onclick = () => renderQuizResult();
  if (q.mode === 'choice') {
    run.querySelectorAll('.choice').forEach((b) => { b.onclick = () => answerQuiz(b.dataset.key === e.key, b); });
    $('hint').innerHTML = 'Press <span class="kbd">1</span>-<span class="kbd">4</span> to answer';
  } else {
    const form = run.querySelector('form');
    form.onsubmit = (ev) => { ev.preventDefault(); checkTyped(); };
    $('answer').focus();
    if (q.mode === 'listen') { $('playAgain').onclick = () => speak(e); speak(e); $('hint').textContent = 'Type the word you hear'; }
    else $('hint').textContent = 'Accents are optional';
  }
}

function checkTyped() {
  const q = state.quiz.questions[state.quiz.index];
  if (q.answered) return nextQuestion();
  const input = $('answer');
  const given = input.value;
  if (!given.trim()) return;
  const target = q.entry.tr;
  const ok = LIM.normalizeAnswer(given) === LIM.normalizeAnswer(target) ||
    LIM.normalizeAnswer(LIM.stripArticle(given)) === LIM.normalizeAnswer(LIM.stripArticle(target));
  q.given = given;
  input.classList.add(ok ? 'right' : 'wrong');
  input.readOnly = true;
  answerQuiz(ok, null);
}

async function answerQuiz(correct, btn) {
  const q = state.quiz.questions[state.quiz.index];
  if (q.answered) return;
  q.answered = true;
  q.correct = correct;
  if (correct) state.quiz.score++;
  const e = q.entry;
  if (q.mode === 'choice') {
    for (const b of document.querySelectorAll('.choice')) {
      b.disabled = true;
      if (b.dataset.key === e.key) b.classList.add('right');
      else if (b === btn) b.classList.add('wrong');
    }
  }
  const d = display(e);
  $('verdict').innerHTML = `<div class="verdict ${correct ? 'right' : 'wrong'}">
      <span>${correct ? 'Correct' : `Answer: ${d.art ? d.art + ' ' : ''}${esc(e.tr)} = ${esc(e.en)}`}</span>
      <span class="row"><button class="btn sm ghost" id="speakAns">${ICON.speak} Listen</button>
      <button class="btn sm primary" id="nextQ">${state.quiz.index + 1 >= state.quiz.questions.length ? 'See results' : 'Next'} <span class="kbd">&crarr;</span></button></span>
    </div>`;
  $('speakAns').onclick = () => speak(e);
  $('nextQ').onclick = nextQuestion;
  $('nextQ').focus();
  const r = await send({ type: 'reviewResult', key: e.key, correct });
  if (r && r.entry) state.vocab[e.key] = r.entry;
}

function nextQuestion() {
  state.quiz.index++;
  if (state.quiz.index >= state.quiz.questions.length) renderQuizResult();
  else renderQuizQuestion();
}

function renderQuizResult() {
  const quiz = state.quiz;
  state.quiz = null;
  const answered = quiz.questions.filter((q) => q.answered);
  const pct = answered.length ? Math.round((quiz.score / answered.length) * 100) : 0;
  const missed = answered.filter((q) => !q.correct);
  $('quizRun').innerHTML = `<div class="quiz-card">
    <div class="score-ring">${pct}%</div>
    <p class="muted" style="text-align:center">${quiz.score} of ${answered.length} correct${missed.length ? ' · the misses are back in box 1' : ''}</p>
    ${missed.length ? `<h3 style="margin-top:20px">Worth another look</h3><div class="word-list">${missed.map((q) => {
      const d = display(q.entry);
      return `<div class="wrow"><span class="tr" lang="${esc(q.entry.lang)}">${d.art ? `<span class="art">${esc(d.art)}</span>` : ''}${esc(q.entry.tr)}</span><span class="en">${esc(q.entry.en)}</span><span class="meta">${q.given ? 'you wrote: ' + esc(q.given) : ''}</span><span></span></div>`;
    }).join('')}</div>` : ''}
    <div class="q-foot" style="justify-content:center;margin-top:24px">
      <button class="btn primary" id="againQuiz">Another quiz</button>
      <button class="btn" id="backReview">Back to review</button>
    </div></div>`;
  $('againQuiz').onclick = () => { buildQuiz(); renderQuizQuestion(); };
  $('backReview').onclick = () => { buildDeck(); setTab('review'); };
}

// ---------- word list ----------
function renderWords() {
  for (const b of $('wordFilter').querySelectorAll('button')) {
    const on = b.dataset.v === state.wordFilter;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('sort').value = state.sort;
  const now = Date.now();
  let list = entries();
  if (state.wordFilter === 'learning') list = list.filter((e) => e.state === 'learning');
  else if (state.wordFilter === 'known') list = list.filter((e) => e.state === 'known');
  else if (state.wordFilter === 'saved') list = list.filter((e) => e.saved);
  else if (state.wordFilter === 'due') list = list.filter((e) => e.state === 'learning' && (e.due || 0) <= now);
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((e) => e.en.toLowerCase().includes(q) || (e.tr || '').toLowerCase().includes(q));
  const cmp = {
    recent: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
    seen: (a, b) => (b.seen || 0) - (a.seen || 0),
    alpha: (a, b) => a.en.localeCompare(b.en),
    due: (a, b) => (a.due || Infinity) - (b.due || Infinity),
    box: (a, b) => (a.box || 0) - (b.box || 0) || a.en.localeCompare(b.en),
  }[state.sort];
  list.sort(cmp);
  const el = $('wordList');
  if (!list.length) {
    el.innerHTML = `<div class="wrow"><span class="muted" style="grid-column:1/-1">${q ? 'No words match that search.' : 'Nothing here yet. Browse with immersion on to collect words.'}</span></div>`;
    return;
  }
  el.innerHTML = list.slice(0, 500).map((e) => {
    const d = display(e);
    const dueTxt = e.state === 'learning' ? ((e.due || 0) <= now ? 'due now' : 'in ' + relDays(e.due - now)) : '';
    return `<div class="wrow" data-key="${esc(e.key)}">
      <span class="tr" lang="${esc(e.lang)}">${d.art ? `<span class="art">${esc(d.art)}</span>` : ''}${esc(e.tr)}</span>
      <span class="en">${esc(e.en)}${e.pos ? ` <span class="small muted">&middot; ${esc(LIM.POS_LABEL[e.pos] || e.pos)}</span>` : ''}</span>
      <span class="meta"><span class="chip ${esc(e.state)}">${e.state === 'learning' ? 'Box ' + (e.box || 1) : e.state === 'known' ? 'Known' : 'New'}</span>
        <span>seen ${e.seen || 0}&times;</span>${dueTxt ? `<span>${esc(dueTxt)}</span>` : ''}</span>
      <span class="acts">
        <button class="iconbtn" data-act="speak" title="Pronounce" aria-label="Pronounce ${esc(e.tr)}">${ICON.speak}</button>
        <button class="iconbtn" data-act="toggle" title="${e.state === 'known' ? 'Move back to learning' : 'Mark as known'}" aria-label="${e.state === 'known' ? 'Move back to learning' : 'Mark as known'}">${e.state === 'known' ? ICON.undo : ICON.check}</button>
        <button class="iconbtn danger" data-act="delete" title="Forget this word" aria-label="Forget ${esc(e.en)}">${ICON.trash}</button>
      </span>
    </div>`;
  }).join('') + (list.length > 500 ? `<div class="wrow"><span class="muted" style="grid-column:1/-1">Showing the first 500 of ${list.length} words.</span></div>` : '');
  el.onclick = async (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const key = btn.closest('.wrow').dataset.key;
    const e = state.vocab[key];
    if (!e) return;
    if (btn.dataset.act === 'speak') return LIM.speak(e.tr, e.lang, state.settings.speechRate);
    if (btn.dataset.act === 'toggle') {
      const next = e.state === 'known' ? 'learning' : 'known';
      const r = await send({ type: 'setWordState', item: { ...e, key }, state: next });
      if (r && r.entry) state.vocab[key] = r.entry;
      toast(next === 'known' ? `"${e.tr}" marked known` : `"${e.tr}" back in the deck`);
    } else if (btn.dataset.act === 'delete') {
      await send({ type: 'deleteWord', key });
      delete state.vocab[key];
      toast(`Forgot "${e.tr}"`);
    }
    renderWords();
  };
}
function relDays(ms) {
  const d = Math.round(ms / LIM.DAY_MS);
  if (d <= 0) return 'under a day';
  return d === 1 ? '1 day' : `${d} days`;
}

// ---------- stats ----------
function renderStats() {
  const stats = LIM.computeStats(
    state.lang === 'all' ? state.vocab : Object.fromEntries(Object.entries(state.vocab).filter(([, e]) => e.lang === state.lang)),
    state.activity);
  const goal = state.settings.dailyGoal || 10;
  $('statGrid').innerHTML = [
    ['Words learned', stats.known], ['Learning', stats.learning], ['Encountered', stats.seenWords],
    ['Due now', stats.due], ['Day streak', stats.streak], ['Seen today', `${stats.seenToday}`],
    ['Reviews today', `${stats.reviewedToday} / ${goal}`], ['Total exposures', stats.exposures],
  ].map(([label, v]) => `<div class="stat"><b>${esc(String(v))}</b><span>${esc(label)}</span></div>`).join('');

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = LIM.todayKey(d);
    days.push({ k, ...(state.activity[k] || { seen: 0, reviewed: 0 }) });
  }
  const max = Math.max(5, ...days.map((d) => (d.seen || 0) + (d.reviewed || 0)));
  $('chart').innerHTML = days.map((d) => `<div class="day" title="${d.k}: ${d.seen || 0} seen, ${d.reviewed || 0} reviewed">
      <div class="bar rev" style="height:${((d.reviewed || 0) / max) * 100}%"></div>
      <div class="bar seen" style="height:${((d.seen || 0) / max) * 100}%"></div></div>`).join('');

  const byLang = {};
  for (const e of Object.values(state.vocab)) {
    const b = byLang[e.lang] || (byLang[e.lang] = { known: 0, learning: 0, new: 0 });
    b[e.state === 'known' ? 'known' : e.state === 'learning' ? 'learning' : 'new']++;
  }
  const rows = Object.entries(byLang).sort((a, b) => (b[1].known + b[1].learning + b[1].new) - (a[1].known + a[1].learning + a[1].new));
  $('byLang').innerHTML = rows.length ? rows.map(([lang, b]) => {
    const total = b.known + b.learning + b.new;
    return `<div class="langrow"><span class="name">${esc(LIM.langName(lang))}</span>
      <span class="langbar">${['known', 'learning', 'new'].map((k) => `<i class="${k}" style="width:${(b[k] / total) * 100}%"></i>`).join('')}</span>
      <span class="muted small">${b.known} known / ${total}</span></div>`;
  }).join('') : '<p class="muted small">No words tracked yet.</p>';
}

// ---------- data export/import ----------
async function exportData() {
  const data = await send({ type: 'exportData' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `language-immersion-${LIM.todayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Exported your vocabulary');
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const r = await send({ type: 'importData', data });
    if (r && r.error) throw new Error(r.error);
    await load();
    render();
    toast(`Imported ${r.added} word${r.added === 1 ? '' : 's'}`);
  } catch (e) {
    toast('Import failed: ' + (e.message || e));
  }
}

// ---------- events ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (state.tab === 'review' && state.deck.length) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); deckAction(state.revealed ? 'good' : 'reveal'); }
    else if (state.revealed && e.key === '1') deckAction('again');
    else if (state.revealed && e.key === '2') deckAction('good');
    else if (e.key.toLowerCase() === 's') deckAction('speak');
  } else if (state.tab === 'quiz' && state.quiz) {
    const q = state.quiz.questions[state.quiz.index];
    if (!q) return;
    if (q.answered && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); nextQuestion(); }
    else if (!q.answered && q.mode === 'choice' && /^[1-4]$/.test(e.key)) {
      const b = document.querySelectorAll('.choice')[Number(e.key) - 1];
      if (b) b.click();
    }
  }
});
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const tabs = ['review', 'quiz', 'words', 'stats'];
  let i = tabs.indexOf(state.tab);
  if (e.key === 'ArrowRight') i = (i + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') i = (i + tabs.length - 1) % tabs.length;
  else return;
  e.preventDefault();
  setTab(tabs[i]);
  $('tab-' + tabs[i]).focus();
});
$('langFilter').addEventListener('change', (e) => { state.lang = e.target.value; state.deck = []; render(); });
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('search').addEventListener('input', (e) => { state.search = e.target.value; renderWords(); });
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderWords(); });
$('wordFilter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.wordFilter = b.dataset.v; renderWords(); } });
$('quizMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.quizMode = b.dataset.v; renderQuiz(); } });
$('quizPool').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { state.quizPool = b.dataset.v; renderQuiz(); } });
$('startQuiz').addEventListener('click', () => { buildQuiz(); renderQuizQuestion(); });
$('exportBtn').addEventListener('click', exportData);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; });
addEventListener('hashchange', () => setTab(location.hash.slice(1)));
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.vocab && !state.quiz && state.tab !== 'review') { await load(); render(); }
});

(async function init() {
  await load();
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.getVoices();
  setTab(location.hash.slice(1) || 'review');
})();
