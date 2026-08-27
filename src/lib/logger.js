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
  if (!participant) return null;

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
 * 실행 스냅샷은 큐를 거치지 않고 바로 보낸다. 수업 중 탭이 닫혀도
 * 코드 원문만은 남아야 한다.
 */
export async function logCodeRun({ lessonId, runIndex, seqValue, code, result }) {
  const participant = getParticipant();
  if (!participant || !supabase) return;

  const error = result.error || {};
  const { error: insertError } = await supabase.from('code_runs').insert({
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
    execution_time_ms: result.execution_time_ms ?? null,
  });
  if (insertError) console.warn('[logger] code_run insert failed', insertError.message);
}

// 탭을 닫아도 큐에 남은 이벤트를 잃지 않는다.
window.addEventListener('pagehide', () => { flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
