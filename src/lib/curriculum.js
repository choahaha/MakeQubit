import all from '../../data/lessons.json';

/**
 * 이번 수업에서 쓰는 레슨.
 *
 * `hidden: true`인 레슨은 지운 것이 아니라 빼 둔 것이다. 만들어 두고 검증까지
 * 마친 레슨을 파일에서 지우면 되살릴 때 다시 만들어야 하고, 그 사이 학생이
 * 남긴 기록의 lesson_id도 가리키는 곳이 없어진다.
 *
 * 학생에게 보이는 화면(목차, 레슨, 답안지)은 이 목록을 쓴다.
 * 관리자 화면은 원본을 그대로 쓴다 — 지난 기록의 레슨 제목을 찾으려면
 * 숨긴 레슨도 알아야 한다.
 */
export const lessons = all.filter((lesson) => !lesson.hidden);

/** 숨긴 것까지 포함한 원본. 기록 조회용. */
export const allLessons = all;
