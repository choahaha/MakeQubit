import './style.css';
import lessons from '../data/lessons.json';
import { createEditor } from './lib/editor.js';
import { runCode } from './lib/api.js';
import { checkLesson } from './lib/check.js';
import { renderCircuitSvg } from './lib/circuit-svg.js';
import { getParticipant } from './lib/session.js';
import { logEvent, logCodeRun, logSubmission, flush, nextSeq } from './lib/logger.js';
import { getProgress, updateProgress, statusOf } from './lib/progress.js';

const EDIT_DEBOUNCE_MS = 2500;

const participant = getParticipant();
if (!participant) window.location.replace('/');

const lessonId = new URLSearchParams(window.location.search).get('id');
const lessonIndex = Math.max(0, lessons.findIndex((l) => l.id === lessonId));
const lesson = lessons[lessonIndex];

// 이동은 이 차시 안에서만 일어난다. 1차시 학생이 화살표만 눌러서 3주차까지
// 넘어가면, 아직 안 배운 내용을 만나고 수업 진도와도 어긋난다.
// 차시를 넘어가려면 목차를 거치게 한다.
const sessionLessons = lessons.filter(
  (l) => l.week === lesson.week && l.session === lesson.session);
const sessionIndex = sessionLessons.findIndex((l) => l.id === lesson.id);
const isSessionEnd = sessionIndex === sessionLessons.length - 1;

const draftKey = `makequbit.draft.${participant.code}.${lesson.id}`;
const openedAt = Date.now();

let editor;
let runIndex = 0;
let hintsShown = 0;
let lastResult = null;
let lastResultAt = null;
let editTimer = null;
// 지난 차시의 진행을 이어받는다. 이걸 안 하면 이미 통과한 레슨을 다시 열어
// 제출했을 때 passed가 false로 덮어써지고, submission_index도 1부터 다시
// 세어 같은 번호가 두 번 남는다.
const saved = getProgress(lesson.id);
let passed = saved.passed === true;
let submissionIndex = saved.submitted || 0;
let submitted = submissionIndex > 0;

/* ===================== 레슨 안내 렌더 ===================== */

function renderLessonInfo() {
  document.title = `${lesson.title} — MakeQubit`;
  document.getElementById('lesson-week').textContent =
    `${lesson.week}주 ${lesson.session}차시`;
  document.getElementById('lesson-title').textContent = lesson.title;
  document.getElementById('lesson-goal').textContent = lesson.goal;
  const chip = document.getElementById('participant-chip');
  chip.textContent = participant.code;
  if (participant.isTest) {
    // 학생이 아닌 세션임을 숨기지 않는다. 이 기록은 분석 뷰에서 빠진다.
    chip.textContent = `${participant.code} · ${participant.purpose || '테스트'}`;
    chip.className =
      'ml-2 text-xs font-mono bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full';
  }

  const conceptList = document.getElementById('lesson-concept');
  for (const line of lesson.concept) {
    const item = document.createElement('li');
    item.className = 'flex gap-2';
    item.innerHTML = `<span class="text-primary shrink-0">·</span><span></span>`;
    item.lastElementChild.textContent = line;
    conceptList.appendChild(item);
  }

  if (lesson.docs?.length) {
    document.getElementById('docs-block').classList.remove('hidden');
    const docsList = document.getElementById('docs-list');
    for (const doc of lesson.docs) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = doc.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'text-sm text-primary hover:underline flex items-center gap-1';
      link.innerHTML = `<span class="material-icons-round text-sm">open_in_new</span>`;
      link.appendChild(document.createTextNode(doc.label));
      item.appendChild(link);
      docsList.appendChild(item);
    }
  }

  updateHintButton();
}

const DOT_COLOR = {
  submitted: 'bg-primary',
  passed: 'bg-accent-green',
  started: 'bg-amber-400',
  todo: 'bg-slate-200 hover:bg-slate-300',
};

function renderProgressDots() {
  const container = document.getElementById('progress-dots');
  container.innerHTML = '';

  sessionLessons.forEach((item, index) => {
    const dot = document.createElement('a');
    dot.href = `/lesson.html?id=${item.id}`;
    dot.title = `${index + 1}번째 · ${item.title}`;
    const color = index === sessionIndex ? 'bg-primary' : DOT_COLOR[statusOf(item.id)];
    const size = index === sessionIndex ? 'w-5' : 'w-2';
    dot.className = `h-2 ${size} rounded-full transition-all ${color}`;
    container.appendChild(dot);
  });

  document.getElementById('session-position').textContent =
    `${sessionIndex + 1}/${sessionLessons.length}`;
}

/* ===================== 힌트 ===================== */

function updateHintButton() {
  const button = document.getElementById('btn-hint');
  const label = document.getElementById('hint-button-label');
  const remaining = lesson.hints.length - hintsShown;

  if (remaining <= 0) {
    button.disabled = true;
    button.className = button.className.replace(/hover:\S+/g, '') + ' opacity-40 cursor-default';
    label.textContent = '힌트를 모두 봤어';
  } else {
    label.textContent = hintsShown === 0
      ? '힌트 보기'
      : `힌트 더 보기 (${remaining}개 남음)`;
  }
}

function showNextHint() {
  if (hintsShown >= lesson.hints.length) return;
  const text = lesson.hints[hintsShown];
  hintsShown += 1;

  const card = document.createElement('div');
  card.className =
    'bg-secondary-soft border border-secondary/25 rounded-xl px-3 py-2.5 '
    + 'text-sm leading-relaxed text-slate-700';
  card.innerHTML =
    `<span class="font-bold text-xs text-secondary block mb-0.5">힌트 ${hintsShown}</span>`;
  card.appendChild(document.createTextNode(text));
  document.getElementById('hint-list').appendChild(card);

  logEvent('hint_open', { hint_index: hintsShown, run_index: runIndex }, lesson.id);
  updateHintButton();
}

/* ===================== 결과 렌더 ===================== */

const STATUS_STYLES = {
  pass:    { box: 'bg-green-50 border border-green-200 text-green-800', icon: 'check_circle' },
  success: { box: 'bg-slate-100 border border-slate-200 text-slate-600', icon: 'done' },
  // 재시도는 경고가 아니라 안내다. 힌트와 같은 하늘색 채널을 쓴다.
  retry:   { box: 'bg-secondary-soft border border-secondary/25 text-slate-700', icon: 'refresh' },
  error:   { box: 'bg-red-50 border border-red-200 text-red-800', icon: 'error_outline' },
};

function renderStatus(kind, title, detail) {
  const box = document.getElementById('result-status');
  const style = STATUS_STYLES[kind];
  box.className = `rounded-xl px-4 py-3 flex items-start gap-2.5 ${style.box}`;
  document.getElementById('result-status-icon').textContent = style.icon;
  document.getElementById('result-status-title').textContent = title;
  document.getElementById('result-status-detail').textContent = detail || '';
  box.classList.remove('hidden');
  if (kind === 'pass') {
    box.classList.add('pass-pulse');
    setTimeout(() => box.classList.remove('pass-pulse'), 900);
  }
}

function renderCounts(counts) {
  const block = document.getElementById('counts-block');
  if (!counts) {
    block.classList.add('hidden');
    return;
  }

  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  const total = entries.reduce((sum, n) => sum + n[1], 0);
  const max = Math.max(...entries.map(([, n]) => n));

  document.getElementById('counts-total').textContent = `${total} shots`;
  const chart = document.getElementById('counts-chart');
  chart.innerHTML = '';

  // Qiskit 튜토리얼의 plot_histogram과 같은 모양으로 그린다. 학생이
  // 바깥에서 본 그림과 같아야 여기서 본 것을 거기서도 읽을 수 있다.
  const columns = document.createElement('div');
  columns.className =
    'flex items-end justify-around gap-1.5 h-36 border-b border-slate-200 pb-px';

  for (const [bits, count] of entries) {
    const percent = (count / total) * 100;
    const column = document.createElement('div');
    column.className = 'flex-1 min-w-0 flex flex-col items-center justify-end h-full gap-1';
    column.title = `|${bits}⟩ · ${count}회 · ${percent.toFixed(1)}%`;

    const value = document.createElement('span');
    value.className = 'text-[10px] font-code text-slate-500 tabular-nums';
    value.textContent = `${percent.toFixed(0)}%`;
    column.appendChild(value);

    const bar = document.createElement('div');
    // max-w가 없으면 결과가 한 가지일 때 막대가 패널을 통째로 채워
    // 그래프가 아니라 색 블록처럼 보인다. 모서리는 살짝만 둥글린다 —
    // 좁은 막대에 큰 radius를 주면 캡슐이 된다.
    bar.className = 'w-full max-w-[52px] bg-primary rounded-t-[3px] bar-grow';
    // 아주 작은 값도 보이게 최소 높이를 준다. 0이 아닌데 안 보이면
    // 학생은 그 결과가 안 나온 줄 안다.
    bar.style.height = `${Math.max((count / max) * 100, 2)}%`;
    column.appendChild(bar);

    columns.appendChild(column);
  }
  chart.appendChild(columns);

  const labels = document.createElement('div');
  labels.className = 'flex justify-around gap-1.5 mt-1.5';
  for (const [bits, count] of entries) {
    const cell = document.createElement('div');
    cell.className = 'flex-1 min-w-0 text-center';
    cell.innerHTML =
      `<div class="text-[11px] font-code font-bold text-slate-700 truncate">|${bits}⟩</div>`
      + `<div class="text-[10px] font-code text-slate-400 tabular-nums">${count}</div>`;
    labels.appendChild(cell);
  }
  chart.appendChild(labels);

  block.classList.remove('hidden');
}

function renderResult(result) {
  document.getElementById('result-empty').classList.add('hidden');

  const stdoutBlock = document.getElementById('stdout-block');
  let text = (result.stdout || '').trimEnd();

  // print(qc.draw())를 쓰면 출력과 회로 블록이 같은 그림을 두 번 보여준다.
  // 회로는 아래 전용 블록이 더 잘 보여주므로 출력 쪽에서 지운다.
  if (result.circuit_text && text.includes(result.circuit_text.trimEnd())) {
    text = text.replace(result.circuit_text.trimEnd(), '').trim();
  }

  if (text) {
    document.getElementById('stdout-text').textContent =
      text + (result.stdout_truncated ? '\n… (출력이 너무 길어 잘렸어요)' : '');
    stdoutBlock.classList.remove('hidden');
  } else {
    stdoutBlock.classList.add('hidden');
  }

  const circuitBlock = document.getElementById('circuit-block');
  const circuitHost = document.getElementById('circuit-view');
  circuitHost.innerHTML = '';
  if (result.circuit_spec) {
    circuitHost.appendChild(renderCircuitSvg(result.circuit_spec));
    if (result.circuit_spec.truncated) {
      const note = document.createElement('p');
      note.className = 'mt-2 text-[11px] text-slate-500';
      note.textContent = '회로가 길어서 앞부분만 그렸어요.';
      circuitHost.appendChild(note);
    }
    circuitBlock.classList.remove('hidden');
  } else if (result.circuit_text) {
    // 구조를 못 받았을 때만 텍스트 그림으로 물러선다
    const pre = document.createElement('pre');
    pre.className = 'text-[13px] leading-[1.3] font-circuit text-slate-600';
    pre.textContent = result.circuit_text;
    circuitHost.appendChild(pre);
    circuitBlock.classList.remove('hidden');
  } else {
    circuitBlock.classList.add('hidden');
  }

  renderCounts(result.counts);
}

/* ===================== 실행 ===================== */

function setRunning(running) {
  const button = document.getElementById('btn-run');
  button.disabled = running;
  button.classList.toggle('running-stripes', running);
  document.getElementById('run-icon').textContent = running ? 'hourglass_top' : 'play_arrow';
  document.getElementById('run-label').textContent = running ? '실행 중…' : '실행하기';
}

async function run() {
  const code = editor.getCode();
  if (!code.trim()) return;

  runIndex += 1;
  const seqValue = nextSeq();
  setRunning(true);
  editor.markError(null);
  document.getElementById('run-status').textContent = '';

  updateProgress(lesson.id, { runs: runIndex });
  logEvent('run_click', {
    run_index: runIndex,
    code_chars: code.length,
    hints_shown: hintsShown,
    seconds_since_open: Math.round((Date.now() - openedAt) / 1000),
  }, lesson.id);

  const result = await runCode({
    code,
    participantId: participant.code,
    lessonId: lesson.id,
  });
  lastResult = result;
  lastResultAt = Date.now();
  setRunning(false);

  renderResult(result);
  document.getElementById('run-counter').textContent = `실행 ${runIndex}회`;
  document.getElementById('run-status').textContent =
    result.execution_time_ms != null ? `${result.execution_time_ms}ms` : '';

  if (result.status !== 'success') {
    const error = result.error || {};
    editor.markError(error.line);
    renderStatus('error', errorTitle(error), errorDetail(error));
  } else {
    const outcome = checkLesson(lesson, result);
    if (outcome.passed) {
      if (!passed) {
        passed = true;
        updateProgress(lesson.id, { passed: true });
        renderProgressDots();
      }
      renderStatus('pass', '목표 달성!', submitted
        ? '이미 제출했어. 더 고쳐서 다시 제출해도 돼.'
        : '준비되면 아래 제출하기를 눌러.');
    } else {
      renderStatus('retry', '실행은 됐어. 그런데 목표와는 조금 달라', outcome.reason);
    }
    logEvent('check_result', {
      run_index: runIndex,
      passed: outcome.passed,
      reason: outcome.reason || null,
    }, lesson.id);

    // 통과했다고 모달을 띄우지 않는다. 학생이 준비됐을 때 스스로 제출하게
    // 두면 제출 시점 자체가 데이터가 된다 — 통과하자마자 냈는지, 더 만져
    // 보고 냈는지.
  }

  logEvent('run_result', {
    run_index: runIndex,
    status: result.status,
    error_type: result.error?.type || null,
    execution_time_ms: result.execution_time_ms ?? null,
    has_counts: Boolean(result.counts),
  }, lesson.id);

  await logCodeRun({
    lessonId: lesson.id,
    runIndex,
    seqValue,
    code,
    result,
  });
}

function errorTitle(error) {
  const titles = {
    SyntaxError: '문법이 조금 어긋났어',
    NameError: '모르는 이름이 나왔어',
    ImportError: '쓸 수 없는 모듈이야',
    Timeout: '시간이 너무 오래 걸렸어',
    CpuLimit: '계산이 너무 오래 걸렸어',
    ServerError: '서버에 연결하지 못했어',
  };
  return titles[error.type] || '오류가 났어';
}

/**
 * Qiskit이 던지는 메시지는 대부분 학생이 읽을 수 없다.
 * ('No counts for experiment "0"' 같은 것) 자주 나오는 것만 옮겨 준다.
 * 못 알아본 오류는 원문을 그대로 보여준다 — 틀린 번역보다 낫다.
 */
const ERROR_HINTS = [
  // qiskit 내부에서 matplotlib을 찾다 실패하는 경로(qc.draw("mpl") 등)까지 덮는다.
  // 서버 이미지에는 matplotlib이 없다 — Figure를 브라우저로 보낼 방법이 없어서
  // 설치해 봐야 아무 일도 일어나지 않는 것처럼 보이기 때문이다.
  [/matplotlib|pylatexenc/i,
   '여기서는 그림을 직접 그리지 않아요. 실행하면 측정 결과 그래프와 회로가 오른쪽에 자동으로 나와요.'],
  [/no counts for experiment/i,
   '회로에 measure가 없어서 셀 결과가 없어요. qc.measure(...)를 넣었는지 확인해 보세요.'],
  [/not in the circuit|out of range for size|index .* out of range/i,
   '없는 큐비트 번호를 썼어요. 큐비트가 2개면 번호는 0과 1이에요.'],
  [/is not defined/i,
   '이름을 아직 만들지 않았거나 import를 빠뜨렸을 수 있어요. 위쪽 import 줄을 확인해 보세요.'],
  [/missing .* required positional argument/i,
   '괄호 안에 넣어야 할 값이 빠졌어요. 예를 들어 qc.measure는 값이 두 개 필요해요.'],
  [/unexpected indent|expected an indented block/i,
   '줄 앞의 빈칸(들여쓰기)이 어긋났어요. 앞의 빈칸을 지우거나 맞춰 보세요.'],
  [/was never closed|invalid syntax/i,
   '괄호를 닫았는지, 따옴표가 짝이 맞는지 확인해 보세요.'],
];

function friendlyHint(error) {
  const haystack = `${error.type || ''} ${error.message || ''}`;
  const match = ERROR_HINTS.find(([pattern]) => pattern.test(haystack));
  return match ? match[1] : null;
}

function errorDetail(error) {
  const parts = [];
  if (error.line) parts.push(`${error.line}번 줄`);
  if (error.source_line) parts.push(`${error.source_line.trim()}`);
  const where = parts.length ? `${parts.join(' — ')}\n` : '';
  const hint = friendlyHint(error);
  return `${where}${error.message}${hint ? `\n\n${hint}` : ''}`;
}

/* ===================== 제출 ===================== */

const DEFAULT_PROMPT = '이 코드가 어떻게 동작하는지 짧게 써 줘. 왜 이렇게 했는지도 좋아.';

function openSubmit() {
  const modal = document.getElementById('submit-modal');
  document.getElementById('submit-prompt').textContent =
    lesson.reflection || DEFAULT_PROMPT;

  // 지금 어떤 상태로 내는지 보여준다. 못 푼 채 내는 것도 선택지다.
  const chips = [
    [`실행 ${runIndex}회`, 'bg-slate-100 text-slate-600'],
    [`힌트 ${hintsShown}개`, hintsShown
      ? 'bg-secondary-soft text-secondary'
      : 'bg-slate-100 text-slate-600'],
    [passed ? '목표 달성' : '아직 목표 미달성', passed
      ? 'bg-green-100 text-green-700'
      : 'bg-slate-100 text-slate-600'],
  ];
  document.getElementById('submit-summary').innerHTML = chips
    .map(([text, cls]) =>
      `<span class="text-[11px] font-bold px-2 py-1 rounded-full ${cls}">${text}</span>`)
    .join('');

  modal.classList.remove('hidden');
  document.getElementById('submit-answer').focus();
  logEvent('submit_opened', {
    run_index: runIndex, passed, hints_shown: hintsShown,
  }, lesson.id);
}

function closeSubmit() {
  document.getElementById('submit-modal').classList.add('hidden');
}

async function confirmSubmit() {
  const answer = document.getElementById('submit-answer').value.trim();
  const code = editor.getCode();
  submissionIndex += 1;
  submitted = true;

  const context = {
    passed,
    runs: runIndex,
    hintsShown,
    secondsOnLesson: Math.round((Date.now() - openedAt) / 1000),
  };

  logEvent('answer_submitted', {
    submission_index: submissionIndex,
    code_chars: code.length,
    answer_chars: answer.length,
    ...context,
    seconds_on_lesson: context.secondsOnLesson,
  }, lesson.id);

  await logSubmission({
    lessonId: lesson.id,
    submissionIndex,
    code,
    answer,
    context,
  });

  updateProgress(lesson.id, { submitted: submissionIndex, passed });
  renderProgressDots();
  // 상태 카드가 '준비되면 제출하기를 눌러'로 남아 있으면 방금 한 일과 어긋난다.
  if (passed) {
    renderStatus('pass', '목표 달성!', '이미 제출했어. 더 고쳐서 다시 제출해도 돼.');
  }
  closeSubmit();
  revealSolution();
  updateSubmitButton();
  renderSessionEnd();
}

/**
 * 제출 후에만 해설을 연다. 그 전에 보이면 문제해결 과정이 사라진다.
 * @param {boolean} revealedByAction 방금 제출해서 열렸는가 (재방문이면 false)
 */
function revealSolution(revealedByAction = true) {
  const block = document.getElementById('solution-block');
  if (!block.classList.contains('hidden')) return;

  const codeEl = document.getElementById('solution-code');
  if (lesson.solution?.code) {
    codeEl.textContent = lesson.solution.code;
    codeEl.classList.remove('hidden');
  }
  document.getElementById('solution-text').textContent = lesson.solution?.explanation || '';
  block.classList.remove('hidden');
  if (revealedByAction) {
    block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    logEvent('solution_viewed', { submission_index: submissionIndex }, lesson.id);
  }
}

/**
 * 차시의 마지막 레슨을 제출했으면 목차로 돌아갈 길을 보여준다.
 * 다음 차시로 바로 넘어가는 버튼은 두지 않는다 — 진도는 수업이 정한다.
 */
function renderSessionEnd() {
  if (!isSessionEnd || !submitted) return;
  if (document.getElementById('session-end')) return;

  const box = document.createElement('div');
  box.id = 'session-end';
  box.className =
    'rounded-xl border border-primary/25 bg-primary-soft px-4 py-3.5 flex items-center gap-3';
  box.innerHTML = `
    <span class="material-icons-round text-primary">flag</span>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-bold">${lesson.week}주차 ${lesson.session}차시 끝!</p>
      <p class="text-xs text-slate-600 mt-0.5">여기까지가 이번 시간 분량이야.</p>
    </div>`;
  const link = document.createElement('a');
  link.href = '/lessons.html';
  link.className =
    'shrink-0 bg-primary hover:bg-primary-dark text-white font-bold text-xs px-3 py-2 rounded-lg transition-colors';
  link.textContent = '목차로';
  link.addEventListener('click', (event) => {
    event.preventDefault();
    logEvent('session_complete', { week: lesson.week, session: lesson.session }, lesson.id);
    goToIndex();
  });
  box.appendChild(link);

  const host = document.querySelector('#dash-result') || document.getElementById('result-status');
  host.parentElement.insertBefore(box, host);
}

function updateSubmitButton() {
  const label = document.getElementById('submit-label');
  const button = document.getElementById('btn-submit');
  if (!submitted) return;
  label.textContent = submissionIndex > 1
    ? `다시 제출 (${submissionIndex}회)`
    : '다시 제출';
  button.className =
    'border border-primary/30 text-primary bg-primary-soft hover:bg-primary/10 '
    + 'font-bold text-sm px-4 py-2.5 rounded-xl transition flex items-center gap-1.5';
}

/* ===================== 이동 ===================== */

async function goToSession(index) {
  if (index < 0 || index >= sessionLessons.length) return;
  // 보내고 나서 이동한다. 이동부터 하면 진행 중이던 요청이 취소된다.
  await flush();
  window.location.href = `/lesson.html?id=${sessionLessons[index].id}`;
}

async function goToIndex() {
  await flush();
  window.location.href = '/lessons.html';
}

/* ===================== 초기화 ===================== */

function initEditor() {
  const saved = localStorage.getItem(draftKey);
  editor = createEditor({
    parent: document.getElementById('editor-host'),
    doc: saved ?? lesson.starter_code,
    onChange(code) {
      localStorage.setItem(draftKey, code);
      clearTimeout(editTimer);
      editTimer = setTimeout(() => {
        logEvent('code_edit', {
          code_chars: code.length,
          run_index: runIndex,
          code,
          // 결과를 본 뒤의 수정인지 구분한다. run_index만으로도 복원되지만,
          // '결과 기반 수정'은 자주 볼 지표라 바로 질의할 수 있게 남긴다.
          ms_since_result: lastResultAt ? Date.now() - lastResultAt : null,
          last_run_status: lastResult?.status ?? null,
        }, lesson.id);
      }, EDIT_DEBOUNCE_MS);
    },
    onPaste({ chars, preview }) {
      logEvent('paste', { pasted_chars: chars, preview, run_index: runIndex }, lesson.id);
    },
  });
}

function bindControls() {
  document.getElementById('btn-run').addEventListener('click', run);
  document.getElementById('btn-hint').addEventListener('click', showNextHint);

  document.getElementById('btn-reset').addEventListener('click', () => {
    editor.setCode(lesson.starter_code);
    editor.focus();
    logEvent('reset_code', { run_index: runIndex }, lesson.id);
  });

  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  prev.disabled = sessionIndex === 0;
  next.disabled = isSessionEnd;
  prev.title = prev.disabled ? '이 차시의 첫 레슨이야' : '이전 레슨';
  next.title = next.disabled ? '이 차시의 마지막 레슨이야. 목차로 돌아가면 돼' : '다음 레슨';
  prev.addEventListener('click', () => goToSession(sessionIndex - 1));
  next.addEventListener('click', () => goToSession(sessionIndex + 1));

  document.getElementById('btn-submit').addEventListener('click', openSubmit);
  document.getElementById('submit-cancel').addEventListener('click', () => {
    logEvent('submit_cancelled', { run_index: runIndex }, lesson.id);
    closeSubmit();
  });
  document.getElementById('submit-confirm').addEventListener('click', confirmSubmit);

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });

  window.addEventListener('pagehide', () => {
    logEvent('lesson_leave', {
      seconds_on_lesson: Math.round((Date.now() - openedAt) / 1000),
      runs: runIndex,
      hints_shown: hintsShown,
      passed,
      submissions: submissionIndex,
      last_status: lastResult?.status ?? null,
    }, lesson.id);
  });
}

renderLessonInfo();
renderProgressDots();
if (submitted) {
  // 이미 제출한 레슨을 다시 열었다. 해설은 이미 본 것이므로 계속 열어 둔다.
  revealSolution(false);
  updateSubmitButton();
  renderSessionEnd();
}
initEditor();
bindControls();

logEvent('lesson_open', {
  week: lesson.week,
  resumed_draft: Boolean(localStorage.getItem(draftKey)),
}, lesson.id);

document.body.classList.add('ready');
editor.focus();
