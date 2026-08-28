import './style.css';
import lessons from '../data/lessons.json';
import assessments from '../data/assessments.json';
import { getParticipant } from './lib/session.js';

/**
 * 교사용 답안지.
 *
 * 수업 중에 정답을 찾아 헤매지 않으려고 만든다. 학생 화면과 같은 데이터를
 * 읽으므로 레슨을 고치면 여기도 같이 바뀐다 — 따로 관리하는 답안 문서는
 * 반드시 언젠가 어긋난다.
 *
 * 로깅은 하지 않는다. 교사가 답을 본 것은 연구 데이터가 아니다.
 */

const participant = getParticipant();

if (!participant) {
  showGate('먼저 참여자 코드로 들어와 주세요. 교사용 코드는 T00이에요.');
} else if (!participant.isTest) {
  // Q00(점검용)과 T00(교사용)만 통과한다. 학생 코드로는 열리지 않는다.
  showGate(`'${participant.code}'는 학생 코드예요. 교사용 코드 T00으로 다시 들어와 주세요.`);
} else {
  render();
}

function showGate(message) {
  document.getElementById('gate-message').textContent = message;
  document.getElementById('gate').classList.remove('hidden');
}

/* ===================== 정답 코드 만들기 ===================== */

/**
 * 시작 코드의 TODO 자리에 정답을 끼워 넣어 실제로 도는 코드를 만든다.
 *
 * 들여쓰기 규칙: 정답 줄이 이미 공백으로 시작하면 그대로 두고, 아니면 TODO
 * 줄의 들여쓰기를 붙인다. 레슨마다 solution.code의 모양이 다르기 때문이다 —
 * 함수 안에 들어가는 레슨은 절대 들여쓰기로 적혀 있고, 그렇지 않은 레슨은
 * 첫 줄이 TODO 자리를 물려받는 식으로 적혀 있다.
 *
 * @returns {{lines: string[], answerFrom: number, answerTo: number}}
 */
function solvedCode(lesson) {
  const lines = lesson.starter_code.split('\n');
  const code = lesson.solution?.code;
  if (!code) return { lines, answerFrom: -1, answerTo: -1 };

  const todo = lines.findIndex((line) => line.includes('TODO'));
  if (todo < 0) return { lines, answerFrom: -1, answerTo: -1 };

  // 숫자 하나만 바꾸는 레슨(shots, p)은 TODO 아래에 줄을 더하는 게 아니라
  // 이미 있는 줄을 갈아 끼운다.
  const assignment = code.includes('=') && !code.trim().startsWith('qc.');
  if (assignment) {
    const name = code.split('=')[0].trim();
    const target = lines.findIndex((line) => line.trim().startsWith(`${name} =`));
    if (target >= 0) {
      const out = [...lines];
      out[target] = code;
      return { lines: out, answerFrom: target, answerTo: target };
    }
  }

  // TODO에 이어지는 주석 줄까지는 남긴다 — 학생이 무엇을 보고 있었는지가 보인다.
  let after = todo + 1;
  while (after < lines.length && lines[after].trim().startsWith('#')) after += 1;

  const indent = lines[todo].match(/^\s*/)[0];
  const body = code.split('\n').map((line) => (line.startsWith(' ') ? line : indent + line));

  return {
    lines: [...lines.slice(0, after), ...body, ...lines.slice(after)],
    answerFrom: after,
    answerTo: after + body.length - 1,
  };
}

/**
 * 판정 조건을 있는 그대로 적는다.
 *
 * 학생 화면의 targetLine()은 회로 구조와 기대 출력 조건을 일부러 비운다 —
 * 그게 곧 정답이기 때문이다. 교사는 반대로 무엇을 보고 통과시키는지 전부
 * 알아야 하므로 여기서는 감추지 않는다.
 */
function checkSummary(check) {
  const specs = (Array.isArray(check) ? check : [check]).filter((s) => s && s.type);
  if (!specs.length || specs.every((s) => s.type === 'none')) return [];
  return specs.map(describeCheck).filter(Boolean);
}

function describeCheck(spec) {
  switch (spec.type) {
    case 'none':
      return null;
    case 'counts_keys':
      return `측정 결과가 ${spec.keys.join(', ')} 만 나올 것`;
    case 'counts_balanced':
      return `${spec.outcomes ?? 2}가지가 각각 ±${Math.round((spec.tolerance ?? 0.15) * 100)}%p 안으로 고르게 나올 것`;
    case 'counts_ratio':
      return `'${spec.key}'이 ${Math.round(spec.target * 100)}% ±${Math.round((spec.tolerance ?? 0.05) * 100)}%p로 나올 것`;
    case 'counts_total_min':
      return `${spec.min}번 이상 잴 것`;
    case 'counts_total_min_max':
      return `${spec.min}~${spec.max}번 사이로 잴 것`;
    case 'circuit_ops':
      return `회로에 ${spec.ops.map((op) => (op.qubits
        ? `${op.name.toUpperCase()}(${op.qubits.join(', ')})`
        : op.name.toUpperCase())).join(', ')} 이(가) 있을 것`;
    case 'circuit_contains':
      return `회로 그림에 ${spec.gates.join(', ')} 이(가) 있을 것`;
    case 'stdout_contains':
      return `출력에 ${spec.needles.map((n) => `'${n}'`).join(', ')} 이(가) 있을 것`;
    default:
      return `${spec.type} (설명 없음)`;
  }
}

/* ===================== 렌더 ===================== */

function render() {
  document.getElementById('sheet').classList.remove('hidden');
  document.getElementById('who').textContent =
    `${participant.code} · ${participant.purpose || '테스트'}`;
  document.getElementById('btn-print').addEventListener('click', () => window.print());

  const sessions = [];
  for (const lesson of lessons) {
    const key = `${lesson.week}-${lesson.session}`;
    let group = sessions.find((s) => s.key === key);
    if (!group) {
      group = { key, week: lesson.week, session: lesson.session, items: [] };
      sessions.push(group);
    }
    group.items.push(lesson);
  }

  document.getElementById('jump').innerHTML = sessions.map((s) => `
    <a href="#w${s.week}s${s.session}"
      class="shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600
             hover:bg-primary-soft hover:text-primary transition">
      ${s.week}주 ${s.session}차시
    </a>`).join('');

  document.getElementById('content').innerHTML =
    sessions.map((s, i) => sessionBlock(s, i, sessions)).join('');
}

function sessionBlock(group, index, all) {
  const before = all.slice(0, index).reduce((sum, s) => sum + s.items.length, 0);
  const quiz = assessments.find((a) => a.week === group.week && a.session === group.session);
  return `
    <section id="w${group.week}s${group.session}" class="space-y-4 print:break-before-page">
      <div class="flex items-baseline gap-2 border-b border-slate-200 pb-2">
        <h2 class="text-lg font-bold">${group.week}주 ${group.session}차시</h2>
        <span class="text-xs text-slate-400">레슨 ${group.items.length}개${
          quiz ? ` · 형성평가 ${quiz.items.length}문항` : ''}</span>
      </div>
      ${group.items.map((l, n) => lessonCard(l, n + 1, group.items.length, before)).join('')}
    </section>`;
}

function lessonCard(lesson, number, total) {
  const { lines, answerFrom, answerTo } = solvedCode(lesson);
  const conditions = checkSummary(lesson.check);

  const code = lines.map((line, i) => {
    const isAnswer = i >= answerFrom && i <= answerTo;
    return `<div class="${isAnswer
      ? 'bg-primary-soft border-l-[3px] border-primary -ml-[3px] pl-[9px] font-bold'
      : 'pl-1.5'}">${escapeHtml(line) || '&nbsp;'}</div>`;
  }).join('');

  return `
    <article class="bg-white border border-slate-200 rounded-2xl overflow-hidden print:break-inside-avoid">
      <div class="px-5 py-3.5 border-b border-slate-100 flex items-baseline gap-2.5">
        <span class="font-mono text-xs font-bold text-slate-400">${number}/${total}</span>
        <h3 class="font-bold">${escapeHtml(lesson.title)}</h3>
        <span class="text-xs text-slate-400 truncate">${escapeHtml(lesson.subtitle || '')}</span>
        <a href="/lesson.html?id=${lesson.id}"
          class="ml-auto shrink-0 text-xs font-bold text-primary hover:underline print:hidden">열어 보기</a>
      </div>

      <div class="px-5 py-3.5 space-y-3.5">
        <p class="text-sm leading-relaxed">${escapeHtml(lesson.goal)}</p>

        <div>
          <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
            정답 코드 <span class="text-primary normal-case tracking-normal">— 진한 줄이 학생이 쓸 부분</span>
          </h4>
          <pre class="font-code text-[12.5px] leading-[1.75] bg-slate-50 border border-slate-200
                      rounded-xl py-3 pr-3 overflow-x-auto">${code}</pre>
        </div>

        ${conditions.length ? `
        <div>
          <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">
            판정 조건${conditions.length > 1 ? ' — 전부 만족해야 통과' : ''}
          </h4>
          <ul class="space-y-1 text-sm text-slate-600">
            ${conditions.map((c) => `
              <li class="flex gap-2">
                <span class="material-icons-round text-sm text-accent-green shrink-0 mt-0.5">check</span>
                <span>${escapeHtml(c)}</span>
              </li>`).join('')}
          </ul>
        </div>` : `
        <p class="text-sm text-slate-400">자동 판정이 없는 자유 탐구 레슨이에요.</p>`}

        <div>
          <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1.5">힌트</h4>
          <ol class="space-y-1 text-sm text-slate-600">
            ${lesson.hints.map((h, i) => `
              <li class="flex gap-2">
                <span class="shrink-0 font-bold text-slate-400">${i + 1}</span>
                <span>${escapeHtml(h)}</span>
              </li>`).join('')}
          </ol>
        </div>

        ${lesson.solution?.explanation ? `
        <div>
          <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">해설</h4>
          <p class="text-sm text-slate-600 leading-relaxed">${escapeHtml(lesson.solution.explanation)}</p>
        </div>` : ''}

        ${lesson.extra ? `
        <div>
          <h4 class="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">더 해보기</h4>
          <p class="text-sm text-slate-600">${escapeHtml(lesson.extra)}</p>
        </div>` : ''}
      </div>
    </article>`;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
