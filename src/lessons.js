import './style.css';
import lessons from '../data/lessons.json';
import { getParticipant, clearParticipant } from './lib/session.js';
import {
  getAllProgress, statusOf, getProgress, getQuizProgress,
} from './lib/progress.js';
import assessments from '../data/assessments.json';
import { logEvent, flush } from './lib/logger.js';

const participant = getParticipant();
if (!participant) window.location.replace('/');

const STATUS = {
  submitted: { label: '제출함',    chip: 'bg-primary/10 text-primary',   mark: 'fill' },
  passed:    { label: '목표 달성',  chip: 'bg-primary-soft text-primary', mark: 'check' },
  started:   { label: '해보는 중',  chip: 'bg-slate-100 text-slate-500',  mark: 'half' },
  todo:      { label: '',          chip: '',                             mark: 'empty' },
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** 상태 표시. 색을 하나만 써서 어디까지 했는지가 채움 여부로 읽히게 한다. */
function statusMark(mark) {
  const box = document.createElement('span');
  box.className = 'shrink-0 w-[18px] h-[18px] grid place-items-center';
  if (mark === 'fill' || mark === 'check') {
    box.innerHTML = mark === 'fill'
      ? '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="9" '
        + 'fill="#6366f1"/><path d="M6 10.3l2.8 2.8L14.3 7" stroke="#fff" stroke-width="2" '
        + 'fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="8.4" '
        + 'fill="none" stroke="#6366f1" stroke-width="1.8"/><path d="M6 10.3l2.8 2.8L14.3 7" '
        + 'stroke="#6366f1" stroke-width="2" fill="none" stroke-linecap="round" '
        + 'stroke-linejoin="round"/></svg>';
  } else if (mark === 'half') {
    box.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" '
      + 'r="8.4" fill="none" stroke="#cbd5e1" stroke-width="1.8"/><circle cx="10" cy="10" '
      + 'r="3.6" fill="#94a3b8"/></svg>';
  } else {
    box.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" '
      + 'r="8.4" fill="none" stroke="#e2e8f0" stroke-width="1.8"/></svg>';
  }
  return box;
}

/** 오른쪽 끝에 세로로 줄 맞는 지표. 빈 자리를 이걸로 채운다. */
function statBlock(value, label) {
  const box = el('div', 'text-right min-w-[46px]');
  box.appendChild(el('div', 'font-code text-sm font-medium leading-tight text-slate-700',
    String(value)));
  box.appendChild(el('div', 'text-[10.5px] text-slate-400', label));
  return box;
}

function metaGroup(children) {
  const box = el('div', 'ml-auto flex items-center gap-5 shrink-0');
  for (const child of children) if (child) box.appendChild(child);
  return box;
}

const divider = () => el('span', 'w-px h-7 bg-slate-200 shrink-0');

const chevron = () => {
  const span = el('span', 'material-icons-round text-slate-300 shrink-0 '
    + 'group-hover:text-primary transition', 'chevron_right');
  return span;
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

function lessonCard(lesson, index) {
  const status = statusOf(lesson.id);
  const style = STATUS[status];
  const p = getProgress(lesson.id);

  const card = el('a',
    'group flex items-center gap-4 bg-white rounded-xl border px-5 py-3.5 transition '
    + (status === 'todo'
      ? 'border-slate-200 hover:border-primary'
      : 'border-primary/25 hover:border-primary'));
  card.href = `/lesson.html?id=${lesson.id}`;

  card.appendChild(statusMark(style.mark));
  card.appendChild(el('span', 'font-code text-[11px] text-slate-400 shrink-0',
    String(index + 1).padStart(2, '0')));

  // 제목과 부제를 떼어 놓는다. 붙어 있으면 한 덩어리로 읽힌다.
  const body = el('div', 'min-w-0 flex flex-col gap-1');
  body.appendChild(el('span', 'font-bold text-[15px] leading-tight', lesson.title));
  body.appendChild(el('span', 'text-[13px] leading-tight text-slate-500 truncate',
    lesson.subtitle));
  card.appendChild(body);

  const stats = [];
  if (p.runs) stats.push(statBlock(p.runs, '실행'));
  if (p.hints) stats.push(statBlock(p.hints, '힌트'));
  if (p.seconds) {
    stats.push(statBlock(`${Math.max(1, Math.round(p.seconds / 60))}분`, '걸림'));
  }
  if (stats.length) stats.push(divider());
  if (style.label) {
    stats.push(el('span',
      `text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap ${style.chip}`,
      style.label));
  }
  stats.push(chevron());
  card.appendChild(metaGroup(stats));
  return card;
}

/**
 * 형성평가. 레슨과 종류가 달라서 초록으로 구분한다.
 * 그 차시 레슨을 하나도 안 했으면 잠근다 — 배우기 전에 풀면 사전검사가 된다.
 */
function quizCard(week, session, items) {
  const set = assessments.find((a) => a.week === week && a.session === session);
  if (!set) return null;

  const result = getQuizProgress(week, session);
  const open = items.some(({ lesson }) => statusOf(lesson.id) !== 'todo');

  const card = el(open ? 'a' : 'div',
    'group flex items-center gap-4 rounded-xl border px-5 py-3.5 transition '
    + (open
      ? 'bg-green-50/50 border-accent-green/45 hover:border-accent-green'
      : 'border-dashed border-green-200'));
  if (open) card.href = `/quiz.html?week=${week}&session=${session}`;

  const star = el('span', 'shrink-0 w-[18px] h-[18px] grid place-items-center');
  star.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none">'
    + '<path d="M10 2.5l2.2 4.6 5 .7-3.6 3.5.9 5L10 13.9 5.5 16.3l.9-5L2.8 7.8l5-.7z" '
    + `stroke="${open ? '#22c55e' : '#bbf7d0'}" stroke-width="1.7" `
    + `fill="${result ? '#22c55e' : 'none'}" stroke-linejoin="round"/></svg>`;
  card.appendChild(star);

  const body = el('div', 'min-w-0 flex flex-col gap-1');
  body.appendChild(el('span',
    `font-bold text-[15px] leading-tight ${open ? 'text-green-900' : 'text-slate-400'}`,
    `형성평가 · ${set.title}`));
  body.appendChild(el('span',
    `text-[13px] leading-tight truncate ${open ? 'text-green-800/70' : 'text-slate-400'}`,
    open
      ? `회로 이해 · 결과 예측 · 오류 수정 ${set.items.length}문제`
      : '이 차시 레슨을 하나라도 해 보면 열려'));
  card.appendChild(body);

  const stats = [];
  if (result) {
    stats.push(statBlock(`${result.score}/${result.total}`, '맞음'));
    stats.push(divider());
    stats.push(el('span',
      'text-[11px] font-bold px-2.5 py-1 rounded-full bg-green-100 text-green-700', '완료'));
  } else if (open) {
    stats.push(el('span',
      'text-[13px] font-bold text-white bg-accent-green px-4 py-2 rounded-lg', '풀어보기'));
  } else {
    stats.push(el('span', 'material-icons-round text-green-200 text-lg shrink-0', 'lock'));
  }
  if (open) stats.push(chevron());
  card.appendChild(metaGroup(stats));
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
