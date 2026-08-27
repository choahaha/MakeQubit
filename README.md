# MakeQubit

Qiskit 코드를 직접 쓰고 실행하는 양자 컴퓨팅 학습 플랫폼. 고등학생 대상 3주 수업용이며,
학생의 **최종 코드가 아니라 코드가 만들어지는 과정 전체**를 연구 데이터로 남기는 것이 목적이다.

EduQubit(블록/드래그 기반)과는 별개 프로젝트다. 디자인 토큰과 스택은 EduQubit을 따르되,
학습 방식이 다르다 — 여기서는 학생이 Python을 직접 타이핑한다.

## 구조

```
index.html / src/index.js       참여자 코드 입장
lesson.html / src/lesson.js     실습 화면 (안내 · 편집기 · 결과)
src/lib/editor.js               CodeMirror 6 + 붙여넣기 감지
src/lib/logger.js               학습 궤적 이벤트 · 실행 스냅샷 전송
src/lib/circuit-svg.js          회로 도식 렌더러 (SVG)
src/lib/check.js                레슨 성공 판정
data/lessons.json               레슨 내용 (연구자가 직접 수정하는 파일)

backend/app.py                  FastAPI — /api/run, /api/limits, /api/health
backend/runner.py               부모 프로세스: 타임아웃 · 프로세스 그룹 kill
backend/sandbox_child.py        자식 프로세스: rlimit · import 제한 · 실행
backend/sql/001_init.sql        Supabase 스키마
backend/sql/002_analysis_views.sql  연구 분석용 뷰
```

## 실행

```bash
# 백엔드
cd backend
pip install -r requirements.txt
uvicorn app:app --port 8000

# 프론트엔드
npm install
npm run dev
```

`.env`에 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`을 넣는다.
Supabase 키가 비어 있으면 로깅만 꺼지고 실습은 그대로 동작한다 — 수업 도중 DB 문제로
수업이 멈추면 안 되기 때문이다.

## DB 준비

Supabase Dashboard → SQL Editor에서 `backend/sql/001_init.sql`, 이어서
`002_analysis_views.sql`을 실행한다.

RLS는 브라우저(anon 키)에 **insert만** 허용한다. 학생이 남의 로그를 읽거나 자기 로그를
지울 수 없다. 연구자는 Dashboard 또는 service_role 키로만 읽는다.

## 수집되는 데이터

| 테이블 | 내용 |
|---|---|
| `participants` | 참여자 코드 (실명·학번 없음) |
| `learning_events` | lesson_open, code_edit, paste, run_click, run_result, hint_open, check_result, reset_code, lesson_leave |
| `code_runs` | 실행할 때마다의 **코드 전문**, 상태, 오류 유형/줄, 출력, counts, 실행 시간 |
| `reflections` | 레슨 종료 시 짧은 자기보고 |

`code_runs`만으로 한 학생이 코드를 어떻게 고쳐 나갔는지 순서대로 재구성할 수 있다.
`learning_events.seq`는 세션 안에서 단조 증가하므로, 네트워크 지연으로 도착 순서가
뒤집혀도 실제 행동 순서가 복원된다.

`paste` 이벤트는 붙여넣은 글자 수와 앞부분 500자를 남긴다. 코드의 출처를 구분해야
분석이 가능하기 때문이다. 이 사실은 입장 화면에 고지된다.

## 코드 실행 격리

학생 코드는 별도 프로세스에서 돈다:

- 벽시계 타임아웃 10초 (부모가 프로세스 그룹째 SIGKILL)
- CPU rlimit 6초, 메모리 512MB, 파일 크기 8MB, 프로세스 64개
- import 화이트리스트 — `os`, `sys`, `subprocess`, `socket` 등은 차단
- `open`, `input`, `compile` 등을 학생 네임스페이스에서 제거
- 최소 환경변수만 상속 (서버 비밀값 없음), Docker에서 비-root 사용자로 실행

**이건 완전한 샌드박스가 아니다.** Python 수준의 방어라 결정적인 공격자는 우회할 수
있다. 참여자 코드로 들어오는 닫힌 수업 환경을 전제로 한 방어다. 공개 URL로 누구나
접근하게 할 계획이라면 컨테이너 격리로 바꿔야 한다.

macOS에서는 `RLIMIT_AS`(메모리)가 제대로 적용되지 않는다. Linux(Docker) 배포에서는
동작한다. 로컬 개발 중에는 타임아웃만 믿을 것.

## 레슨 추가

`data/lessons.json`에 항목을 추가한다. `check.type`은 다음 중 하나다:

- `none` — 자유 탐구
- `counts_keys` — 측정 결과 비트열 집합이 `keys`와 일치
- `counts_balanced` — `outcomes`가지 결과가 `tolerance` 안에서 고른 비율
- `circuit_contains` — 회로에 `gates`가 포함
- `stdout_contains` — 출력에 `needles`가 포함

판정은 실행 결과만 본다. 코드 문자열을 정규식으로 맞추지 않는다 — 같은 회로를 여러
방식으로 쓸 수 있기 때문이다.
