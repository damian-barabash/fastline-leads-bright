-- 0005: kopia korespondencji z klientem per reguła sortowania.
-- Włączone -> adresy z client_copy_emails dostają:
--   * CC e-maila wysyłanego do klienta (link do kalendarza rozmów),
--   * powiadomienie, gdy klient zarezerwuje / zmieni termin rozmowy.
alter table routing_rules add column if not exists client_copy_on boolean not null default false;
alter table routing_rules add column if not exists client_copy_emails text[] not null default '{}';
