import './style.css';
import assessments from '../data/assessments.json';
import { getParticipant } from './lib/session.js';
import { logEvent, logAssessment, logReflection, flush } from './lib/logger.js';
import { updateQuizProgress } from './lib/progress.js';

const participant = getParticipant();
if (!participant) window.location.replace('/');

const params = new URLSearchParams(window.location.search);
const week = Number(params.get('week'));
const session = Number(params.get('session'));
const set = assessments.find((a) => a.week === week && a.session === session);
if (!set) window.location.replace('/lessons.html');

let index = 0;
let answered = false;
let shownAt = Date.now();
const results = [];

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const TYPE_STYLE = {
  '회로 이해': 'bg-primary/10 text-primary',
  '결과 예측': 'bg-secondary-soft text-secondary',
  '오류 수정': 'bg-red-50 text-accent-red',
};

/* ===================== 진행 표시 ===================== */

/**
 * 시작 화면의 트랙을 그린다. 문항 유형이 곧 안내문이 된다 —
 * '회로를 읽는 문제, 결과를 예상하는 문제...'를 문장으로 읽히는 대신 보여준다.
 */
function renderTrack() {
  const host = document.getElementById('intro-track');
  host.innerHTML = '';

  // 레일은 첫 점 중심에서 마지막 점 중심까지만. 문항 수가 달라져도
  // 맞도록 칸 절반만큼 좌우를 들여 놓는다.
  const inset = 50 / set.items.length;
  const rail = document.querySelector('.track-rail');
  rail.style.left = `${inset}%`;
  rail.style.right = `${inset}%`;
  set.items.forEach((item, i) => {
    const stop = el('div', 'track-stop text-center', null);
    stop.style.width = `${100 / set.items.length}%`;

    const dot = el('b',
      'track-dot w-9 h-9 rounded-full grid place-items-center mx-auto mb-3 '
      + 'bg-white border-2 border-slate-200 font-code text-sm text-slate-400',
      String(i + 1));
    stop.appendChild(dot);
    stop.appendChild(el('span',
      'track-label block text-[13px] font-medium text-slate-600 opacity-0', item.type));
    host.appendChild(stop);
  });
}

/** 헤더의 진행 점. 시작 화면의 트랙과 같은 언어를 쓴다. */
function renderSteps(allDone = false) {
  const host = document.getElementById('quiz-steps');
  host.innerHTML = '';
  set.items.forEach((item, i) => {
    const done = allDone || i < index;
    const now = !allDone && i === index;
    const dot = el('span',
      `h-2 rounded-full transition-all ${now ? 'w-5 bg-primary' : 'w-2 '}`
      + (now ? '' : done ? 'bg-primary/50' : 'bg-slate-200'));
    dot.title = `${i + 1}. ${item.type}`;
    host.appendChild(dot);
  });
}

/* ===================== 문항 ===================== */

function renderItem() {
  const item = set.items[index];
  answered = false;
  shownAt = Date.now();

  renderSteps();

  const host = document.getElementById('item');
  host.innerHTML = '';
  host.classList.remove('hidden');

  host.appendChild(el('span',
    `inline-block text-[11px] font-bold px-2 py-1 rounded-full ${TYPE_STYLE[item.type] || 'bg-slate-100 text-slate-600'}`,
    item.type));

  host.appendChild(el('h2', 'mt-3 text-2xl font-bold leading-snug tracking-tight', item.question));

  if (item.code) {
    const pre = el('pre',
      'mt-5 bg-white border border-slate-200 rounded-xl px-5 py-4 overflow-x-auto '
      + 'text-[14px] leading-relaxed font-code text-slate-800');
    pre.textContent = item.code;
    host.appendChild(pre);
  }

  const list = el('div', 'mt-6 space-y-2.5');
  item.choices.forEach((choice, i) => {
    const button = el('button',
      'w-full text-left bg-white border border-slate-200 rounded-xl px-5 py-4 '
      + 'hover:border-primary hover:bg-primary-soft/40 transition flex items-start gap-3.5');
    button.dataset.choice = String(i);
    button.appendChild(el('span',
      'w-6 h-6 rounded-full border border-slate-300 text-[11px] font-bold '
      + 'flex items-center justify-center shrink-0 mt-0.5', String(i + 1)));
    button.appendChild(el('span', 'text-[15px] leading-relaxed', choice));
    button.addEventListener('click', () => choose(i));
    list.appendChild(button);
  });
  host.appendChild(list);

  const feedback = el('div', 'hidden mt-4');
  feedback.id = 'feedback';
  host.appendChild(feedback);
}

async function choose(picked) {
  if (answered) return;          // 한 문항에 한 번만. 고쳐 찍으면 데이터가 흐려진다.
  answered = true;

  const item = set.items[index];
  const correct = picked === item.answer;
  const elapsed = Date.now() - shownAt;
  results.push({ item, picked, correct });

  document.querySelectorAll('#item [data-choice]').forEach((button) => {
    const i = Number(button.dataset.choice);
    button.disabled = true;
    button.classList.remove('hover:border-primary', 'hover:bg-primary-soft/40');
    if (i === item.answer) {
      button.className = button.className.replace('border-slate-200', 'border-green-400')
        + ' bg-green-50';
    } else if (i === picked) {
      button.className = button.className.replace('border-slate-200', 'border-red-300')
        + ' bg-red-50';
    } else {
      button.classList.add('opacity-50');
    }
  });

  const feedback = document.getElementById('feedback');
  feedback.className = 'mt-4 rounded-xl px-4 py-3.5 '
    + (correct ? 'bg-green-50 border border-green-200' : 'bg-secondary-soft border border-secondary/25');
  const head = el('div', 'flex items-center gap-2 mb-1.5');
  head.appendChild(el('span',
    `material-icons-round text-base ${correct ? 'text-accent-green' : 'text-secondary'}`,
    correct ? 'check_circle' : 'lightbulb'));
  head.appendChild(el('span',
    `text-sm font-bold ${correct ? 'text-green-800' : 'text-slate-700'}`,
    correct ? '맞았어!' : '다시 보자'));
  feedback.appendChild(head);
  feedback.appendChild(el('p', 'text-sm leading-relaxed text-slate-700', item.explanation));

  const next = el('button',
    'mt-4 w-full bg-primary hover:bg-primary-dark text-white font-bold py-3 rounded-xl transition-colors',
    index + 1 < set.items.length ? '다음 문제' : '결과 보기');
  next.addEventListener('click', advance);
  feedback.appendChild(next);
  feedback.classList.remove('hidden');
  next.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  logEvent('assessment_answer', {
    item_id: item.id, type: item.type, picked, correct, ms: elapsed,
    week, session,
  });
  await logAssessment({
    week, session, itemId: item.id, itemType: item.type,
    picked, correct, msToAnswer: elapsed,
  });
}

function advance() {
  index += 1;
  if (index < set.items.length) {
    renderItem();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    askReflection();
  }
}

/**
 * 되돌아보기는 형성평가가 끝난 뒤에 묻는다.
 *
 * 예전에는 레슨마다 제출할 때 물었다(16개 중 12개). 제출 버튼을 누른 순간은
 * 학생이 넘어가고 싶은 순간이라 '몰라요'가 돌아왔고, 그건 데이터가 아니라
 * 잡음이다. 방금 무엇을 틀렸는지 본 직후가 쓸 거리가 가장 많은 자리다.
 */
function askReflection() {
  if (!set.reflection) {
    finish();
    return;
  }
  document.getElementById('item').classList.add('hidden');
  renderSteps(true);
  document.getElementById('reflect-prompt').textContent = set.reflection;
  document.getElementById('reflect').classList.remove('hidden');
  document.getElementById('reflect-answer').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  logEvent('reflection_shown', { week, session });
}

async function submitReflection(skipped) {
  const answer = document.getElementById('reflect-answer').value.trim();
  document.getElementById('reflect').classList.add('hidden');

  logEvent('reflection_submit', {
    week, session, chars: answer.length, skipped: skipped || !answer,
  });
  if (answer) {
    await logReflection({ week, session, prompt: set.reflection, answer });
  }
  finish();
}

/* ===================== 마무리 ===================== */

function finish() {
  document.getElementById('item').classList.add('hidden');
  renderSteps(true);
  const score = results.filter((r) => r.correct).length;

  document.getElementById('done-score').textContent =
    `${set.items.length}문제 중 ${score}개 맞았어`;

  const review = document.getElementById('done-review');
  review.innerHTML = '';
  for (const { item, correct } of results) {
    const row = el('div',
      `flex items-start gap-3 rounded-xl px-4 py-3 border `
      + (correct ? 'bg-white border-slate-200' : 'bg-secondary-soft border-secondary/25'));
    row.appendChild(el('span',
      `material-icons-round text-base shrink-0 mt-0.5 ${correct ? 'text-accent-green' : 'text-secondary'}`,
      correct ? 'check' : 'priority_high'));
    const body = el('div', 'min-w-0');
    body.appendChild(el('p', 'text-[11px] font-bold text-slate-500', item.type));
    body.appendChild(el('p', 'text-sm font-medium leading-snug', item.question));
    row.appendChild(body);
    review.appendChild(row);
  }

  updateQuizProgress(week, session, { score, total: set.items.length });
  document.getElementById('done').classList.remove('hidden');
  logEvent('assessment_complete', {
    week, session, score, total: set.items.length,
  });
  flush();
}

/* ===================== 초기화 ===================== */

document.getElementById('quiz-meta').textContent = `${week}주 ${session}차시`;
document.getElementById('intro-meta').textContent =
  `${week}주차 ${session}차시 · ${set.items.length}문제`;
document.getElementById('quiz-title').textContent = `형성평가 · ${set.title}`;
document.getElementById('participant-chip').textContent = participant.code;

document.getElementById('btn-start').addEventListener('click', () => {
  document.getElementById('intro').classList.add('hidden');
  logEvent('assessment_start', { week, session, items: set.items.length });
  renderItem();
});

document.getElementById('reflect-skip').addEventListener('click', () => submitReflection(true));
document.getElementById('reflect-submit').addEventListener('click', () => submitReflection(false));

renderTrack();
const intro = document.getElementById('intro');
intro.classList.remove('hidden');
// 클래스를 붙이는 순간 트랙이 차오르기 시작한다. 화면이 그려진 다음에 붙인다.
requestAnimationFrame(() => intro.classList.add('track-play'));

document.body.classList.add('ready');
