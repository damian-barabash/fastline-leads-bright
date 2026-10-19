-- Raport tygodniowy (zakładka Analityka): lejek leadów FB w tygodniu — kto dostał telefon, jak szybko, z kim rozmawiano.
-- Kontakt liczony do dziś (nie tylko do końca tygodnia), po numerze telefonu (ostatnie 9 cyfr).

create or replace function public.rs_week_leads(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
with l as (
  select id, full_name, phone, email, campaign_name, form_name, page_name, received_at, pipedrive_lead_id,
    public.rs_phone9(phone) as p9
  from leads
  where received_at >= p_from and received_at < p_to and status <> 'skipped'
),
x as (
  select l.*,
    (select min(c.calldate) from rs_calls c
      where c.phone9 = l.p9 and c.calldate >= l.received_at and c.call_type in ('out', 'callback')) as first_call,
    (select min(c.calldate) from rs_calls c
      where c.phone9 = l.p9 and c.calldate >= l.received_at and c.answered) as first_talk,
    (select count(*) from rs_calls c
      where c.phone9 = l.p9 and c.calldate >= l.received_at) as calls,
    (select max(c.calldate) from rs_calls c
      where c.phone9 = l.p9 and c.calldate >= l.received_at) as last_call
  from l
)
select jsonb_build_object(
  'total', (select count(*) from x),
  'withPhone', (select count(*) from x where p9 is not null),
  'called', (select count(*) from x where first_call is not null),
  'talked', (select count(*) from x where first_talk is not null),
  'calledWithin1h', (select count(*) from x where first_call - received_at <= interval '1 hour'),
  'calledWithin24h', (select count(*) from x where first_call - received_at <= interval '24 hours'),
  'medianFirstCallMin', (select round((percentile_cont(0.5) within group (order by extract(epoch from first_call - received_at)) / 60)::numeric)
      from x where first_call is not null),
  'avgCallsPerLead', (select round(avg(calls)::numeric, 1) from x where p9 is not null),
  'byCampaign', coalesce((select jsonb_agg(c order by c.leads desc) from (
      select coalesce(nullif(campaign_name, ''), nullif(form_name, ''), '(nieznana)') as name,
        count(*) as leads,
        count(*) filter (where first_call is not null) as called,
        count(*) filter (where first_talk is not null) as talked
      from x group by 1) c), '[]'::jsonb),
  'notCalled', coalesce((select jsonb_agg(n order by n.received_at desc) from (
      select id, full_name, phone, email, campaign_name, form_name, received_at, pipedrive_lead_id, calls
      from x where first_call is null and first_talk is null
      limit 100) n), '[]'::jsonb)
)
$$;

revoke all on function public.rs_week_leads(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.rs_week_leads(timestamptz, timestamptz) to service_role;
