-- 0003: callback booking (kalendarz oddzwonień) + wiadomości do klienta (e-mail/SMS)

-- Edytowalne szablony wiadomości wysyłanych DO KLIENTA po wpadnięciu leada.
create table if not exists client_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  enabled boolean not null default true,
  is_default boolean not null default false,
  -- dopasowanie po nazwie kampanii/formularza (dowolny z wzorców, substring, case-insensitive)
  match_patterns text[] not null default '{}',
  priority int not null default 100,
  send_email boolean not null default true,
  send_sms boolean not null default true,
  email_subject text not null default '',
  email_body text not null default '',
  sms_body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table client_templates enable row level security;

-- Rezerwacje terminów oddzwonienia (sloty 20 min, pon–pt 10:00–18:00 Europe/Warsaw).
create table if not exists callback_bookings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  slot_at timestamptz not null,
  status text not null default 'booked', -- booked | cancelled
  pd_activity_id bigint,
  pd_note_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table callback_bookings enable row level security;
-- jeden aktywny booking na slot i jeden aktywny booking na leada
create unique index if not exists callback_bookings_slot_uq on callback_bookings (slot_at) where status = 'booked';
create unique index if not exists callback_bookings_lead_uq on callback_bookings (lead_id) where status = 'booked';

-- Leady: osobisty token do linku rezerwacji + statusy wysyłek do klienta
alter table leads add column if not exists booking_token text unique;
alter table leads add column if not exists client_template_id uuid;
alter table leads add column if not exists client_email_status text; -- sent | failed | skipped | null
alter table leads add column if not exists client_sms_status text;

-- Reguły: opcjonalne nadpisanie szablonu / wyłączenie wiadomości per reguła
alter table routing_rules add column if not exists client_template_id uuid;
alter table routing_rules add column if not exists client_msg_off boolean not null default false;

-- Ustawienia
insert into settings (key, value) values
  ('client_email_enabled', 'true'::jsonb),
  ('client_sms_enabled', 'true'::jsonb),
  ('sms_sender', '"FASTLINE RA"'::jsonb),
  ('booking_url_base', '"https://leads.fastlineracingacademy.pl/calendar"'::jsonb),
  ('booking_config', '{"tz":"Europe/Warsaw","days":[1,2,3,4,5],"start":"10:00","end":"18:00","step_min":20,"horizon_days":14,"min_notice_min":60}'::jsonb)
on conflict (key) do nothing;

-- Seed 3 szablonów (teksty od klienta; {{link}} = osobisty link, {{imie}} = imię)
insert into client_templates (name, enabled, is_default, match_patterns, priority, send_email, send_sms, email_subject, email_body, sms_body)
select * from (values
  (
    'Heels on the Track', true, false, array['heels'], 10, true, true,
    'Heels on the Track — wybierz termin rozmowy',
    E'Witaj!\nDziękujemy za Twoje zgłoszenie. Heels on the Track to dobry wybór! O szczegółach opowie Ci Olga, dzwoniąc z numeru +48 513 392 502.\n\nJeśli lubisz planować, wybierz najlepszy dla Ciebie termin na rozmowę:\n{{link}}\n\nJeśli masz pytania, pisz lub dzwoń do nas!\nOlga +48 513 392 502\nMariusz +48 601 280 520\nMagda +48 605 603 722\n\nDo usłyszenia!',
    E'Witaj! Dziękujemy za Twoje zgłoszenie. Heels on the Track to dobry wybór! O szczegółach opowie Ci Olga, dzwoniąc z numeru +48 513 392 502. Jeśli lubisz planować, wybierz najlepszy dla Ciebie termin na rozmowę: {{link}} Jeśli masz pytania, pisz lub dzwoń do nas! Olga +48 513 392 502, Mariusz +48 601 280 520, Magda +48 605 603 722. Do usłyszenia!'
  ),
  (
    'Eventy Firmowe', true, false, array['event'], 20, true, true,
    'Fastline Racing Academy — event firmowy, wybierz termin rozmowy',
    E'Cześć!\nDzięki za zgłoszenie do Fastline Racing Academy. W sprawie eventu firmowego zadzwoni do Ciebie Łukasz z numeru +48 603 102 665.\n\nWybierz dogodny dla siebie termin rozmowy:\n{{link}}\nlub oddzwoń.\n\nDo usłyszenia!',
    E'Cześć! Dzięki za zgłoszenie do Fastline Racing Academy. W sprawie eventu firmowego zadzwoni do Ciebie Łukasz z numeru +48 603 102 665. Wybierz dogodny dla siebie termin rozmowy: {{link}} lub oddzwoń. Do usłyszenia!'
  ),
  (
    'Uniwersalny', true, true, array[]::text[], 1000, true, true,
    'Fastline Racing Academy — wybierz termin rozmowy',
    E'Cześć!\nDziękujemy za zainteresowanie. Czas przekuć motoryzacyjne plany w emocje na torze. Skontaktuje się z Tobą Marcin z numeru +48 579 772 198.\n\nWybierz godzinę rozmowy, która Ci odpowiada:\n{{link}}\n\nDo usłyszenia!',
    E'Cześć! Dziękujemy za zainteresowanie. Czas przekuć motoryzacyjne plany w emocje na torze. Skontaktuje się z Tobą Marcin z numeru +48 579 772 198. Wybierz godzinę rozmowy, która Ci odpowiada: {{link}} Do usłyszenia!'
  )
) v(name, enabled, is_default, match_patterns, priority, send_email, send_sms, email_subject, email_body, sms_body)
where not exists (select 1 from client_templates);
