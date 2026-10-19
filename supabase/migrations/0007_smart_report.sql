-- Raport AI kampanii: kopia notatek/aktywności/dealów z Pipedrive, analiza AI każdego leada (cache), zlecenia raportów.
-- Dostęp tylko service_role (RLS bez polityk). Liczy edge `smart-report` (Barabash AI), panel czyta przez admin-api.

-- notatki ręczne + notatki aktywności handlowców (notatki Ringostat AI trafiają do rs_calls)
create table if not exists public.pd_notes (
  id text primary key,              -- n<id> (notatka) / a<id> (aktywność)
  kind text not null,               -- note / activity
  pd_lead_id text,
  pd_deal_id bigint,
  pd_person_id bigint,
  user_id bigint,
  author text,
  at timestamptz,
  subject text,
  act_type text,
  done boolean,
  text text,
  synced_at timestamptz default now()
);
create index if not exists pd_notes_lead_idx on public.pd_notes (pd_lead_id);
create index if not exists pd_notes_person_idx on public.pd_notes (pd_person_id);
alter table public.pd_notes enable row level security;

create table if not exists public.pd_deals (
  id bigint primary key,
  person_id bigint,
  title text,
  status text,                      -- open / won / lost
  value numeric,
  currency text,
  pipeline_id int,
  stage_id int,
  stage_name text,
  lost_reason text,
  add_time timestamptz,
  won_time timestamptz,
  lost_time timestamptz,
  update_time timestamptz
);
create index if not exists pd_deals_person_idx on public.pd_deals (person_id);
alter table public.pd_deals enable row level security;

-- wynik analizy AI jednego leada (przeliczany, gdy zmieni się dossier)
create table if not exists public.lead_insights (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  hash text not null,
  source text not null,             -- llm / rule
  model text,
  status text,                      -- kupil / goracy / cieply / zimny / niezainteresowany / nieosiagalny / bledny / brak_kontaktu
  interest int,
  price text,
  quality text,
  intent text,
  objections text[],
  result jsonb,
  error text,
  analyzed_at timestamptz default now()
);
alter table public.lead_insights enable row level security;

create table if not exists public.ai_reports (
  id uuid primary key default gen_random_uuid(),
  created_by text,
  params jsonb not null,            -- {from, to, campaigns[]}
  status text not null default 'queued',  -- queued / analyzing / summarizing / done / error
  progress jsonb default '{}'::jsonb,
  data jsonb,                       -- liczby (deterministyczne)
  result jsonb,                     -- wnioski AI per kampania + całość
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  finished_at timestamptz
);
create index if not exists ai_reports_created_idx on public.ai_reports (created_at desc);
alter table public.ai_reports enable row level security;

-- dossier leadów: formularz, rozmowy (z podsumowaniami AI), komentarze handlowców, dealy
create or replace function public.smart_dossiers(p_ids uuid[] default null, p_since timestamptz default null)
returns table (lead_id uuid, d jsonb)
language sql stable security definer set search_path = public as $$
  select l.id,
    jsonb_build_object(
      'campaign', coalesce(nullif(l.campaign_name, ''), l.form_name),
      'form', l.form_name, 'adset', l.adset_name, 'ad', l.ad_name, 'page', l.page_name,
      'received_at', l.received_at, 'name', l.full_name, 'fields', l.field_data,
      'pd_lead', l.pipedrive_lead_id, 'pd_person', l.pipedrive_person_id,
      'calls', (select jsonb_build_object(
          'n', count(*),
          'out', count(*) filter (where c.call_type in ('out', 'callback')),
          'answered', count(*) filter (where c.answered),
          'talk', coalesce(sum(c.billsec) filter (where c.answered), 0),
          'first_out', min(c.calldate) filter (where c.call_type in ('out', 'callback')),
          'employees', array_remove(array_agg(distinct c.employee_fio), null))
        from rs_calls c
        where c.phone9 = public.rs_phone9(l.phone) and c.calldate >= l.received_at - interval '1 day'),
      'ai', (select jsonb_agg(jsonb_build_object('at', c.calldate, 'emp', c.employee_fio, 'sec', c.billsec,
              'summary', c.ai_summary, 'mood', c.ai->>'client_mood') order by c.calldate)
        from rs_calls c
        where c.phone9 = public.rs_phone9(l.phone) and c.calldate >= l.received_at - interval '1 day' and c.ai_summary is not null),
      'notes', (select jsonb_agg(jsonb_build_object('id', n.id, 'at', n.at, 'author', n.author, 'kind', n.kind,
              'type', n.act_type, 'subject', n.subject, 'done', n.done, 'text', n.text) order by n.at)
        from pd_notes n
        where (n.pd_lead_id = l.pipedrive_lead_id or n.pd_person_id = l.pipedrive_person_id)
          and n.at >= l.received_at - interval '1 day'),
      'deals', (select jsonb_agg(jsonb_build_object('id', d.id, 'status', d.status, 'value', d.value, 'currency', d.currency,
              'stage', d.stage_name, 'lost_reason', d.lost_reason, 'won_time', d.won_time) order by d.add_time)
        from pd_deals d where d.person_id = l.pipedrive_person_id and d.add_time >= l.received_at - interval '1 day')
    )
  from leads l
  where l.status <> 'skipped'
    and (p_ids is null or l.id = any(p_ids))
    and (p_since is null or l.received_at >= p_since)
  order by l.received_at desc, l.id
$$;

-- jeden worker naraz (zamek z TTL w settings)
create or replace function public.smart_try_lock(p_ttl int default 150) returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into settings(key, value) values ('smart_lock', to_jsonb(now()::text))
  on conflict (key) do update set value = excluded.value
    where (settings.value #>> '{}')::timestamptz < now() - make_interval(secs => p_ttl)
  returning true into ok;
  return coalesce(ok, false);
end $$;
create or replace function public.smart_unlock() returns void
language sql security definer set search_path = public as $$
  update settings set value = to_jsonb('2000-01-01T00:00:00Z'::text) where key = 'smart_lock'
$$;
revoke all on function public.smart_try_lock(int) from public, anon, authenticated;
revoke all on function public.smart_unlock() from public, anon, authenticated;
grant execute on function public.smart_try_lock(int) to service_role;
grant execute on function public.smart_unlock() to service_role;

revoke all on function public.smart_dossiers(uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.smart_dossiers(uuid[], timestamptz) to service_role;

-- worker co minutę: synchronizacja Pipedrive, analiza nowych/zmienionych leadów, zlecone raporty
select cron.unschedule(jobid) from cron.job where jobname = 'smart-report';
select cron.schedule('smart-report', '* * * * *', $$
  select net.http_post(
    url := 'https://kltggicuonljcgyehcev.supabase.co/functions/v1/smart-report',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-internal-token', (select value from public.app_secrets where key = 'INTERNAL_TOKEN')),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 150000)
$$);
