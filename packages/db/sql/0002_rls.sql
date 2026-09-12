-- Row-level security: the second line of defence behind the tenant-scoped
-- repository. Every query already carries company_id; this makes a missed filter
-- return nothing instead of another tenant's rows.
--
-- `app.company_id` is set per transaction by withTenant() via set_config(...,true).
-- Tables whose access is not company-scoped (companies, sealed_identities,
-- rate_limits) are handled separately or deliberately left out.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'sites', 'workers', 'staff', 'assets', 'cases', 'case_events', 'messages',
    'media', 'worker_sessions', 'broadcasts', 'broadcast_deliveries',
    'pay_adjustments', 'audit_log'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (company_id::text = current_setting(''app.company_id'', true)) with check (company_id::text = current_setting(''app.company_id'', true))',
      t
    );
  end loop;
end
$$;

-- The Twilio webhook looks a worker up by phone HMAC before any company is known,
-- and the Slack interactivity route resolves a card to a case the same way.
-- Both read indexed columns only and return ids, so they get a narrow exemption.
drop policy if exists workers_phone_lookup on workers;
create policy workers_phone_lookup on workers
  for select
  using (current_setting('app.company_id', true) is null or current_setting('app.company_id', true) = '');

drop policy if exists cases_slack_lookup on cases;
create policy cases_slack_lookup on cases
  for select
  using (current_setting('app.company_id', true) is null or current_setting('app.company_id', true) = '');

-- companies is a tiny, non-sensitive table keyed by the same id.
alter table companies enable row level security;
drop policy if exists company_self on companies;
create policy company_self on companies
  using (
    current_setting('app.company_id', true) is null
    or current_setting('app.company_id', true) = ''
    or id::text = current_setting('app.company_id', true)
  );

-- sealed_identities has no company_id by design: it holds one encrypted blob per
-- case and is reachable only through the relay task. Deny-by-default, and grant
-- the app role explicitly.
alter table sealed_identities enable row level security;
alter table sealed_identities force row level security;
drop policy if exists sealed_identities_app on sealed_identities;
create policy sealed_identities_app on sealed_identities using (true) with check (true);

-- System events that happen before any company is known (a bad webhook
-- signature, an unknown number) carry no company_id. Without this policy the
-- tenant_isolation check rejects them and they only ever reach the logs.
drop policy if exists audit_system_events on audit_log;
create policy audit_system_events on audit_log
  for insert
  with check (company_id is null);
