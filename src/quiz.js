import './style.css';
import assessments from '../data/assessments.json';
import { getParticipant } from './lib/session.js';
import { logEvent, logAssessment, flush } from './lib/logger.js';
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

/* ===================== 문항 ===================== */

function renderItem() {
  const item = set.items[index];
  answered = false;
  shownAt = Date.now();

  document.getElementById('quiz-progress').textContent =
    `${index + 1} / ${set.items.length}`;

  const host = document.getElementById('item');
  host.innerHTML = '';
  host.classList.remove('hidden');

  host.appendChild(el('span',
    `inline-block text-[11px] font-bold px-2 py-1 rounded-full ${TYPE_STYLE[item.type] || 'bg-slate-100 text-slate-600'}`,
    item.type));

  host.appendChild(el('h2', 'mt-3 text-xl font-bold leading-snug', item.question));

  if (item.code) {
    const pre = el('pre',
      'mt-4 bg-white border border-slate-200 rounded-xl px-4 py-3 overflow-x-auto '
      + 'text-[13px] leading-relaxed font-code text-slate-800');
    pre.textContent = item.code;
    host.appendChild(pre);
  }

  const list = el('div', 'mt-5 space-y-2');
  item.choices.forEach((choice, i) => {
    const button = el('button',
      'w-full text-left bg-white border border-slate-200 rounded-xl px-4 py-3.5 '
      + 'hover:border-primary hover:bg-primary-soft/40 transition flex items-start gap-3');
    button.dataset.choice = String(i);
    button.appendChild(el('span',
      'w-6 h-6 rounded-full border border-slate-300 text-[11px] font-bold '
      + 'flex items-center justify-center shrink-0 mt-0.5', String(i + 1)));
    button.appendChild(el('span', 'text-sm leading-relaxed', choice));
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
    finish();
  }
}

/* ===================== 마무리 ===================== */

function finish() {
  document.getElementById('item').classList.add('hidden');
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
document.getElementById('quiz-title').textContent = `형성평가 · ${set.title}`;
document.getElementById('intro-title').textContent = `${week}주차 ${session}차시 형성평가`;
document.getElementById('participant-chip').textContent = participant.code;

document.getElementById('btn-start').addEventListener('click', () => {
  document.getElementById('intro').classList.add('hidden');
  logEvent('assessment_start', { week, session, items: set.items.length });
  renderItem();
});

document.getElementById('intro').classList.remove('hidden');
document.body.classList.add('ready');
