-- ============================================================
-- 분석 뷰를 브라우저(anon)로부터 잠근다 — 002 실행 후 반드시 실행할 것
--
-- PostgreSQL 뷰는 기본값이 security_invoker = off라서, 뷰 소유자 권한으로
-- 실행되며 기저 테이블의 RLS를 우회한다. 그래서 002를 그대로 두면 학생이
-- 브라우저 콘솔에서 anon 키로 v_paste_events를 읽어 반 전체의 붙여넣기
-- 기록과 코드 변화량을 볼 수 있다. 실제로 확인했다 (HTTP 200).
--
-- 두 겹으로 막는다:
--  1. security_invoker = on  → 뷰가 질의자의 RLS를 따르게 한다
--  2. revoke                 → anon/authenticated의 접근 자체를 회수한다
--
-- 연구자는 Supabase Dashboard 또는 service_role 키로 읽는다. 이 둘은
-- RLS를 우회하므로 그대로 동작한다.
-- ============================================================

alter view public.v_run_summary  set (security_invoker = on);
alter view public.v_error_types  set (security_invoker = on);
alter view public.v_run_deltas   set (security_invoker = on);
alter view public.v_paste_events set (security_invoker = on);

revoke all on public.v_run_summary  from anon, authenticated;
revoke all on public.v_error_types  from anon, authenticated;
revoke all on public.v_run_deltas   from anon, authenticated;
revoke all on public.v_paste_events from anon, authenticated;

-- 확인: anon 키로 아래를 호출하면 401 또는 빈 결과가 나와야 한다.
--   curl "$URL/rest/v1/v_paste_events?select=*" -H "apikey: $ANON_KEY"
