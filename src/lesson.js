import './style.css';
import lessons from '../data/lessons.json';
import { createEditor } from './lib/editor.js';
import { runCode } from './lib/api.js';
import { checkLesson } from './lib/check.js';
import { renderCircuitSvg } from './lib/circuit-svg.js';
import { getParticipant } from './lib/session.js';
import { logEvent, logCodeRun, flush, nextSeq } from './lib/logger.js';
import { supabase } from './lib/supabase.js';

const EDIT_DEBOUNCE_MS = 2500;
const PROGRESS_KEY = 'makequbit.progress';

const participant = getParticipant();
if (!participant) window.location.replace('/');

const lessonId = new URLSearchParams(window.location.search).get('id');
const lessonIndex = Math.max(0, lessons.findIndex((l) => l.id === lessonId));
const lesson = lessons[lessonIndex];

const draftKey = `makequbit.draft.${participant.code}.${lesson.id}`;
const openedAt = Date.now();

let editor;
let runIndex = 0;
let hintsShown = 0;
let lastResult = null;
let editTimer = null;
let passed = false;

/* ===================== 진행 상태 ===================== */

function readProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
  } catch {
    return {};
  }
}

function markComplete(id) {
  const progress = readProgress();
  progress[id] = true;
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  renderProgressDots();
}

/* ===================== 레슨 안내 렌더 ===================== */

function renderLessonInfo() {
  document.title = `${lesson.title} — MakeQubit`;
  document.getElementById('lesson-week').textContent = `${lesson.week}주차`;
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

function renderProgressDots() {
  const container = document.getElementById('progress-dots');
  const progress = readProgress();
  container.innerHTML = '';

  lessons.forEach((item, index) => {
    const dot = document.createElement('a');
    dot.href = `/lesson.html?id=${item.id}`;
    dot.title = `${item.week}주차 · ${item.title}`;
    const state = progress[item.id]
      ? 'bg-accent-green'
      : index === lessonIndex ? 'bg-primary' : 'bg-slate-200 hover:bg-slate-300';
    const size = index === lessonIndex ? 'w-5' : 'w-2';
    dot.className = `h-2 ${size} rounded-full transition-all ${state}`;
    container.appendChild(dot);
  });
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
  card.className = 'bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-sm leading-relaxed text-amber-900';
  card.innerHTML = `<span class="font-bold text-xs text-amber-600 block mb-0.5">힌트 ${hintsShown}</span>`;
  card.appendChild(document.createTextNode(text));
  document.getElementById('hint-list').appendChild(card);

  logEvent('hint_open', { hint_index: hintsShown, run_index: runIndex }, lesson.id);
  updateHintButton();
}

/* ===================== 결과 렌더 ===================== */

const STATUS_STYLES = {
  pass:    { box: 'bg-green-50 border border-green-200 text-green-800', icon: 'check_circle' },
  success: { box: 'bg-slate-100 border border-slate-200 text-slate-600', icon: 'done' },
  retry:   { box: 'bg-amber-50 border border-amber-200 text-amber-800', icon: 'refresh' },
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
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const max = Math.max(...entries.map(([, n]) => n));

  document.getElementById('counts-total').textContent = `${total} shots`;
  const chart = document.getElementById('counts-chart');
  chart.innerHTML = '';

  for (const [bits, count] of entries) {
    const percent = ((count / total) * 100).toFixed(1);
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="flex items-baseline justify-between text-[11px] font-code mb-1">
        <span class="font-bold text-slate-700">|${bits}⟩</span>
        <span class="text-slate-500">${count} · ${percent}%</span>
      </div>
      <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden">
        <div class="h-full bg-primary rounded-full origin-left bar-grow"
             style="width: ${(count / max) * 100}%"></div>
      </div>`;
    chart.appendChild(row);
  }
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
        markComplete(lesson.id);
      }
      renderStatus('pass', '목표 달성!', lesson.check?.type === 'none'
        ? '자유롭게 더 실험해 봐도 좋아.'
        : '다음 레슨으로 넘어가도 좋아.');
    } else {
      renderStatus('retry', '실행은 됐어. 그런데 목표와는 조금 달라', outcome.reason);
    }
    logEvent('check_result', {
      run_index: runIndex,
      passed: outcome.passed,
      reason: outcome.reason || null,
    }, lesson.id);

    // 히스토그램이 그려지는 걸 먼저 보게 한다. 방금 얻은 결과를 모달로
    // 곧장 덮으면 학생이 자기가 뭘 해냈는지 못 보고 지나간다.
    if (outcome.passed && lesson.reflection) setTimeout(openReflection, 1600);
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

/* ===================== 되돌아보기 ===================== */

function openReflection() {
  const modal = document.getElementById('reflection-modal');
  document.getElementById('reflection-prompt').textContent = lesson.reflection;
  modal.classList.remove('hidden');
  document.getElementById('reflection-answer').focus();
}

function closeReflection() {
  document.getElementById('reflection-modal').classList.add('hidden');
}

async function submitReflection() {
  const answer = document.getElementById('reflection-answer').value.trim();
  if (answer && supabase) {
    const { error } = await supabase.from('reflections').insert({
      participant_id: participant.id,
      lesson_id: lesson.id,
      prompt: lesson.reflection,
      answer,
    });
    if (error) console.warn('[reflection] insert failed', error.message);
  }
  logEvent('reflection_submit', { chars: answer.length, skipped: !answer }, lesson.id);
  closeReflection();
  goTo(lessonIndex + 1);
}

/* ===================== 이동 ===================== */

async function goTo(index) {
  if (index < 0 || index >= lessons.length) return;
  // 보내고 나서 이동한다. 이동부터 하면 진행 중이던 요청이 취소된다.
  await flush();
  window.location.href = `/lesson.html?id=${lessons[index].id}`;
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
  prev.disabled = lessonIndex === 0;
  next.disabled = lessonIndex === lessons.length - 1;
  prev.addEventListener('click', () => goTo(lessonIndex - 1));
  next.addEventListener('click', () => goTo(lessonIndex + 1));

  document.getElementById('reflection-skip').addEventListener('click', () => {
    logEvent('reflection_submit', { chars: 0, skipped: true }, lesson.id);
    closeReflection();
  });
  document.getElementById('reflection-submit').addEventListener('click', submitReflection);

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
      last_status: lastResult?.status ?? null,
    }, lesson.id);
  });
}

renderLessonInfo();
renderProgressDots();
initEditor();
bindControls();

logEvent('lesson_open', {
  week: lesson.week,
  resumed_draft: Boolean(localStorage.getItem(draftKey)),
}, lesson.id);

document.body.classList.add('ready');
editor.focus();
