-- Ringostat: dziennik połączeń, pracownicy, zdarzenia webhooków (wyniki AI), agregaty dla panelu.
-- Dostęp tylko service_role (RLS bez polityk) — panel czyta przez admin-api.

create table if not exists public.rs_calls (
  uniqueid text primary key,
  calldate timestamptz,
  call_type text,               -- in / out / callback / transitin / transitout
  disposition text,             -- ANSWERED / NO ANSWER / PROPER / BUSY / FAILED / ...
  caller text,
  caller_number text,
  dst text,
  connected_with text,
  n_alias text,
  pool_name text,
  scheme_name text,
  client_phone text,            -- numer klienta (cyfry) niezależnie od kierunku
  duration int,
  billsec int,
  waittime int,
  -- rozmowa faktycznie się odbyła (poczta głosowa = nieodebrane)
  answered boolean generated always as (coalesce(billsec, 0) > 0 and coalesce(disposition, '') <> 'VOICEMAIL') stored,
  call_counter int,
  proper_flag int,
  repeated_flag int,
  employee_number int,
  employee_fio text,
  employee_email text,
  department text,
  employee_mark int,
  category_mark numeric,
  category_number text,
  missing_reason text,
  who_missed jsonb,
  has_recording boolean,
  recording text,
  call_card text,
  additional_number text,
  csat_survey int,
  csat_survey_name text,
  csat_rating text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  client_id text,
  remote_ip text,
  referrer text,
  landing text,
  region text,
  lead_id uuid references public.leads(id) on delete set null,
  raw jsonb,
  -- wyniki Ringostat AI (webhook „Call processed by AI”)
  ai jsonb,
  ai_title text,
  ai_summary text,
  ai_score numeric,
  transcript text,
  ai_at timestamptz,
  synced_at timestamptz default now()
);
create index if not exists rs_calls_calldate_idx on public.rs_calls (calldate desc);
create index if not exists rs_calls_client_phone_idx on public.rs_calls (client_phone);
create index if not exists rs_calls_lead_idx on public.rs_calls (lead_id);
create index if not exists rs_calls_employee_idx on public.rs_calls (employee_fio);
alter table public.rs_calls enable row level security;

create table if not exists public.rs_employees (
  staff_id bigint primary key,
  fio text,
  email text,
  extension text,
  sip_logins text[],
  phones text[],
  online boolean,
  updated_at timestamptz default now()
);
alter table public.rs_employees enable row level security;

create table if not exists public.rs_webhook_events (
  id bigserial primary key,
  received_at timestamptz default now(),
  call_id text,
  payload jsonb,
  status text default 'stored',  -- stored / applied / error
  error text
);
create index if not exists rs_webhook_events_call_idx on public.rs_webhook_events (call_id);
alter table public.rs_webhook_events enable row level security;

-- numer do porównań: ostatnie 9 cyfr (PL)
create or replace function public.rs_phone9(p text) returns text
language sql immutable as $$
  select case when length(regexp_replace(coalesce(p,''), '\D', '', 'g')) >= 9
    then right(regexp_replace(p, '\D', '', 'g'), 9) end
$$;
alter table public.rs_calls add column if not exists phone9 text generated always as (public.rs_phone9(client_phone)) stored;
create index if not exists rs_calls_phone9_idx on public.rs_calls (phone9, calldate);
create index if not exists leads_phone9_idx on public.leads (public.rs_phone9(phone));

-- przypięcie rozmów do leadów po numerze (najświeższy lead z tym numerem)
create or replace function public.rs_match_leads() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update rs_calls c set lead_id = m.id
  from (
    select distinct on (public.rs_phone9(phone)) public.rs_phone9(phone) p9, id
    from leads where public.rs_phone9(phone) is not null
    order by public.rs_phone9(phone), received_at desc
  ) m
  where c.lead_id is null and c.phone9 = m.p9;
  get diagnostics n = row_count;
  return n;
end $$;

-- agregaty dla zakładki Analityka (PostgREST tnie wyniki do 1000 wierszy, więc liczymy w SQL)
create or replace function public.rs_stats(p_from timestamptz, p_to timestamptz, p_employee text default null)
returns jsonb language sql stable security definer set search_path = public as $$
with c as (
  select *,
    (call_type in ('in','transitin')) as incoming,
    (calldate at time zone 'Europe/Warsaw') as local_ts
  from rs_calls
  where calldate >= p_from and calldate < p_to
    and (p_employee is null or employee_fio = p_employee)
),
missed_in as (
  -- nieodebrane przychodzące + czy i kiedy oddzwoniono (rozmowa z tym numerem po nieodebranej)
  select m.uniqueid, m.calldate, m.client_phone,
    (select min(o.calldate) from rs_calls o
      where o.phone9 = m.phone9
        and o.calldate > m.calldate and (o.call_type in ('out','callback') or o.answered)) as next_contact,
    (select min(o.calldate) from rs_calls o
      where o.phone9 = m.phone9
        and o.calldate > m.calldate and o.answered) as next_talk
  from c m where m.incoming and not m.answered and m.client_phone is not null
)
select jsonb_build_object(
  'total', (select count(*) from c),
  'incoming', (select count(*) from c where incoming),
  'outgoing', (select count(*) from c where call_type = 'out'),
  'callbacks', (select count(*) from c where call_type = 'callback'),
  'answered', (select count(*) from c where answered),
  'incomingAnswered', (select count(*) from c where incoming and answered),
  'incomingMissed', (select count(*) from c where incoming and not answered),
  'outgoingAnswered', (select count(*) from c where call_type = 'out' and answered),
  'uniqueClients', (select count(distinct phone9) from c),
  'newClients', (select count(*) from c where incoming and call_counter = 1),
  'proper', (select count(*) from c where proper_flag = 1),
  'repeated', (select count(*) from c where repeated_flag = 1),
  'talkSec', (select coalesce(sum(billsec),0) from c where answered),
  'avgTalkSec', (select coalesce(round(avg(billsec)),0) from c where answered),
  'avgWaitIn', (select coalesce(round(avg(waittime)),0) from c where incoming and answered),
  'withRecording', (select count(*) from c where has_recording),
  'withAi', (select count(*) from c where ai_at is not null),
  'avgAiScore', (select round(avg(ai_score),1) from c where ai_score is not null),
  'withLead', (select count(*) from c where lead_id is not null),
  'leadsCalled', (select count(distinct lead_id) from c where lead_id is not null and call_type = 'out'),
  'missedCalledBack', (select count(*) from missed_in where next_contact is not null),
  'missedNotCalledBack', (select count(*) from missed_in where next_contact is null),
  'medianCallbackMin', (select round((percentile_cont(0.5) within group (order by extract(epoch from next_contact - calldate)) / 60)::numeric) from missed_in where next_contact is not null),
  'callbackWithin1h', (select count(*) from missed_in where next_contact is not null and next_contact - calldate <= interval '1 hour'),
  'byDay', coalesce((select jsonb_agg(d order by d.date) from (
      select to_char(local_ts, 'YYYY-MM-DD') as date,
        count(*) filter (where incoming) as "in",
        count(*) filter (where call_type = 'out') as "out",
        count(*) filter (where answered) as answered,
        count(*) filter (where incoming and not answered) as missed,
        coalesce(sum(billsec),0) as talk
      from c group by 1) d), '[]'::jsonb),
  'byHour', coalesce((select jsonb_agg(h) from (
      select extract(isodow from local_ts)::int as dow, extract(hour from local_ts)::int as hour,
        count(*) filter (where incoming) as "in",
        count(*) filter (where incoming and not answered) as missed,
        count(*) filter (where call_type = 'out') as "out"
      from c group by 1, 2) h), '[]'::jsonb),
  'byEmployee', coalesce((select jsonb_agg(e order by e.calls desc) from (
      select coalesce(employee_fio, '(bez pracownika)') as name,
        count(*) as calls,
        count(*) filter (where incoming) as "in",
        count(*) filter (where call_type = 'out') as "out",
        count(*) filter (where answered) as answered,
        count(*) filter (where call_type = 'out' and answered) as out_answered,
        coalesce(sum(billsec),0) as talk,
        coalesce(round(avg(billsec) filter (where answered)),0) as avg_talk,
        coalesce(round(avg(waittime) filter (where incoming and answered)),0) as avg_wait,
        count(distinct phone9) as clients,
        count(*) filter (where ai_at is not null) as ai,
        round(avg(ai_score),1) as ai_score,
        count(distinct lead_id) filter (where lead_id is not null) as leads
      from c group by 1) e), '[]'::jsonb),
  'dispositions', coalesce((select jsonb_agg(x order by x.count desc) from (
      select coalesce(disposition,'?') as name, count(*) as count from c group by 1) x), '[]'::jsonb),
  'missedReasons', coalesce((select jsonb_agg(x order by x.count desc) from (
      select coalesce(nullif(missing_reason,''),'(brak powodu)') as name, count(*) as count
      from c where incoming and not answered group by 1) x), '[]'::jsonb),
  'sources', coalesce((select jsonb_agg(x order by x.count desc) from (
      select coalesce(nullif(nullif(utm_source,''),'(direct)'), nullif(pool_name,''), case when referrer <> '' then 'strona www' end, 'bez źródła') as name, count(*) as count
      from c where incoming group by 1) x), '[]'::jsonb),
  'durationBuckets', coalesce((select jsonb_agg(x order by x.ord) from (
      select case when billsec < 30 then 1 when billsec < 60 then 2 when billsec < 180 then 3 when billsec < 600 then 4 else 5 end as ord,
        case when billsec < 30 then '< 30 s' when billsec < 60 then '30–60 s' when billsec < 180 then '1–3 min' when billsec < 600 then '3–10 min' else '> 10 min' end as name,
        count(*) as count
      from c where answered group by 1, 2) x), '[]'::jsonb)
)
$$;

-- lista nieodebranych przychodzących bez oddzwonienia (do zakładki „Do oddzwonienia”)
create or replace function public.rs_missed_open(p_from timestamptz, p_to timestamptz)
returns table (uniqueid text, calldate timestamptz, client_phone text, missing_reason text, scheme_name text, attempts bigint, lead_id uuid)
language sql stable security definer set search_path = public as $$
  select distinct on (m.phone9)
    m.uniqueid, m.calldate, m.client_phone, m.missing_reason, m.scheme_name,
    (select count(*) from rs_calls x where x.phone9 = m.phone9
       and x.call_type in ('in','transitin') and not x.answered and x.calldate >= p_from and x.calldate < p_to) as attempts,
    m.lead_id
  from rs_calls m
  where m.calldate >= p_from and m.calldate < p_to
    and m.call_type in ('in','transitin') and not m.answered and m.client_phone is not null
    and not exists (
      select 1 from rs_calls o
      where o.phone9 = m.phone9
        and o.calldate > m.calldate and (o.call_type in ('out','callback') or o.answered))
  order by m.phone9, m.calldate desc
$$;

revoke all on function public.rs_match_leads() from public, anon, authenticated;
revoke all on function public.rs_stats(timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.rs_missed_open(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.rs_match_leads() to service_role;
grant execute on function public.rs_stats(timestamptz, timestamptz, text) to service_role;
grant execute on function public.rs_missed_open(timestamptz, timestamptz) to service_role;

-- synchronizacja co 5 min (token wewnętrzny czytany z app_secrets w momencie wywołania)
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'ringostat-sync';
select cron.schedule('ringostat-sync', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://kltggicuonljcgyehcev.supabase.co/functions/v1/ringostat-sync',
    headers := jsonb_build_object('content-type', 'application/json',
      'x-internal-token', (select value from public.app_secrets where key = 'INTERNAL_TOKEN')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$$);
