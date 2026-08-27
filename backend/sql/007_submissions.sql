-- ============================================================
-- 명시적 제출 (answer_submitted)
-- 006 실행 후에 실행할 것
--
-- 통과 판정과 제출은 다르다. 통과는 플랫폼이 내리는 판정이고, 제출은
-- 학생이 "이게 내 답이다"라고 선언하는 행위다. 못 푼 채로 제출할 수도
-- 있고(그것도 데이터다), 통과한 뒤 더 만져 보고 제출할 수도 있다.
--
-- 재제출을 막지 않는다. submission_index로 몇 번째 답인지 구분한다.
-- ============================================================

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  session_id uuid not null,
  seq int not null,
  lesson_id text not null,
  submission_index int not null,     -- 이 레슨에서 몇 번째 제출인가
  code text not null,                -- 제출 시점의 코드 전문
  answer text,                       -- 학생이 쓴 설명
  passed boolean not null,           -- 제출 시점에 목표를 달성한 상태였는가
  runs int not null,                 -- 제출까지의 실행 횟수
  hints_shown int not null,          -- 제출까지 연 힌트 수
  seconds_on_lesson int,
  created_at timestamptz not null default now()
);

create index if not exists idx_submissions_participant
  on public.submissions(participant_id, lesson_id, submission_index);
create index if not exists idx_submissions_session
  on public.submissions(session_id, seq);

alter table public.submissions enable row level security;

drop policy if exists submissions_insert on public.submissions;
create policy submissions_insert on public.submissions
  for insert to anon, authenticated with check (true);

-- 레슨별 최종 수행 수준 — 마지막 제출 하나만
create or replace view public.v_final_submissions
with (security_invoker = on) as
select distinct on (s.participant_id, s.lesson_id)
  p.participant_code,
  p.group_label,
  s.lesson_id,
  s.submission_index as total_submissions,
  s.passed,
  s.runs,
  s.hints_shown,
  s.seconds_on_lesson,
  length(s.code)  as code_len,
  length(coalesce(s.answer, '')) as answer_len,
  s.answer,
  s.created_at    as submitted_at
from public.submissions s
join public.participants p on p.id = s.participant_id
where not p.is_test
order by s.participant_id, s.lesson_id, s.submission_index desc;

-- 통과했는데도 제출하지 않은 경우 / 제출했지만 미통과인 경우를 본다
create or replace view public.v_submission_gap
with (security_invoker = on) as
select
  p.participant_code,
  r.lesson_id,
  max(r.run_index)                                    as runs,
  bool_or(r.status = 'success')                       as ever_ran_clean,
  (select count(*) from public.submissions s
     where s.participant_id = r.participant_id
       and s.lesson_id = r.lesson_id)                 as submissions,
  (select bool_or(s.passed) from public.submissions s
     where s.participant_id = r.participant_id
       and s.lesson_id = r.lesson_id)                 as ever_submitted_passing
from public.code_runs r
join public.participants p on p.id = r.participant_id
where not p.is_test
group by p.participant_code, r.participant_id, r.lesson_id;

revoke all on public.v_final_submissions from anon, authenticated;
revoke all on public.v_submission_gap    from anon, authenticated;
