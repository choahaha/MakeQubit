-- ============================================================
-- 차시별 형성평가 응답
-- 007 실행 후에 실행할 것
--
-- 제출 화면의 자유 서술("이 코드가 어떻게 동작하는지 써 줘")은 학생이
-- 무엇을 써야 할지 모르고 연구 쪽에서도 채점이 안 됐다. 차시마다
-- 회로 이해 · 결과 예측 · 오류 수정 세 유형의 객관식으로 바꿨다.
--
-- 문항 하나가 한 행이다. 어느 유형에서 막히는지, 얼마나 오래 고민했는지,
-- 무엇을 골랐는지(오답 선택지가 곧 오개념 단서다)가 남는다.
-- ============================================================

create table if not exists public.assessment_responses (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants(id) on delete cascade,
  session_id uuid not null,
  seq int not null,
  week int not null,
  session int not null,
  item_id text not null,          -- 'a11-2'
  item_type text not null,        -- 회로 이해 | 결과 예측 | 오류 수정
  picked int not null,            -- 고른 선택지 번호 (0부터)
  correct boolean not null,
  ms_to_answer int,
  created_at timestamptz not null default now()
);

create index if not exists idx_assess_participant
  on public.assessment_responses(participant_id, week, session);
create index if not exists idx_assess_item
  on public.assessment_responses(item_id);

alter table public.assessment_responses enable row level security;

drop policy if exists assessment_insert on public.assessment_responses;
create policy assessment_insert on public.assessment_responses
  for insert to anon, authenticated with check (true);

-- 문항별 정답률 — 어느 문항이 어려웠는가
create or replace view public.v_item_difficulty
with (security_invoker = on) as
select
  a.week, a.session, a.item_id, a.item_type,
  count(*)                                              as responses,
  count(*) filter (where a.correct)                     as correct_count,
  round(count(*) filter (where a.correct)::numeric
        / nullif(count(*), 0), 3)                       as correct_rate,
  round(avg(a.ms_to_answer) / 1000.0, 1)                as avg_seconds
from public.assessment_responses a
join public.participants p on p.id = a.participant_id
where not p.is_test
group by a.week, a.session, a.item_id, a.item_type
order by correct_rate;

-- 오답 선택지 분포 — 어떤 오개념을 갖고 있는가
create or replace view public.v_item_distractors
with (security_invoker = on) as
select
  a.item_id, a.picked, a.correct,
  count(*) as chosen_by
from public.assessment_responses a
join public.participants p on p.id = a.participant_id
where not p.is_test
group by a.item_id, a.picked, a.correct
order by a.item_id, chosen_by desc;

-- 유형별 성취 — 회로 이해 / 결과 예측 / 오류 수정 중 어디가 약한가
create or replace view public.v_type_mastery
with (security_invoker = on) as
select
  p.participant_code,
  a.item_type,
  count(*)                                              as answered,
  count(*) filter (where a.correct)                     as correct_count,
  round(count(*) filter (where a.correct)::numeric
        / nullif(count(*), 0), 3)                       as correct_rate
from public.assessment_responses a
join public.participants p on p.id = a.participant_id
where not p.is_test
group by p.participant_code, a.item_type;

revoke all on public.v_item_difficulty  from anon, authenticated;
revoke all on public.v_item_distractors from anon, authenticated;
revoke all on public.v_type_mastery     from anon, authenticated;
