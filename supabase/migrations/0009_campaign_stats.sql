-- 2026-11-16: zakładka «Kampanie» — statystyki kampanii FB (leady, wydatki, CPL) + komentarz AI.
-- Wydatki z Meta Marketing API (insights per grupa reklam per dzień) → fb_insights (edge campaign-stats, cron co 3 h).
-- Leady liczone z naszej tabeli leads (to, co realnie wpadło), jakość z rs_calls / pd_notes / lead_insights.

create table if not exists public.fb_insights (
  date date not null,
  adset_id text not null,
  ad_account_id text,
  campaign_id text,
  campaign_name text,
  adset_name text,
  objective text,
  currency text,
  spend numeric not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,        -- inline_link_clicks
  fb_leads int not null default 0,         -- leady wg Meta (actions: lead)
  synced_at timestamptz default now(),
  primary key (date, adset_id)
);
create index if not exists fb_insights_campaign on public.fb_insights (campaign_id, date);
alter table public.fb_insights enable row level security;

create table if not exists public.campaign_ai_notes (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,                -- from|to|hash danych → cache
  params jsonb not null,
  input jsonb,
  status text not null default 'queued',   -- queued / running / done / error
  result jsonb,
  error text,
  created_by text,
  created_at timestamptz default now(),
  finished_at timestamptz
);
alter table public.campaign_ai_notes enable row level security;

create index if not exists leads_created_time on public.leads (created_time);

-- Wszystkie agregaty okresu w SQL (PostgREST ma max_rows=1000).
create or replace function public.cs_stats(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public as $$
with l as (
  select l.id, l.campaign_id, l.campaign_name, l.adset_id, l.adset_name,
         (l.created_time at time zone 'Europe/Warsaw')::date as d,
         exists (select 1 from rs_calls c where c.lead_id = l.id) as called,
         exists (select 1 from rs_calls c where c.lead_id = l.id and c.answered) as answered,
         exists (select 1 from pd_notes n where l.pipedrive_lead_id is not null and n.pd_lead_id = l.pipedrive_lead_id) as noted,
         i.status as st, i.source as src
  from leads l
  left join lead_insights i on i.lead_id = l.id
  where l.created_time >= (p_from::timestamp at time zone 'Europe/Warsaw')
    and l.created_time <  ((p_to + 1)::timestamp at time zone 'Europe/Warsaw')
    and l.status <> 'skipped'
),
lk as (
  select coalesce(campaign_id, 'name:' || coalesce(campaign_name, '(nieznana)')) as cid,
         coalesce(adset_id, 'name:' || coalesce(adset_name, '(nieznana)')) as aid, *
  from l
),
f as (
  select * from fb_insights where date between p_from and p_to
),
camp_l as (
  select cid, max(campaign_name) as name, count(*) as leads,
         count(*) filter (where called or noted) as contacted,
         count(*) filter (where answered) as answered,
         count(*) filter (where src = 'llm') as analyzed,
         count(*) filter (where st in ('goracy','kupil')) as hot,
         count(*) filter (where st = 'kupil') as bought,
         count(*) filter (where st = 'bledny') as bad,
         min(d) as first_lead, max(d) as last_lead
  from lk group by cid
),
camp_f as (
  select campaign_id as cid, max(campaign_name) as name, max(objective) as objective,
         sum(spend) as spend, sum(impressions) as impressions, sum(reach) as reach,
         sum(clicks) as clicks, sum(fb_leads) as fb_leads,
         max(date) filter (where spend > 0) as last_spend
  from f group by campaign_id
),
camps as (
  select coalesce(cl.cid, cf.cid) as campaign_id, coalesce(cf.name, cl.name, '(nieznana)') as campaign_name,
         cf.objective,
         coalesce(cl.leads, 0) as leads, coalesce(cl.contacted, 0) as contacted, coalesce(cl.answered, 0) as answered,
         coalesce(cl.analyzed, 0) as analyzed, coalesce(cl.hot, 0) as hot, coalesce(cl.bought, 0) as bought, coalesce(cl.bad, 0) as bad,
         cl.first_lead, cl.last_lead,
         cf.spend, cf.impressions, cf.reach, cf.clicks, cf.fb_leads, cf.last_spend
  from camp_l cl full join camp_f cf on cf.cid = cl.cid
),
ads_l as (
  select cid, aid, max(adset_name) as name, count(*) as leads,
         count(*) filter (where called or noted) as contacted,
         count(*) filter (where st in ('goracy','kupil')) as hot,
         count(*) filter (where st = 'kupil') as bought,
         count(*) filter (where st = 'bledny') as bad
  from lk group by cid, aid
),
ads_f as (
  select campaign_id as cid, adset_id as aid, max(adset_name) as name,
         sum(spend) as spend, sum(impressions) as impressions, sum(clicks) as clicks, sum(fb_leads) as fb_leads
  from f group by campaign_id, adset_id
),
adsets as (
  select coalesce(al.cid, af.cid) as campaign_id, coalesce(al.aid, af.aid) as adset_id,
         coalesce(af.name, al.name, '(nieznana)') as adset_name,
         coalesce(al.leads, 0) as leads, coalesce(al.contacted, 0) as contacted, coalesce(al.hot, 0) as hot,
         coalesce(al.bought, 0) as bought, coalesce(al.bad, 0) as bad,
         af.spend, af.impressions, af.clicks, af.fb_leads
  from ads_l al full join ads_f af on af.cid = al.cid and af.aid = al.aid
),
days as (
  select g::date as date,
         (select count(*) from l where l.d = g::date) as leads,
         (select count(*) from l where l.d = g::date and l.st in ('goracy','kupil')) as hot,
         (select sum(spend) from f where f.date = g::date) as spend,
         (select sum(fb_leads) from f where f.date = g::date) as fb_leads
  from generate_series(p_from, p_to, interval '1 day') g
)
select jsonb_build_object(
  'campaigns', coalesce((select jsonb_agg(to_jsonb(c) order by c.leads desc, c.spend desc nulls last) from camps c), '[]'::jsonb),
  'adsets', coalesce((select jsonb_agg(to_jsonb(a) order by a.leads desc) from adsets a), '[]'::jsonb),
  'days', coalesce((select jsonb_agg(to_jsonb(d) order by d.date) from days d), '[]'::jsonb),
  'spend_days', (select count(distinct date) from f),
  'currency', (select max(currency) from f)
);
$$;
revoke all on function public.cs_stats(date, date) from public, anon, authenticated;
grant execute on function public.cs_stats(date, date) to service_role;

-- cron: synchronizacja wydatków z Meta co 3 h
select cron.schedule('campaign-stats-sync', '23 */3 * * *', $$
  select net.http_post(
    url := 'https://kltggicuonljcgyehcev.supabase.co/functions/v1/campaign-stats',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-internal-token', (select value from public.app_secrets where key = 'INTERNAL_TOKEN')),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 150000);
$$);
