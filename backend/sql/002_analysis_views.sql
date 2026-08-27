-- ============================================================
-- 연구 분석용 뷰 — service_role(또는 Dashboard)로만 조회
-- 001_init.sql 실행 후에 실행할 것
--
-- 【중요 1】 뷰는 기본적으로 RLS를 우회한다(security_invoker = off).
-- 잠금 구문을 빼먹으면 학생이 anon 키로 반 전체 데이터를 읽을 수 있다.
--
-- 【중요 2】 모든 뷰는 is_test 참여자(Q00 등)를 제외한다. 점검용 실행이
-- 분석 결과에 섞이지 않도록, 손으로 걸러내지 말고 뷰가 걸러내게 한다.
-- ============================================================

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

-- 테스트 참여자까지 포함해서 봐야 할 때 (동작 점검용, Dashboard에서만)
create or replace view public.v_test_runs
with (security_invoker = on) as
select p.participant_code, r.lesson_id, r.run_index, r.status,
       r.error_type, r.execution_time_ms, r.created_at
from public.code_runs r
join public.participants p on p.id = r.participant_id
where p.is_test
order by r.created_at desc;

revoke all on public.v_test_runs from anon, authenticated;

-- 실행 하나를 게이트 한 줄씩으로 펼친다. 개념 오류는 여기서 질의한다.
--   예) CNOT 방향 반전:  where name = 'cx' and qubits = '[1, 0]'
--   예) 얽힘 회로에 CX 누락: 레슨별로 name='cx' 행이 없는 run_index 찾기
--   예) 요구와 다른 큐비트 수: num_qubits <> 기대값
create or replace view public.v_circuit_ops
with (security_invoker = on) as
select
  p.participant_code,
  r.lesson_id,
  r.run_index,
  r.status,
  (r.circuit_spec ->> 'num_qubits')::int as num_qubits,
  (r.circuit_spec ->> 'num_clbits')::int as num_clbits,
  op.ord,
  op.value ->> 'name'   as name,
  op.value -> 'qubits'  as qubits,
  op.value -> 'clbits'  as clbits,
  r.created_at
from public.code_runs r
join public.participants p on p.id = r.participant_id
cross join lateral jsonb_array_elements(coalesce(r.circuit_spec -> 'ops', '[]'::jsonb))
  with ordinality as op(value, ord)
where not p.is_test
order by r.created_at, op.ord;

-- 실행별 회로 요약 — 게이트 구성을 한 줄로 본다
create or replace view public.v_circuit_shape
with (security_invoker = on) as
select
  p.participant_code,
  r.lesson_id,
  r.run_index,
  r.status,
  (r.circuit_spec ->> 'num_qubits')::int as num_qubits,
  (select string_agg(o ->> 'name', ' → ' order by ord)
     from jsonb_array_elements(coalesce(r.circuit_spec -> 'ops', '[]'::jsonb))
          with ordinality as t(o, ord))            as gate_sequence,
  (select count(*) from jsonb_array_elements(coalesce(r.circuit_spec -> 'ops', '[]'::jsonb))
     as t(o) where o ->> 'name' = 'cx')            as cx_count,
  (select count(*) from jsonb_array_elements(coalesce(r.circuit_spec -> 'ops', '[]'::jsonb))
     as t(o) where o ->> 'name' = 'h')             as h_count,
  (select count(*) from jsonb_array_elements(coalesce(r.circuit_spec -> 'ops', '[]'::jsonb))
     as t(o) where o ->> 'name' = 'measure')       as measure_count,
  r.created_at
from public.code_runs r
join public.participants p on p.id = r.participant_id
where not p.is_test
order by r.created_at;

revoke all on public.v_circuit_ops   from anon, authenticated;
revoke all on public.v_circuit_shape from anon, authenticated;
