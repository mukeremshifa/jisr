-- Least-privilege database roles.
--
--   jisr_migrator  owns the schema and runs DDL. Used only by `pnpm db:migrate`.
--   jisr_app       SELECT/INSERT/UPDATE on app tables, INSERT ONLY on audit_log.
--                  No DDL, no DELETE, no superuser.
--
-- Idempotent: this file is re-applied on every migration run.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jisr_app') then
    -- No password here on purpose. Set it out of band:
    --   alter role jisr_app with login password '<from secret manager>';
    create role jisr_app nologin;
  end if;
end
$$;

grant usage on schema public to jisr_app;

-- App tables: read and write, never drop.
grant select, insert, update on all tables in schema public to jisr_app;
grant usage, select on all sequences in schema public to jisr_app;

-- audit_log is append-only for the app. A compromised app role cannot rewrite history.
revoke update on table audit_log from jisr_app;
grant insert, select on table audit_log to jisr_app;

-- Nothing in the app deletes rows. Retention is a separate, privileged job.
revoke delete on all tables in schema public from jisr_app;
-- Except the rate-limit table, whose old windows are pruned by the daily task.
grant delete on table rate_limits to jisr_app;

alter default privileges in schema public
  grant select, insert, update on tables to jisr_app;
alter default privileges in schema public
  grant usage, select on sequences to jisr_app;
