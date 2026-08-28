/**
 * 레슨별 진행 상태. 브라우저에만 저장한다.
 *
 * 연구 데이터는 Supabase가 갖고 있지만, 목차 화면은 학생이 자기 진행을
 * 바로 보는 용도라 서버를 기다릴 이유가 없다. 기록이 지워져도 실습에는
 * 지장이 없다 — 연구 데이터와는 별개다.
 */

const KEY = 'makequbit.progress';

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    // 예전에는 boolean 하나만 저장했다. 그 기록도 읽을 수 있어야 한다.
    return Object.fromEntries(Object.entries(raw).map(([id, value]) =>
      [id, typeof value === 'boolean' ? { passed: value } : value]));
  } catch {
    return {};
  }
}

function write(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* 저장 공간이 없어도 실습은 계속돼야 한다 */ }
}

/** @returns {{passed?: boolean, submitted?: number, runs?: number, at?: string}} */
export function getProgress(lessonId) {
  return read()[lessonId] || {};
}

export function getAllProgress() {
  return read();
}

export function updateProgress(lessonId, patch) {
  const all = read();
  all[lessonId] = { ...(all[lessonId] || {}), ...patch, at: new Date().toISOString() };
  write(all);
  return all[lessonId];
}

/** 목차에 보여줄 한 단어 상태. */
export function statusOf(lessonId) {
  const p = getProgress(lessonId);
  if (p.submitted) return 'submitted';
  if (p.passed) return 'passed';
  if (p.runs) return 'started';
  return 'todo';
}

/* ===================== 형성평가 ===================== */

const QUIZ_KEY = 'makequbit.quiz';

function readQuiz() {
  try {
    return JSON.parse(localStorage.getItem(QUIZ_KEY) || '{}');
  } catch {
    return {};
  }
}

export function getQuizProgress(week, session) {
  return readQuiz()[`${week}-${session}`] || null;
}

export function updateQuizProgress(week, session, patch) {
  const all = readQuiz();
  const key = `${week}-${session}`;
  all[key] = { ...(all[key] || {}), ...patch, at: new Date().toISOString() };
  try {
    localStorage.setItem(QUIZ_KEY, JSON.stringify(all));
  } catch { /* 저장 못 해도 실습은 계속돼야 한다 */ }
}

/* ===================== 형성평가 진행 중 상태 ===================== */

/**
 * 푸는 도중에 나갔다 와도 이어서 풀 수 있게 한다.
 *
 * 답 자체는 문항마다 Supabase에 이미 저장된다. 그걸 다시 읽어오지 않고
 * 브라우저에 따로 두는 이유는, 로그인이 없어서 RLS로 '자기 응답만 읽기'를
 * 만들 수 없기 때문이다. select를 열면 학생이 남의 답을 다 읽을 수 있다.
 */
const QUIZ_STATE_KEY = 'makequbit.quizstate';

function readState() {
  try {
    return JSON.parse(localStorage.getItem(QUIZ_STATE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeState(all) {
  try {
    localStorage.setItem(QUIZ_STATE_KEY, JSON.stringify(all));
  } catch { /* 저장 못 해도 풀이는 계속돼야 한다 */ }
}

/**
 * @param {number} week @param {number} session
 * @param {string[]} itemIds 지금 문항 구성. 바뀌었으면 저장된 걸 버린다.
 * @returns {{answers: Array<{itemId:string, picked:number, correct:boolean}>}|null}
 */
export function getQuizState(week, session, itemIds) {
  const saved = readState()[`${week}-${session}`];
  if (!saved || !Array.isArray(saved.answers)) return null;

  // 문항을 고친 뒤라면 이어서 푸는 것이 의미가 없다.
  if (saved.itemIds?.join('|') !== itemIds.join('|')) return null;
  return saved;
}

export function saveQuizAnswer(week, session, itemIds, answer) {
  const all = readState();
  const key = `${week}-${session}`;
  const current = all[key]?.itemIds?.join('|') === itemIds.join('|')
    ? all[key]
    : { itemIds, answers: [] };

  // 같은 문항을 두 번 저장하지 않는다 (이어풀기로 되돌아온 경우)
  if (!current.answers.some((a) => a.itemId === answer.itemId)) {
    current.answers.push(answer);
  }
  current.at = new Date().toISOString();
  all[key] = current;
  writeState(all);
}

export function clearQuizState(week, session) {
  const all = readState();
  delete all[`${week}-${session}`];
  writeState(all);
}
