-- 2026-10-19: mniej zapytań do Barabash AI — cron raz na godzinę; raport w toku woła kolejny krok sam (smart_kick)
create or replace function public.smart_kick() returns void
language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://kltggicuonljcgyehcev.supabase.co/functions/v1/smart-report',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-internal-token', (select value from public.app_secrets where key = 'INTERNAL_TOKEN')),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 150000);
$$;
revoke all on function public.smart_kick() from public, anon, authenticated;
grant execute on function public.smart_kick() to service_role;
select cron.alter_job((select jobid from cron.job where jobname = 'smart-report'), schedule := '7 * * * *');
update public.app_secrets set value = 'qwen3.8:27b-q4_K_M' where key = 'BARABASH_AI_MODEL';
