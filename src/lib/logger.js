import { supabase } from './supabase.js';
import { getParticipant, getSessionId } from './session.js';

/**
 * 학습 궤적 로거.
 *
 * seq는 세션 안에서 단조 증가한다. 네트워크 지연으로 created_at 순서가
 * 뒤집혀도 seq로 정렬하면 실제 행동 순서가 복원된다.
 *
 * 이벤트는 모아서 보낸다 — 타이핑마다 왕복하면 편집기가 끊긴다.
 */
let seq = 0;
let queue = [];
let flushTimer = null;

const FLUSH_INTERVAL_MS = 4000;
const MAX_QUEUE = 40;

export function nextSeq() {
  return ++seq;
}

export function logEvent(eventType, payload = {}, lessonId = null) {
  const participant = getParticipant();
  if (!participant || participant.local) return null;

  const row = {
    participant_id: participant.id,
    session_id: getSessionId(),
    seq: nextSeq(),
    lesson_id: lessonId,
    event_type: eventType,
    payload,
    client_ts: new Date().toISOString(),
  };

  queue.push(row);
  if (queue.length >= MAX_QUEUE) {
    flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }
  return row.seq;
}

export async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!queue.length || !supabase) {
    queue = [];
    return;
  }
  const batch = queue;
  queue = [];
  const { error } = await supabase.from('learning_events').insert(batch);
  if (error) console.warn('[logger] event flush failed', error.message);
}

/**
 * 탭이 닫히거나 페이지를 떠날 때의 마지막 전송.
 *
 * 이 시점의 fetch는 브라우저가 취소해 버린다 ('Failed to fetch'). sendBeacon은
 * 페이지가 사라진 뒤에도 전송이 보장되는 유일한 경로다. 커스텀 헤더를 못 붙이므로
 * apikey를 쿼리 파라미터로 넘긴다 — anon 키는 원래 공개되는 값이라 문제 없다.
 */
function flushWithBeacon() {
  if (!queue.length || !supabase) return;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !navigator.sendBeacon) {
    flush();
    return;
  }

  const batch = queue;
  queue = [];
  const endpoint = `${url}/rest/v1/learning_events?apikey=${encodeURIComponent(anonKey)}`;
  const payload = new Blob([JSON.stringify(batch)], { type: 'application/json' });

  if (!navigator.sendBeacon(endpoint, payload)) {
    // 큐에 되돌려 놓는다. 페이지가 살아남으면 다음 flush에 다시 실린다.
    queue = batch.concat(queue);
    flush();
  }
}

/**
 * 실행 스냅샷은 큐를 거치지 않고 바로 보낸다. 수업 중 탭이 닫혀도
 * 코드 원문만은 남아야 한다.
 */
export async function logCodeRun({ lessonId, runIndex, seqValue, code, result }) {
  const participant = getParticipant();
  if (!participant || participant.local || !supabase) return;

  const error = result.error || {};
  const row = {
    participant_id: participant.id,
    session_id: getSessionId(),
    seq: seqValue,
    lesson_id: lessonId,
    run_index: runIndex,
    code,
    status: result.status,
    error_type: error.type || null,
    error_message: error.message || null,
    error_line: error.line ?? null,
    stdout: result.stdout ?? null,
    counts: result.counts ?? null,
    // 회로 구조. counts만으로는 '왜 틀렸는지'를 못 본다 — CNOT 방향이
    // 뒤집혔는지, H가 어디 붙었는지, 큐비트 수가 요구와 다른지는
    // 게이트 시퀀스를 봐야 안다.
    circuit_spec: result.circuit_spec ?? null,
    execution_time_ms: result.execution_time_ms ?? null,
  };

  const { error: insertError } = await supabase.from('code_runs').insert(row);
  if (!insertError) return;

  // 프론트가 먼저 배포되고 마이그레이션이 늦으면, 새 컬럼 하나 때문에
  // insert 전체가 400으로 죽는다. 그 상태로 수업을 하면 한 반의 실행
  // 기록이 통째로 사라진다. 컬럼을 빼고 한 번 더 시도해서, 최소한
  // 코드와 결과는 남긴다.
  if (/circuit_spec/.test(insertError.message)) {
    const { circuit_spec: _dropped, ...fallback } = row;
    const { error: retryError } = await supabase.from('code_runs').insert(fallback);
    if (!retryError) {
      console.warn('[logger] circuit_spec 컬럼 없음 — 006 마이그레이션 필요. 나머지는 저장됨');
      return;
    }
    console.warn('[logger] code_run insert failed', retryError.message);
    return;
  }
  console.warn('[logger] code_run insert failed', insertError.message);
}

/**
 * 제출 스냅샷. 실행 기록과 마찬가지로 큐를 거치지 않고 바로 보낸다 —
 * 학생이 제출하자마자 탭을 닫아도 최종 답은 남아야 한다.
 */
export async function logSubmission({ lessonId, submissionIndex, code, answer, context }) {
  const participant = getParticipant();
  if (!participant || participant.local || !supabase) return { saved: false };

  const { error } = await supabase.from('submissions').insert({
    participant_id: participant.id,
    session_id: getSessionId(),
    seq: nextSeq(),
    lesson_id: lessonId,
    submission_index: submissionIndex,
    code,
    answer: answer || null,
    passed: context.passed,
    runs: context.runs,
    hints_shown: context.hintsShown,
    seconds_on_lesson: context.secondsOnLesson,
  });
  if (!error) return { saved: true };

  // submissions 테이블이 아직 없으면(007 미실행) 최종 답이 통째로 사라진다.
  // 학습 궤적 쪽에 원문을 실어 보내 둔다 — 형태는 나쁘지만 잃는 것보다 낫다.
  console.warn('[logger] submission insert failed', error.message);
  logEvent('answer_submitted_fallback', {
    submission_index: submissionIndex,
    code,
    answer: answer || null,
    ...context,
  }, lessonId);
  await flush();
  return { saved: false };
}

/**
 * 형성평가 응답. 문항 하나마다 바로 보낸다 — 중간에 그만둬도
 * 거기까지 푼 것은 남아야 한다.
 */
export async function logAssessment({
  week, session, itemId, itemType, picked, correct, msToAnswer,
}) {
  const participant = getParticipant();
  if (!participant || participant.local || !supabase) return;

  const { error } = await supabase.from('assessment_responses').insert({
    participant_id: participant.id,
    session_id: getSessionId(),
    seq: nextSeq(),
    week,
    session,
    item_id: itemId,
    item_type: itemType,
    picked,
    correct,
    ms_to_answer: msToAnswer,
  });
  if (error) console.warn('[logger] assessment insert failed', error.message);
}

/**
 * 차시별 되돌아보기.
 *
 * 001에서 만든 reflections 테이블을 그대로 쓴다. lesson_id 자리에
 * 'w2s2' 형태로 차시를 넣는다 — 마이그레이션을 하나 더 돌리게 하는 것보다
 * 낫다. 분석할 때는 lesson_id like 'w%s%'로 거른다.
 */
export async function logReflection({ week, session, prompt, answer }) {
  const participant = getParticipant();
  if (!participant || participant.local || !supabase) return;

  const { error } = await supabase.from('reflections').insert({
    participant_id: participant.id,
    lesson_id: `w${week}s${session}`,
    prompt,
    answer,
  });
  if (error) console.warn('[logger] reflection insert failed', error.message);
}

// 탭을 닫거나 다른 앱으로 넘어가도 큐에 남은 이벤트를 잃지 않는다.
window.addEventListener('pagehide', flushWithBeacon);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushWithBeacon();
});
