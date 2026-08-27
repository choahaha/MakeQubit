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
    if (!raw) return null;
    const participant = JSON.parse(raw);

    // Supabase 없이 만든 로컬 전용 참여자(무작위 UUID)가 남아 있으면 버린다.
    // 그대로 두면 키를 넣은 뒤에도 그 UUID로 insert를 시도해 모든 로깅이
    // 외래키 위반으로 실패한다 — 화면은 멀쩡한데 데이터만 안 쌓인다.
    if (participant?.local && supabase) {
      localStorage.removeItem(PARTICIPANT_KEY);
      return null;
    }
    return participant;
  } catch {
    return null;
  }
}

export function clearParticipant() {
  localStorage.removeItem(PARTICIPANT_KEY);
}

/**
 * 입력을 정규화한다. 학생은 'q07', 'Q-07', 'Q 07'을 다 친다 — 전부 'Q07'로 본다.
 * 하이픈과 공백을 지우는 이유는 관대해서가 아니라, 같은 학생이 같은 코드로
 * 들어오게 만들기 위해서다.
 */
function normalizeCode(raw) {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * 참여자 코드로 입장한다.
 *
 * 명부에 없는 코드는 거부한다. 새로 만들지 않는다 — 오타 하나가 새 참여자를
 * 만들면 그 학생의 3주 기록이 조용히 둘로 쪼개지고, 분석 단계에서야 알게 된다.
 * 명부는 backend/sql/003_seed_participants.sql로 미리 넣는다.
 *
 * Supabase가 설정되지 않은 경우에만 로컬 전용 참여자로 진행한다 (개발용).
 */
export async function enterWithCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) throw new Error('참여자 코드를 입력해 주세요.');
  if (!/^[A-Z0-9]{2,12}$/.test(normalized)) {
    throw new Error('참여자 코드는 영문과 숫자로만 이루어져 있어요. 예: Q07');
  }

  if (!supabase) {
    const participant = { id: crypto.randomUUID(), code: normalized, local: true };
    localStorage.setItem(PARTICIPANT_KEY, JSON.stringify(participant));
    return participant;
  }

  // maybeSingle()을 쓰지 않는다. 그쪽은 '테이블이 없음'과 '해당 코드 없음'을
  // 똑같이 0행으로 삼켜 버려서, 수업 당일 SQL을 안 돌렸을 때 학생 화면에
  // "명부에 없는 코드"가 뜨고 교사가 엉뚱한 곳을 뒤지게 된다.
  // select('*')를 쓰는 이유: is_test 컬럼은 나중에 추가된 것이라, 컬럼명을
  // 명시하면 마이그레이션 전 DB에서 입장 자체가 깨진다. '*'는 양쪽에서 동작한다.
  const { data: rows, error } = await supabase
    .from('participants')
    .select('*')
    .eq('participant_code', normalized)
    .limit(1);

  if (error) {
    throw new Error(
      `참여자 명부를 읽지 못했어요. 선생님께 알려 주세요. (${error.message})`
    );
  }
  if (!rows?.length) {
    throw new Error(`'${normalized}'는 명부에 없는 코드예요. 선생님께 확인해 주세요.`);
  }

  const participant = {
    id: rows[0].id,
    code: rows[0].participant_code,
    isTest: rows[0].is_test === true,
    purpose: rows[0].cohort || null,
  };
  localStorage.setItem(PARTICIPANT_KEY, JSON.stringify(participant));
  return participant;
}
