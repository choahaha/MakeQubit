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
