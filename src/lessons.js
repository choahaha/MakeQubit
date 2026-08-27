import './style.css';
import lessons from '../data/lessons.json';
import { getParticipant, clearParticipant } from './lib/session.js';
import { getAllProgress, statusOf, getQuizProgress } from './lib/progress.js';
import assessments from '../data/assessments.json';
import { logEvent, flush } from './lib/logger.js';

const participant = getParticipant();
if (!participant) window.location.replace('/');

const STATUS = {
  submitted: {
    label: '제출함',
    chip: 'bg-primary/10 text-primary',
    ring: 'border-primary/30',
    icon: 'task_alt',
    iconColor: 'text-primary',
  },
  passed: {
    label: '목표 달성',
    chip: 'bg-green-100 text-green-700',
    ring: 'border-green-300',
    icon: 'check_circle',
    iconColor: 'text-accent-green',
  },
  started: {
    label: '해보는 중',
    chip: 'bg-amber-100 text-amber-700',
    ring: 'border-amber-300',
    icon: 'pending',
    iconColor: 'text-amber-500',
  },
  todo: {
    label: '',
    chip: '',
    ring: 'border-slate-200',
    icon: 'radio_button_unchecked',
    iconColor: 'text-slate-300',
  },
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/* ===================== 전체 진행 ===================== */

function renderProgress() {
  const counts = { submitted: 0, passed: 0, started: 0, todo: 0 };
  for (const lesson of lessons) counts[statusOf(lesson.id)] += 1;

  const total = lessons.length;
  const width = (n) => `${(n / total) * 100}%`;
  document.getElementById('progress-submitted').style.width = width(counts.submitted);
  document.getElementById('progress-passed').style.width = width(counts.passed);
  document.getElementById('progress-started').style.width = width(counts.started);

  const done = counts.submitted + counts.passed;
  document.getElementById('progress-label').textContent = `${done} / ${total}`;
  return counts;
}

/* ===================== 이어서 하기 ===================== */

function renderResume() {
  const progress = getAllProgress();
  // 아직 제출하지 않은 것 중 가장 앞. 손댄 적 있는 레슨을 우선한다.
  const touched = lessons.find((l) => {
    const s = statusOf(l.id);
    return s === 'started' || s === 'passed';
  });
  const next = touched || lessons.find((l) => statusOf(l.id) === 'todo');
  if (!next) return;

  const box = document.getElementById('resume');
  document.getElementById('resume-meta').textContent =
    `${next.week}주차 ${next.session}차시 · ${progress[next.id] ? '이어서' : '처음부터'}`;
  document.getElementById('resume-title').textContent = next.title;
  document.getElementById('resume-sub').textContent = next.subtitle;
  document.getElementById('resume-link').href = `/lesson.html?id=${next.id}`;
  box.classList.remove('hidden');
}

/* ===================== 차시별 목록 ===================== */

function renderSessions() {
  const host = document.getElementById('sessions');
  host.innerHTML = '';

  const groups = new Map();
  lessons.forEach((lesson, index) => {
    const key = `${lesson.week}-${lesson.session}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ lesson, index });
  });

  for (const [key, items] of groups) {
    const [week, session] = key.split('-');
    const block = el('section');

    const header = el('div', 'flex items-baseline gap-3 mb-3 pb-2 border-b border-slate-200');
    header.appendChild(el('h2', 'font-extrabold text-lg', `${week}주차 ${session}차시`));
    header.appendChild(el('span', 'text-xs text-slate-500', `레슨 ${items.length}개 · 50분`));

    const done = items.filter(({ lesson }) => statusOf(lesson.id) !== 'todo').length;
    if (done) {
      header.appendChild(el('span', 'ml-auto text-xs font-mono text-slate-500',
        `${done}/${items.length}`));
    }
    block.appendChild(header);

    const list = el('div', 'space-y-2');
    for (const { lesson, index } of items) {
      list.appendChild(lessonCard(lesson, index));
    }

    // 차시 끝의 형성평가. 그 차시 레슨을 하나도 안 했으면 잠가 둔다 —
    // 배우기 전에 풀면 형성평가가 아니라 사전검사가 된다.
    const quiz = quizCard(Number(week), Number(session), items);
    if (quiz) list.appendChild(quiz);

    block.appendChild(list);
    host.appendChild(block);
  }
}

function quizCard(week, session, items) {
  const set = assessments.find((a) => a.week === week && a.session === session);
  if (!set) return null;

  const result = getQuizProgress(week, session);
  const started = items.some(({ lesson }) => statusOf(lesson.id) !== 'todo');
  const href = `/quiz.html?week=${week}&session=${session}`;

  const card = el('a', 'flex items-center gap-4 rounded-xl border px-4 py-3.5 transition group '
    + (result
      ? 'bg-white border-green-300 hover:border-primary'
      : started
        ? 'bg-primary-soft border-primary/30 hover:border-primary'
        : 'bg-slate-50 border-dashed border-slate-300'));

  if (started) card.href = href;

  const icon = el('span',
    `material-icons-round shrink-0 ${
      result ? 'text-accent-green' : started ? 'text-primary' : 'text-slate-300'}`,
    result ? 'task_alt' : 'quiz');
  card.appendChild(icon);

  const body = el('div', 'min-w-0 flex-1');
  const titleRow = el('div', 'flex items-baseline gap-2 flex-wrap');
  titleRow.appendChild(el('span', 'font-bold', `형성평가 · ${set.title}`));
  if (result) {
    titleRow.appendChild(el('span',
      'text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700',
      `${result.score}/${result.total}`));
  }
  body.appendChild(titleRow);
  body.appendChild(el('p', 'text-sm text-slate-500',
    started
      ? `회로 이해 · 결과 예측 · 오류 수정 ${set.items.length}문제`
      : '이 차시 레슨을 하나라도 해 보면 열려'));
  card.appendChild(body);

  if (started) {
    card.appendChild(el('span',
      'material-icons-round text-slate-300 group-hover:text-primary transition shrink-0',
      'chevron_right'));
  } else {
    card.appendChild(el('span', 'material-icons-round text-slate-300 shrink-0', 'lock'));
  }
  return card;
}

function lessonCard(lesson, index) {
  const status = statusOf(lesson.id);
  const style = STATUS[status];

  const card = el('a', `flex items-center gap-4 bg-white rounded-xl border ${style.ring} `
    + 'px-4 py-3.5 hover:border-primary hover:shadow-sm transition group');
  card.href = `/lesson.html?id=${lesson.id}`;

  const icon = el('span', `material-icons-round ${style.iconColor} shrink-0`, style.icon);
  card.appendChild(icon);

  const body = el('div', 'min-w-0 flex-1');
  const titleRow = el('div', 'flex items-baseline gap-2 flex-wrap');
  titleRow.appendChild(el('span', 'text-[11px] font-mono text-slate-500',
    String(index + 1).padStart(2, '0')));
  titleRow.appendChild(el('span', 'font-bold', lesson.title));
  if (style.label) {
    titleRow.appendChild(el('span',
      `text-[10px] font-bold px-1.5 py-0.5 rounded-full ${style.chip}`, style.label));
  }
  body.appendChild(titleRow);
  body.appendChild(el('p', 'text-sm text-slate-500 truncate', lesson.subtitle));
  card.appendChild(body);

  card.appendChild(el('span',
    'material-icons-round text-slate-300 group-hover:text-primary transition shrink-0',
    'chevron_right'));
  return card;
}

/* ===================== 초기화 ===================== */

document.getElementById('participant-chip').textContent = participant.code;
if (participant.isTest) {
  const chip = document.getElementById('participant-chip');
  chip.textContent = `${participant.code} · ${participant.purpose || '테스트'}`;
  chip.className = 'text-xs font-mono bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full';
}

document.getElementById('btn-exit').addEventListener('click', async () => {
  logEvent('session_exit', {});
  await flush();
  clearParticipant();
  window.location.href = '/';
});

const counts = renderProgress();
renderResume();
renderSessions();
logEvent('index_open', { ...counts });

document.body.classList.add('ready');
