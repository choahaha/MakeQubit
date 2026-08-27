import { supabase } from './supabase.js';

const PARTICIPANT_KEY = 'makequbit.participant';

/**
 * 참여자 세션.
 *  - participant: { id, code } — 브라우저에 유지 (수업 중 새로고침 대비)
 *  - sessionId: 페이지 로드마다 새로 발급. 한 번의 앉은 자리를 뜻한다.
 */
let sessionId = null;

export function getSessionId() {
  if (!sessionId) sessionId = crypto.randomUUID();
  return sessionId;
}

export function getParticipant() {
  try {
    const raw = localStorage.getItem(PARTICIPANT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearParticipant() {
  localStorage.removeItem(PARTICIPANT_KEY);
}

/**
 * 참여자 코드로 입장한다. 없으면 새로 만든다.
 * Supabase가 설정되지 않은 경우에도 로컬 전용 참여자로 계속 진행한다.
 */
export async function enterWithCode(code, { cohort = null } = {}) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error('참여자 코드를 입력해 주세요.');
  if (!/^[A-Z0-9-]{2,24}$/.test(normalized)) {
    throw new Error('참여자 코드는 영문/숫자/하이픈 2~24자여야 해요.');
  }

  if (!supabase) {
    const participant = { id: crypto.randomUUID(), code: normalized, local: true };
    localStorage.setItem(PARTICIPANT_KEY, JSON.stringify(participant));
    return participant;
  }

  const { data: existing, error: selectError } = await supabase
    .from('participants')
    .select('id, participant_code')
    .eq('participant_code', normalized)
    .maybeSingle();
  if (selectError) throw new Error(`서버 연결에 실패했어요: ${selectError.message}`);

  let row = existing;
  if (!row) {
    const { data: created, error: insertError } = await supabase
      .from('participants')
      .insert({ participant_code: normalized, cohort })
      .select('id, participant_code')
      .single();
    if (insertError) throw new Error(`참여자 등록에 실패했어요: ${insertError.message}`);
    row = created;
  }

  const participant = { id: row.id, code: row.participant_code };
  localStorage.setItem(PARTICIPANT_KEY, JSON.stringify(participant));
  return participant;
}
