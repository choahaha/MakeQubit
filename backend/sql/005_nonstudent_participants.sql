-- ============================================================
-- 학생이 아닌 참여자(Q00, T00) + 그동안의 테스트 데이터 정리
-- 004_lock_analysis_views.sql 실행 후에 실행할 것
--
--   Q00  개발·점검용. 배포 후 스모크 테스트, 수업 전 동작 확인.
--   T00  교사용. 수업 전 레슨을 직접 따라가 보거나 수업 중 시연할 때.
--
-- 둘 다 is_test = true다. 분석 뷰가 알아서 걸러낸다 — 매번 손으로
-- 'Q00, T00 빼고'를 기억해야 하면 언젠가 한 번은 잊는다.
--
-- T00은 학생과 같은 화면을 쓴다. 교사 전용 기능(학생 진행 조회 등)은 없다.
-- ============================================================

-- 1) 테스트 참여자를 구분할 플래그
alter table public.participants
  add column if not exists is_test boolean not null default false;

-- 2) Q00(점검용), T00(교사용) 등록
--    cohort에 용도를 적어 둔다. 입장 화면 상단 칩에 그대로 표시된다 —
--    점검·시연 세션을 실제 수업으로 착각하지 않도록.
insert into public.participants (participant_code, cohort, is_test)
values
  ('Q00', '테스트', true),
  ('T00', '교사',   true)
on conflict (participant_code) do update
  set is_test = true,
      cohort  = excluded.cohort;

-- 3) 그동안 Q07, Q12로 남긴 테스트 데이터 삭제
--    (두 코드는 실제 명부에 속하므로 참여자 행 자체는 남긴다)
delete from public.code_runs
 where participant_id in (
   select id from public.participants where participant_code in ('Q07', 'Q12')
 );
delete from public.learning_events
 where participant_id in (
   select id from public.participants where participant_code in ('Q07', 'Q12')
 );
delete from public.reflections
 where participant_id in (
   select id from public.participants where participant_code in ('Q07', 'Q12')
 );

-- 4) 분석 뷰가 테스트 참여자를 제외하도록 재정의
--    security_invoker와 revoke를 다시 명시한다 — 004에서 잠근 설정을
--    replace가 조용히 되돌리는 일이 없도록.

create or replace view public.v_run_summary
with (security_invoker = on) as
select
  p.participant_code,
  p.group_label,
  r.lesson_id,
  count(*)                                                as total_runs,
  count(*) filter (where r.status = 'success')            as success_runs,
  count(*) filter (where r.status <> 'success')           as failed_runs,
  round(
    count(*) filter (where r.status <> 'success')::numeric
    / nullif(count(*), 0), 3
  )                                                       as error_rate,
  min(r.run_index) filter (where r.status = 'success')    as first_success_run,
  min(r.created_at)                                       as started_at,
  max(r.created_at)                                       as last_run_at,
  extract(epoch from (max(r.created_at) - min(r.created_at)))::int as span_sec
from public.code_runs r
join public.participants p on p.id = r.participant_id
where not p.is_test
group by p.participant_code, p.group_label, r.lesson_id;

create or replace view public.v_error_types
with (security_invoker = on) as
select
  r.lesson_id,
  r.error_type,
  count(*) as occurrences,
  count(distinct r.participant_id) as participants
from public.code_runs r
join public.participants p on p.id = r.participant_id
where r.status <> 'success'
  and not p.is_test
group by r.lesson_id, r.error_type
order by occurrences desc;

create or replace view public.v_run_deltas
with (security_invoker = on) as
select
  p.participant_code,
  r.lesson_id,
  r.run_index,
  r.status,
  length(r.code) as code_len,
  length(r.code) - lag(length(r.code)) over w as len_delta,
  extract(epoch from (r.created_at - lag(r.created_at) over w))::int as sec_since_prev
from public.code_runs r
join public.participants p on p.id = r.participant_id
where not p.is_test
window w as (partition by r.participant_id, r.lesson_id order by r.run_index);

create or replace view public.v_paste_events
with (security_invoker = on) as
select
  p.participant_code,
  e.lesson_id,
  e.client_ts,
  (e.payload ->> 'pasted_chars')::int as pasted_chars,
  e.payload ->> 'preview'             as preview
from public.learning_events e
join public.participants p on p.id = e.participant_id
where e.event_type = 'paste'
  and not p.is_test
order by e.client_ts;

revoke all on public.v_run_summary  from anon, authenticated;
revoke all on public.v_error_types  from anon, authenticated;
revoke all on public.v_run_deltas   from anon, authenticated;
revoke all on public.v_paste_events from anon, authenticated;

-- 학생이 아닌 참여자의 기록만 따로 볼 때 (점검용, Dashboard에서만)
create or replace view public.v_test_runs
with (security_invoker = on) as
select p.participant_code, p.cohort as purpose, r.lesson_id, r.run_index,
       r.status, r.error_type, r.execution_time_ms, r.created_at
from public.code_runs r
join public.participants p on p.id = r.participant_id
where p.is_test
order by r.created_at desc;

revoke all on public.v_test_runs from anon, authenticated;
