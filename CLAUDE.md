# MakeQubit

고등학생 대상 Qiskit 코딩 학습 플랫폼. **연구 도구**다 — 학생의 코드 수정 과정을
데이터로 남기는 것이 존재 이유이므로, 로깅을 깨뜨리는 변경은 기능 변경보다 무겁게 다룰 것.

## 지켜야 할 것

- **로깅 실패가 수업을 멈추면 안 된다.** Supabase가 죽어도 편집기와 실행은 동작해야 한다.
  `supabase`가 null이면 로깅만 조용히 꺼진다 (`src/lib/supabase.js`).
- **`learning_events.seq`는 세션 안에서 단조 증가한다.** 이벤트를 새로 추가할 때
  `logEvent()`를 거치지 않고 직접 insert하지 말 것. 순서 복원이 깨진다.
- **`code_runs`는 실행 때마다 코드 전문을 남긴다.** 용량을 아끼려고 diff로 바꾸지 말 것.
  분석 단계에서 전문이 필요하다.
- **RLS는 insert-only.** 브라우저에서 update/delete를 열지 말 것.
  `participants`의 select만 예외다 (코드로 자기 id를 찾아야 함).
- **참여자는 명부(`003_seed_participants.sql`)로만 생긴다.** `enterWithCode()`가
  없는 코드를 자동 생성하도록 되돌리지 말 것. 오타가 새 참여자를 만들면 한 학생의
  기록이 둘로 쪼개지고, 분석할 때가 되어서야 알게 된다.
- **분석 뷰를 새로 만들면 반드시 `security_invoker = on` + `revoke`를 붙일 것.**
  뷰는 기본적으로 RLS를 우회한다. 빠뜨리면 anon 키로 반 전체 데이터가 읽힌다.
- **동작 점검은 `Q00`, 교사 시연은 `T00`으로 한다.** 둘 다 `is_test = true`라
  분석 뷰에서 자동으로 빠진다. 실제 명부 코드(Q01~Q20)로 테스트하면 연구
  데이터가 오염되고, 오염된 걸 알아채는 시점은 분석할 때다.
- **자동 채점은 실행 결과만 본다** (`src/lib/check.js`). 코드 문자열 정규식 매칭을
  추가하지 말 것 — 같은 회로를 여러 방식으로 쓸 수 있고, 그걸 오답 처리하면
  데이터가 오염된다.

## 디자인

EduQubit(`/Users/h/EduQubit`)의 팔레트와 폰트를 따른다: primary `#6366f1`, Outfit,
Space Grotesk, `--radius: 1rem`. 다크모드는 없다 — 교실 조명 조건을 통제할 수 없고
연구에서 시각적 변수를 하나 줄이는 편이 낫다.

회로는 `src/lib/circuit-svg.js`가 SVG로 그린다. `qc.draw()`의 텍스트 그림은 박스 문자
(`┤├─`)가 폰트에 따라 끊겨서 쓰지 않는다 (백엔드가 보내는 `circuit_text`는 폴백용).

## 코드 실행

`backend/runner.py`(부모) → `backend/sandbox_child.py`(자식). 제한을 손볼 때:

- `sandbox_child.CPU_SECONDS` < `runner.WALL_TIMEOUT_SECONDS`를 유지할 것.
  뒤집히면 벽시계 타임아웃이 먼저 걸려 CPU 초과 메시지가 안 나온다.
- 학생 네임스페이스의 builtins만 제한한다. `builtins` 모듈 자체를 건드리면
  qiskit_aer 내부가 `open`을 못 찾아 깨진다 (실제로 겪은 문제).
- import 화이트리스트에 모듈을 추가할 때는 `DENIED_MODULES`가 먼저 검사된다는 걸 기억할 것.

## 스택

Vite + vanilla JS + Tailwind v4(`@theme`) + CodeMirror 6 / FastAPI + Qiskit + qiskit-aer /
Supabase (Postgres + RLS). 프레임워크(React 등)를 들이지 말 것 — EduQubit과 같은 스택을
유지해야 두 프로젝트를 오가며 유지보수할 수 있다.
