import './style.css';
import lessons from '../data/lessons.json';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const TOKEN_KEY = 'makequbit.admin';

let token = sessionStorage.getItem(TOKEN_KEY) || '';
let overview = null;

const LESSON_TITLE = Object.fromEntries(lessons.map((l) => [l.id, l.title]));
const LESSON_ORDER = lessons.map((l) => l.id);

/* ===================== 서버 ===================== */

async function api(path) {
  const response = await fetch(`${API_URL}/api/admin${path}`, {
    headers: { 'X-Admin-Token': token },
  });
  if (!response.ok) {
    let message = `서버 오류 (${response.status})`;
    try {
      const body = await response.json();
      if (body.detail) message = body.detail;
    } catch { /* 본문이 JSON이 아니면 기본 메시지 */ }
    throw new Error(message);
  }
  return response.json();
}

/* ===================== 유틸 ===================== */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

function shortLesson(id) {
  // 격자 머리글은 좁아야 한 화면에 들어간다. id를 파싱하지 않고 순서를
  // 쓴다 — 레슨을 재배치해도 번호가 어긋나지 않는다.
  const index = LESSON_ORDER.indexOf(id);
  return index >= 0 ? `L${String(index + 1).padStart(2, '0')}` : id;
}

/** 격자 머리글 위에 주차·차시 구분선을 넣기 위한 정보 */
const LESSON_META = Object.fromEntries(
  lessons.map((l) => [l.id, { week: l.week, session: l.session }]));

/** 가로 막대 하나. 차트 라이브러리를 들이지 않는다 — 이 정도면 충분하다. */
function bar(label, count, max, color = 'bg-primary') {
  const row = el('div', 'flex items-center gap-3');
  row.appendChild(el('span', 'w-44 shrink-0 text-xs font-code text-slate-600 truncate', label));
  const track = el('div', 'flex-1 h-4 bg-slate-100 rounded overflow-hidden');
  const fill = el('div', `h-full ${color} rounded`);
  fill.style.width = `${max ? (count / max) * 100 : 0}%`;
  track.appendChild(fill);
  row.appendChild(track);
  row.appendChild(el('span', 'w-10 text-right text-xs font-code text-slate-500', count));
  return row;
}

/* ===================== 요약 카드 ===================== */

function renderTotals(totals) {
  const host = document.getElementById('totals');
  host.innerHTML = '';
  const errorRate = pct(totals.failed_runs, totals.runs);
  const cards = [
    ['참여자', `${totals.active} / ${totals.participants}`, '활동 / 명부'],
    ['총 실행', totals.runs, ''],
    ['실패한 실행', `${totals.failed_runs}`, `${errorRate}%`],
    ['제출', totals.submissions, ''],
    ['미시작', totals.participants - totals.active, '한 번도 실행 안 함'],
  ];
  for (const [label, value, note] of cards) {
    const card = el('div', 'bg-white rounded-xl border border-slate-200 px-4 py-3');
    card.appendChild(el('p', 'text-[11px] font-bold uppercase tracking-wider text-slate-500', label));
    card.appendChild(el('p', 'text-2xl font-extrabold mt-0.5 font-code', String(value)));
    if (note) card.appendChild(el('p', 'text-[11px] text-slate-500', note));
    host.appendChild(card);
  }
}

/* ===================== 참여자 × 레슨 격자 ===================== */

function renderGrid(data) {
  const host = document.getElementById('grid');
  host.innerHTML = '';

  const table = el('table', 'text-sm border-separate border-spacing-1');
  const head = el('tr');
  head.appendChild(el('th', 'text-left text-[11px] font-bold uppercase tracking-wider text-slate-500 pr-3', '참여자'));
  for (const id of LESSON_ORDER) {
    const meta = LESSON_META[id];
    const th = el('th', 'text-[11px] font-bold text-slate-500 w-12 align-bottom');
    if (meta) {
      th.appendChild(el('div', 'text-[9px] font-normal text-slate-400',
        `${meta.week}-${meta.session}`));
    }
    th.appendChild(el('div', '', shortLesson(id)));
    th.title = LESSON_TITLE[id] || id;
    head.appendChild(th);
  }
  table.appendChild(head);

  for (const participant of data.participants) {
    const row = el('tr');
    const name = el('td', 'pr-3');
    const button = el('button',
      'font-code text-sm font-bold text-slate-700 hover:text-primary transition', participant.code);
    button.addEventListener('click', () => openParticipant(participant.code));
    name.appendChild(button);
    row.appendChild(name);

    for (const id of LESSON_ORDER) {
      const cell = data.grid[`${participant.code}|${id}`];
      const td = el('td');
      const box = el('div',
        'relative w-12 h-9 rounded-md border flex items-center justify-center text-xs font-code');

      if (!cell || !cell.runs) {
        box.className += ' bg-slate-100 border-slate-200 text-slate-300';
        box.textContent = '·';
      } else {
        box.className += cell.cleared
          ? ' bg-green-50 border-green-400 text-green-800'
          : ' bg-amber-50 border-amber-300 text-amber-800';
        box.textContent = cell.runs;
        box.title =
          `${participant.code} · ${LESSON_TITLE[id] || id}\n`
          + `실행 ${cell.runs}회 (실패 ${cell.failed})\n`
          + `첫 성공: ${cell.first_success_run ?? '없음'}번째\n`
          + `힌트 ${cell.hints}개 · 제출 ${cell.submitted}회`;

        if (cell.submitted) {
          box.appendChild(el('i', 'absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-primary'));
        }
        if (cell.hints) {
          box.appendChild(el('i', 'absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-secondary'));
        }
      }
      td.appendChild(box);
      row.appendChild(td);
    }
    table.appendChild(row);
  }
  host.appendChild(table);
}

/* ===================== 레슨별 요약 ===================== */

function renderLessonTable(data) {
  const table = document.getElementById('lesson-table');
  table.innerHTML = '';

  const columns = ['레슨', '참여', '실행', '실패율', '첫 성공', '힌트 쓴 사람', '제출', '통과', '평균 시간'];
  const head = el('tr', 'border-b border-slate-200');
  for (const [i, c] of columns.entries()) {
    const th = el('th',
      `text-[11px] font-bold uppercase tracking-wider text-slate-500 pb-2 ${i ? 'text-right px-2' : 'text-left'}`,
      c);
    head.appendChild(th);
  }
  table.appendChild(head);

  const ordered = LESSON_ORDER
    .map((id) => data.lessons.find((l) => l.lesson_id === id))
    .filter(Boolean);

  for (const lesson of ordered) {
    const row = el('tr', 'border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition');
    row.addEventListener('click', () => openLesson(lesson.lesson_id));

    const name = el('td', 'py-2.5');
    name.appendChild(el('span', 'font-bold', LESSON_TITLE[lesson.lesson_id] || lesson.lesson_id));
    const meta = LESSON_META[lesson.lesson_id];
    name.appendChild(el('span', 'ml-2 text-[11px] font-code text-slate-500',
      meta ? `${shortLesson(lesson.lesson_id)} · ${meta.week}주 ${meta.session}차시`
           : shortLesson(lesson.lesson_id)));
    row.appendChild(name);

    const failRate = pct(lesson.failed, lesson.runs);
    const values = [
      `${lesson.participants}명`,
      lesson.runs,
      `${failRate}%`,
      lesson.avg_first_success != null ? `${lesson.avg_first_success}번째` : '—',
      `${lesson.hint_users}명`,
      `${lesson.submitted}명`,
      `${lesson.passed}명`,
      lesson.avg_seconds != null ? `${Math.round(lesson.avg_seconds / 60)}분` : '—',
    ];
    for (const value of values) {
      row.appendChild(el('td', 'text-right px-2 font-code text-slate-600', String(value)));
    }
    table.appendChild(row);
  }
}

/* ===================== 드릴다운 ===================== */

function openPanel(title) {
  document.getElementById('panel-title').textContent = title;
  const body = document.getElementById('panel-body');
  body.innerHTML = '';
  body.appendChild(el('p', 'text-sm text-slate-500', '불러오는 중…'));
  document.getElementById('panel').classList.remove('hidden');
  return body;
}

function closePanel() {
  document.getElementById('panel').classList.add('hidden');
}

function section(title, note) {
  const box = el('section', 'bg-white rounded-xl border border-slate-200 p-4');
  box.appendChild(el('h3', 'text-xs font-bold uppercase tracking-wider text-slate-500 mb-3', title));
  if (note) box.appendChild(el('p', 'text-[11px] text-slate-500 -mt-2 mb-3', note));
  return box;
}

async function openLesson(lessonId) {
  const body = openPanel(LESSON_TITLE[lessonId] || lessonId);
  let data;
  try {
    data = await api(`/lesson/${encodeURIComponent(lessonId)}`);
  } catch (error) {
    body.innerHTML = '';
    body.appendChild(el('p', 'text-sm text-accent-red', error.message));
    return;
  }
  body.innerHTML = '';

  if (!data.runs) {
    body.appendChild(el('p', 'text-sm text-slate-500', '아직 실행 기록이 없어요.'));
    return;
  }

  const errors = section('오류 유형', '무엇이 학생을 막았는가');
  const maxError = Math.max(...data.error_types.map((e) => e.count), 1);
  if (data.error_types.length) {
    for (const e of data.error_types) {
      errors.appendChild(bar(e.type, e.count, maxError, 'bg-accent-red'));
    }
  } else {
    errors.appendChild(el('p', 'text-sm text-slate-500', '실행 오류가 한 번도 없었어요.'));
  }
  body.appendChild(errors);

  const shapes = section('회로 형태', '학생들이 실제로 만든 게이트 순서. 개념 오류가 여기서 보인다');
  const maxShape = Math.max(...data.circuit_shapes.map((s) => s.count), 1);
  for (const s of data.circuit_shapes) {
    shapes.appendChild(bar(s.shape, s.count, maxShape));
  }
  if (!data.circuit_shapes.length) {
    shapes.appendChild(el('p', 'text-sm text-slate-500', '회로 구조가 기록된 실행이 없어요.'));
  }
  body.appendChild(shapes);

  if (data.cx_direction.length) {
    const cx = section('CNOT 방향', '조종→표적. 뒤집힌 방향이 섞여 있으면 개념 오류다');
    const maxCx = Math.max(...data.cx_direction.map((d) => d.count), 1);
    for (const d of data.cx_direction) {
      cx.appendChild(bar(`큐비트 ${d.direction}`, d.count, maxCx, 'bg-secondary'));
    }
    body.appendChild(cx);
  }

  const dist = section('실행 횟수 분포', '몇 번 만에 끝냈는가');
  const maxDist = Math.max(...data.run_distribution.map(([, n]) => n), 1);
  for (const [runs, students] of data.run_distribution) {
    dist.appendChild(bar(`${runs}회 실행`, students, maxDist, 'bg-accent-green'));
  }
  body.appendChild(dist);
}

async function openParticipant(code) {
  const body = openPanel(`${code} 궤적`);
  let data;
  try {
    data = await api(`/participant/${encodeURIComponent(code)}`);
  } catch (error) {
    body.innerHTML = '';
    body.appendChild(el('p', 'text-sm text-accent-red', error.message));
    return;
  }
  body.innerHTML = '';

  // 실행과 이벤트를 시간순으로 하나의 흐름으로 합친다.
  // 따로 보면 '힌트를 열고 나서 고쳤는지'가 안 보인다.
  const timeline = [
    ...data.runs.map((r) => ({ kind: 'run', at: r.created_at, data: r })),
    ...data.events.map((e) => ({ kind: 'event', at: e.client_ts, data: e })),
    ...data.submissions.map((s) => ({ kind: 'submission', at: s.created_at, data: s })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  if (!timeline.length) {
    body.appendChild(el('p', 'text-sm text-slate-500', '아직 기록이 없어요.'));
    return;
  }

  let lastLesson = null;
  for (const item of timeline) {
    const lessonId = item.data.lesson_id;
    if (lessonId && lessonId !== lastLesson) {
      lastLesson = lessonId;
      const header = el('h3', 'text-sm font-bold pt-3 flex items-center gap-2');
      header.appendChild(el('span', 'w-1.5 h-1.5 rounded-full bg-slate-800'));
      header.appendChild(el('span', '', LESSON_TITLE[lessonId] || lessonId));
      body.appendChild(header);
    }
    body.appendChild(renderTimelineItem(item));
  }
}

const EVENT_LABEL = {
  hint_open: ['힌트 열람', 'text-secondary'],
  paste: ['붙여넣기', 'text-accent-amber'],
  reset_code: ['처음 코드로 되돌림', 'text-slate-500'],
  lesson_open: ['레슨 시작', 'text-slate-500'],
  lesson_leave: ['레슨 이탈', 'text-slate-500'],
  solution_viewed: ['해설 확인', 'text-primary'],
  answer_submitted: ['제출', 'text-primary'],
};

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false });
}

function renderTimelineItem({ kind, at, data }) {
  if (kind === 'event') {
    const [label, color] = EVENT_LABEL[data.event_type] || [data.event_type, 'text-slate-500'];
    const row = el('div', 'flex items-baseline gap-3 pl-4 text-xs');
    row.appendChild(el('span', 'font-code text-slate-500 w-16 shrink-0', timeOf(at)));
    row.appendChild(el('span', `font-bold ${color}`, label));
    if (data.event_type === 'hint_open') {
      row.appendChild(el('span', 'text-slate-500', `${data.payload.hint_index}번째`));
    }
    if (data.event_type === 'paste') {
      const preview = el('code', 'text-slate-600 font-code truncate max-w-md',
        `${data.payload.pasted_chars}자 · ${(data.payload.preview || '').slice(0, 60)}`);
      row.appendChild(preview);
    }
    return row;
  }

  if (kind === 'submission') {
    const box = el('div', 'ml-4 rounded-xl border border-primary/30 bg-primary-soft p-3');
    const head = el('div', 'flex items-baseline gap-3 mb-2');
    head.appendChild(el('span', 'font-code text-xs text-slate-500 w-16 shrink-0', timeOf(at)));
    head.appendChild(el('span', 'text-xs font-bold text-primary',
      `제출 #${data.submission_index} · ${data.passed ? '목표 달성' : '미달성'}`));
    head.appendChild(el('span', 'text-[11px] text-slate-500',
      `실행 ${data.runs}회 · 힌트 ${data.hints_shown}개 · ${Math.round((data.seconds_on_lesson || 0) / 60)}분`));
    box.appendChild(head);
    if (data.answer) {
      box.appendChild(el('p', 'text-sm leading-relaxed text-slate-700 whitespace-pre-wrap', data.answer));
    } else {
      box.appendChild(el('p', 'text-xs text-slate-500', '설명 없이 제출'));
    }
    return box;
  }

  const ok = data.status === 'success';
  const box = el('div', `ml-4 rounded-xl border p-3 ${ok ? 'border-slate-200 bg-white' : 'border-red-200 bg-red-50'}`);
  const head = el('div', 'flex items-baseline gap-3 mb-2');
  head.appendChild(el('span', 'font-code text-xs text-slate-500 w-16 shrink-0', timeOf(at)));
  head.appendChild(el('span', `text-xs font-bold ${ok ? 'text-slate-700' : 'text-accent-red'}`,
    `실행 ${data.run_index}회차 · ${ok ? '성공' : data.error_type}`));
  if (data.execution_time_ms != null) {
    head.appendChild(el('span', 'text-[11px] font-code text-slate-500', `${data.execution_time_ms}ms`));
  }
  box.appendChild(head);

  if (!ok && data.error_message) {
    const line = data.error_line ? `${data.error_line}번 줄 — ` : '';
    box.appendChild(el('p', 'text-xs text-accent-red mb-2', line + data.error_message));
  }
  if (data.counts) {
    box.appendChild(el('p', 'text-xs font-code text-slate-600 mb-2', JSON.stringify(data.counts)));
  }

  const details = el('details', 'group');
  details.appendChild(el('summary', 'text-[11px] text-slate-500 cursor-pointer hover:text-primary', '코드 보기'));
  const pre = el('pre', 'mt-2 text-[11.5px] leading-relaxed font-code bg-slate-50 rounded-lg p-3 overflow-x-auto whitespace-pre');
  pre.textContent = data.code;
  details.appendChild(pre);
  box.appendChild(details);
  return box;
}

/* ===================== 부팅 ===================== */

async function load() {
  const dash = document.getElementById('dash');
  try {
    overview = await api('/overview');
  } catch (error) {
    showGateError(error.message);
    return false;
  }
  renderTotals(overview.totals);
  renderGrid(overview);
  renderLessonTable(overview);

  document.getElementById('gate').classList.add('hidden');
  dash.classList.remove('hidden');
  for (const id of ['btn-refresh', 'btn-logout', 'scope-chip']) {
    document.getElementById(id).classList.remove('hidden');
  }
  document.getElementById('scope-chip').textContent =
    `참여자 ${overview.totals.participants}명 · 테스트 계정 제외`;
  return true;
}

function showGateError(message) {
  const error = document.getElementById('gate-error');
  error.textContent = message;
  error.classList.remove('hidden');
  document.getElementById('gate').classList.remove('hidden');
  document.getElementById('dash').classList.add('hidden');
}

document.getElementById('gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  token = document.getElementById('token').value.trim();
  document.getElementById('gate-error').classList.add('hidden');
  if (await load()) sessionStorage.setItem(TOKEN_KEY, token);
});

document.getElementById('btn-refresh').addEventListener('click', load);
document.getElementById('btn-logout').addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  window.location.reload();
});
document.getElementById('panel-close').addEventListener('click', closePanel);
document.getElementById('panel-backdrop').addEventListener('click', closePanel);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

if (token) load();
document.body.classList.add('ready');
