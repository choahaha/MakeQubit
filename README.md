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

Supabase Dashboard → SQL Editor에서 순서대로 실행한다:

1. `backend/sql/001_init.sql` — 테이블과 RLS
2. `backend/sql/002_analysis_views.sql` — 연구 분석용 뷰
3. `backend/sql/003_seed_participants.sql` — 참여자 명부 (Q01~Q20)
4. `backend/sql/004_lock_analysis_views.sql` — 분석 뷰 잠금 (이미 배포된 DB 보수용)
5. `backend/sql/005_nonstudent_participants.sql` — `Q00`(점검용) · `T00`(교사용) + 테스트 데이터 정리
6. `backend/sql/006_circuit_spec.sql` — 회로 구조 저장 + 개념 오류 분석용 뷰
7. `backend/sql/007_submissions.sql` — 명시적 제출 (`answer_submitted`)

`004`, `005`는 `001`~`003`을 이미 돌린 DB를 보수하기 위한 것이다. 새 DB라면
`001`~`003`만 돌려도 같은 상태가 된다 (`002`에 잠금과 필터가 들어 있다).

**학생이 아닌 코드가 둘 있다.**

| 코드 | 용도 |
|---|---|
| `Q00` | 개발·점검용. 배포 후 스모크 테스트, 수업 전 동작 확인 |
| `T00` | 교사용. 수업 전 레슨을 직접 따라가 보거나 수업 중 시연 |

둘 다 `is_test = true`라 분석 뷰가 자동으로 걸러낸다. 이 코드로 들어가면 화면
상단 칩이 주황색으로 바뀌고 용도가 표시되므로, 점검·시연 세션을 실제 수업으로
착각할 일이 없다. 이 기록만 따로 보려면 `v_test_runs`를 조회한다.

`T00`은 학생과 같은 화면을 쓴다. 교사 전용 기능(학생 진행 조회 등)은 없다.

**뷰는 RLS를 우회한다.** PostgreSQL 뷰의 기본값(`security_invoker = off`)은 뷰
소유자 권한으로 실행되므로, 잠그지 않으면 학생이 anon 키로 `v_paste_events`를
읽어 반 전체의 붙여넣기 기록을 볼 수 있다. `002`에 잠금 구문이 포함되어 있고,
`004`는 이미 배포된 DB를 고치기 위한 것이다.

**참여자는 명부에만 있다.** 명부에 없는 코드로는 입장할 수 없고, 학생이 코드를
잘못 쳐도 새 참여자가 생기지 않는다. 오타 하나로 한 학생의 3주 기록이 둘로
쪼개지는 것을 막기 위해서다. 인원이 다르면 `003`의 목록을 고쳐서 실행한다.

RLS는 브라우저(anon 키)에 **insert만** 허용한다. 학생이 남의 로그를 읽거나 자기 로그를
지울 수 없다. 연구자는 Dashboard 또는 service_role 키로만 읽는다.

## 수집되는 데이터

| 테이블 | 내용 |
|---|---|
| `participants` | 참여자 코드 (실명·학번 없음). 사전 등록된 명부만 존재 |
| `learning_events` | lesson_open, code_edit, paste, run_click, run_result, hint_open, check_result, reset_code, lesson_leave |
| `code_runs` | 실행할 때마다의 **코드 전문**, **회로 구조**, 상태, 오류 유형/줄, 출력, counts, 실행 시간 |
| `submissions` | 학생이 선언한 최종 답 — 코드 전문, 설명, 제출 시점의 통과 여부·실행 수·힌트 수 |
| `reflections` | (구) 레슨 종료 시 자기보고. 제출이 대체했다 |

`code_runs`만으로 한 학생이 코드를 어떻게 고쳐 나갔는지 순서대로 재구성할 수 있다.
`circuit_spec`에 게이트 시퀀스가 들어 있어, counts만으로는 안 보이는 개념 오류
(CNOT 방향 반전, H 위치 오류, 요구와 다른 큐비트 수, 게이트 누락)를 사후에
질의할 수 있다 — `v_circuit_ops`, `v_circuit_shape` 참고.
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

### 학생은 아무것도 설치하지 않는다

IBM Quantum 교실 자료는 학생 각자의 Python 환경에 `qiskit`, `qiskit-ibm-runtime`,
`qiskit-aer`, `qiskit.visualization`, `numpy`, `pylatexenc`를 설치하라고 안내한다.
그건 로컬 Jupyter 방식일 때의 요구사항이고, MakeQubit에는 해당하지 않는다.
코드는 서버에서 실행되고 학생은 브라우저만 있으면 된다.

서버에 설치되는 것과 그 이유:

| 패키지 | 상태 | 이유 |
|---|---|---|
| `qiskit` | 2.1+ | 회로 작성 |
| `qiskit-aer` | 0.17+ | 시뮬레이션 |
| `numpy` | 1.26+ | 학생이 쓸 수 있게 |
| `qiskit-ibm-runtime` | **없음** | 실제 하드웨어는 쓰지 않는다. 대기시간과 장비 상태가 학생마다 달라져 수행 자료의 비교 가능성이 깨진다. 샌드박스가 네트워크 모듈도 막는다 |
| `qiskit.visualization`, `pylatexenc`, `matplotlib` | **없음** | matplotlib Figure를 브라우저로 보낼 수단이 없다. 측정 히스토그램과 회로는 프론트엔드가 그린다 |

`plot_histogram`이나 `qc.draw("mpl")`을 쓰면 "여기서는 그림을 직접 그리지 않아요.
실행하면 오른쪽에 자동으로 나와요"라는 안내가 뜬다. 조용한 무반응이나
`ModuleNotFoundError`보다 낫다.

### 격리의 한계

**이건 완전한 샌드박스가 아니다.** Python 수준의 방어라 결정적인 공격자는 우회할 수
있다. 참여자 코드로 들어오는 닫힌 수업 환경을 전제로 한 방어다. 공개 URL로 누구나
접근하게 할 계획이라면 컨테이너 격리로 바꿔야 한다.

macOS에서는 `RLIMIT_AS`(메모리)가 제대로 적용되지 않는다. Linux(Docker) 배포에서는
동작한다. 로컬 개발 중에는 타임아웃만 믿을 것.

배포 절차와 배포 전 점검은 [DEPLOY.md](DEPLOY.md)를 볼 것.

## 연구자 화면 (`/admin.html`)

학생 데이터는 RLS 때문에 브라우저에서 읽을 수 없다. 읽으려면 `service_role` 키가
필요한데 그 키는 RLS를 통째로 우회하므로, 조회는 전부 `backend/admin.py`를 거친다.
키는 서버에만 두고 브라우저는 `ADMIN_TOKEN`으로 인증한다.

```
backend/.env
  SUPABASE_SERVICE_KEY=   # Dashboard → Settings → API → service_role
  ADMIN_TOKEN=            # 이것과 반드시 다른, 무작위 문자열
```

**`ADMIN_TOKEN`에 service_role 키를 넣지 말 것.** 그 값은 브라우저에 입력되고
sessionStorage에 남고 요청 헤더로 매번 오간다. 그게 곧 DB 전체 권한이 되면
연구자 화면을 여는 것만으로 키가 새어 나간다.

기본적으로 테스트 참여자(`Q00`, `T00`)는 모든 통계에서 빠진다. 헤더의
'테스트 계정 포함'을 켜면 점검 기록도 볼 수 있다.

## 피드백 수준

연구가 보려는 것이 문제해결 과정이므로, 플랫폼이 먼저 답을 주면 그 과정이 사라진다.
네 단계로 나눠 두었다.

| 상황 | 무엇을 보여주는가 |
|---|---|
| 실행 오류 | Python/Qiskit 오류를 줄 번호까지, 자주 나오는 것은 한국어로 번역 |
| 개념 오류 | **관찰된 사실만.** "00과 11만 나와야 하는데 아직 다른 결과가 섞여 있어요" — 원인은 지목하지 않는다 |
| 힌트 요청 | 3단계, 마지막이 정답. 몇 번째 힌트를 언제 열었는지 기록된다 |
| 제출 후 | 정답 코드와 해설 (`solution`). 제출 전에는 열리지 않는다 |

`check.message`에 "CX가 빠졌을 수 있어요" 같은 원인 지목을 다시 넣지 말 것.
학생이 힌트를 요청하는지 스스로 고치는지가 이 연구의 관심사인데, 플랫폼이
먼저 알려주면 그 분기가 데이터에서 사라진다.

## 레슨 추가

`data/lessons.json`에 항목을 추가한다. `check.type`은 다음 중 하나다:

- `none` — 자유 탐구
- `counts_total_min` — 최소 `min`번 이상 측정 (shots를 늘렸는지)
- `circuit_ops` — 회로에 `ops`의 연산이 있는가 (`{"name":"cx","qubits":[1,0]}`)
- `counts_keys` — 측정 결과 비트열 집합이 `keys`와 일치
- `counts_balanced` — `outcomes`가지 결과가 `tolerance` 안에서 고른 비율
- `circuit_contains` — 회로에 `gates`가 포함
- `stdout_contains` — 출력에 `needles`가 포함

`check`에 배열을 주면 전부 만족해야 통과한다. 첫 실패만 학생에게 보여준다.

판정은 실행 결과만 본다. 코드 문자열을 정규식으로 맞추지 않는다 — 같은 회로를 여러
방식으로 쓸 수 있기 때문이다.

**레슨을 추가하면 두 가지를 반드시 확인할 것:**
1. 정답이 판정을 통과하는가
2. **시작 코드가 그냥 통과하지는 않는가** — 이걸 빼먹으면 학생이 실행 버튼만
   눌러도 "목표 달성"이 뜬다. 실제로 세 레슨에서 이 일이 있었다. `counts`로
   확인할 수 없는 레슨(Z만 건 회로, 방향을 뒤집은 CX)은 `circuit_ops`로 게이트
   자체를 봐야 한다.

## 수업 분량

3주 × 2차시 × 50분 = 300분. 실습 시간은 200~240분으로 잡고 레슨 16개를 배치했다.

| | 레슨 | 성격 |
|---|---|---|
| 1주 1차시 | L01~L03 | 큐비트·중첩·측정. 편집기 적응 포함 |
| 1주 2차시 | L04~L06 | 확정 게이트, 측정이 못 보는 차이 |
| 2주 1차시 | L07~L09 | 간섭과 위상 (H-Z-H) |
| 2주 2차시 | L10~L12 | 두 큐비트, 얽힘, CX 방향 |
| 3주 1차시 | L13~L14 | **직접 설계** — 조건만 주고 회로를 짠다 |
| 3주 2차시 | L15~L16 | 큐비트 확장, 자유 탐구 |

앞은 빈칸 채우기, 뒤로 갈수록 설계형이다. 3주차 레슨은 시작 코드에 게이트가
하나도 없다.
