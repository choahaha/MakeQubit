-- ============================================================
-- MakeQubit 연구용 DB 스키마
-- Supabase Dashboard → SQL Editor에서 실행
--
-- 설계 원칙:
--  1. append-only. 학생 행동은 지우거나 고치지 않는다.
--  2. 익명. 실명 대신 참여자 코드(participant_code)만 저장한다.
--  3. 브라우저(anon key)는 insert만 가능하고 select는 불가능하다.
--     연구자는 Dashboard 또는 service_role 키로만 읽는다.
-- ============================================================

-- 1. participants — 참여자 (로그인 없음, 코드 입력만)
create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  participant_code text unique not null,   -- 예: 'A-07'. 실명 금지.
  group_label text,                        -- 실험/대조 등 연구 설계상의 집단
  cohort text,                             -- 예: '2026-1학기-3반'
  is_test boolean not null default false,  -- 개발·점검용 참여자(Q00). 분석 뷰에서 제외된다
  created_at timestamptz not null default now()
);

-- 2. learning_events — 학습 궤적 (세분화된 행동 로그)
create table if not exists public.learning_events (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  session_id uuid not null,        -- 페이지 로드당 1개 (클라이언트 생성)
  seq int not null,                -- 세션 내 단조 증가 (정렬은 seq 우선)
  lesson_id text,                  -- null = 레슨 밖에서 일어난 이벤트
  event_type text not null,        -- session_start, code_edit, paste, run_click, ...
  payload jsonb not null default '{}',
  client_ts timestamptz not null,  -- 브라우저 기준 발생 시각
  created_at timestamptz not null default now()
);

-- 3. code_runs — 실행 버전 스냅샷 (전체 코드 원문 포함)
--    learning_events의 run_click과 1:1로 대응하지만, 코드 원문이 크므로
--    별도 테이블로 분리한다. 이 테이블만으로 수정 과정을 재구성할 수 있다.
create table if not exists public.code_runs (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  session_id uuid not null,
  seq int not null,                -- 같은 세션의 learning_events.seq와 정렬 호환
  lesson_id text,
  run_index int not null,          -- 이 참여자의 이 레슨에서 몇 번째 실행인가
  code text not null,              -- 실행 시점의 코드 전문
  status text not null,            -- success | error | timeout | crashed
  error_type text,
  error_message text,
  error_line int,
  stdout text,
  counts jsonb,
  execution_time_ms int,
  created_at timestamptz not null default now()
);

-- 4. reflections — 레슨 종료 시 짧은 자기보고 (선택)
create table if not exists public.reflections (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  lesson_id text not null,
  prompt text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

-- ===== 인덱스 =====
create index if not exists idx_events_participant
  on public.learning_events(participant_id, client_ts);
create index if not exists idx_events_session
  on public.learning_events(session_id, seq);
create index if not exists idx_events_type
  on public.learning_events(event_type);
create index if not exists idx_runs_participant_lesson
  on public.code_runs(participant_id, lesson_id, run_index);
create index if not exists idx_runs_session
  on public.code_runs(session_id, seq);

-- ===== RLS =====
-- 브라우저는 anon 키를 들고 있다. insert만 열고 select/update/delete는 닫는다.
-- 참여자가 남의 데이터를 읽거나 자기 로그를 지울 수 없어야 한다.
alter table public.participants   enable row level security;
alter table public.learning_events enable row level security;
alter table public.code_runs      enable row level security;
alter table public.reflections    enable row level security;

drop policy if exists participants_insert on public.participants;
create policy participants_insert on public.participants
  for insert to anon, authenticated with check (true);

-- 참여자 코드로 자기 id를 되찾아야 하므로 participants만 select를 연다.
-- (코드 외 식별정보가 없으므로 노출 위험이 낮다)
drop policy if exists participants_select on public.participants;
create policy participants_select on public.participants
  for select to anon, authenticated using (true);

drop policy if exists events_insert on public.learning_events;
create policy events_insert on public.learning_events
  for insert to anon, authenticated with check (true);

drop policy if exists runs_insert on public.code_runs;
create policy runs_insert on public.code_runs
  for insert to anon, authenticated with check (true);

drop policy if exists reflections_insert on public.reflections;
create policy reflections_insert on public.reflections
  for insert to anon, authenticated with check (true);
