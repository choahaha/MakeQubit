-- ============================================================
-- 연구 분석용 뷰 — service_role(또는 Dashboard)로만 조회
-- 001_init.sql 실행 후에 실행할 것
--
-- 【중요】 뷰는 기본적으로 RLS를 우회한다(security_invoker = off).
-- 파일 끝의 잠금 구문을 빼먹으면 학생이 anon 키로 반 전체 데이터를 읽을 수 있다.
-- ============================================================

-- 참여자별·레슨별 요약: 실행 횟수, 오류율, 첫 성공까지 걸린 실행 수
create or replace view public.v_run_summary as
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
group by p.participant_code, p.group_label, r.lesson_id;

-- 오류 유형 분포 — 어떤 개념에서 막히는지 보는 용도
create or replace view public.v_error_types as
select
  r.lesson_id,
  r.error_type,
  count(*) as occurrences,
  count(distinct r.participant_id) as participants
from public.code_runs r
where r.status <> 'success'
group by r.lesson_id, r.error_type
order by occurrences desc;

-- 연속 실행 사이의 코드 변화량 — 미세 수정 vs 대규모 재작성 구분
create or replace view public.v_run_deltas as
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
window w as (partition by r.participant_id, r.lesson_id order by r.run_index);

-- 붙여넣기 이벤트 — 코드 출처 추적
create or replace view public.v_paste_events as
select
  p.participant_code,
  e.lesson_id,
  e.client_ts,
  (e.payload ->> 'pasted_chars')::int as pasted_chars,
  e.payload ->> 'preview'             as preview
from public.learning_events e
join public.participants p on p.id = e.participant_id
where e.event_type = 'paste'
order by e.client_ts;


-- ===== 브라우저로부터 잠그기 =====
-- 이 블록을 빼면 anon 키로 반 전체의 붙여넣기 기록까지 읽힌다.
alter view public.v_run_summary  set (security_invoker = on);
alter view public.v_error_types  set (security_invoker = on);
alter view public.v_run_deltas   set (security_invoker = on);
alter view public.v_paste_events set (security_invoker = on);

revoke all on public.v_run_summary  from anon, authenticated;
revoke all on public.v_error_types  from anon, authenticated;
revoke all on public.v_run_deltas   from anon, authenticated;
revoke all on public.v_paste_events from anon, authenticated;
