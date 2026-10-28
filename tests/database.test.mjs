import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

for (const legacyDefaults of [false, true]) test(`explicit grants and ownership (legacy defaults: ${legacyDefaults})`, async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
    `);
    if (legacyDefaults) await db.exec(`
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    `);
    await db.exec(await readFile(new URL("../supabase/migrations/20261027000000_dashboard.sql", import.meta.url), "utf8"));
    const member = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    for (const [id, email] of [[member, "alex@example.org"], [other, "blair@example.org"]]) {
      await db.query("insert into auth.users values ($1, $2, $3)", [id, email, { full_name: "Test member" }]);
    }
    await db.query("insert into public.access_allowlist (email) values ('alex@example.org')");
    async function role(name, id = "", email = "") {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
      await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email })]);
      await db.exec(`set role ${name}`);
    }
    const denied = (sql, params = []) => assert.rejects(() => db.query(sql, params), (e) => e.code === "42501");
    const insert = `insert into public.usage_reports
      (member_id, slurm_user, cluster, resource_pool, start_time, duration_hours, gpu_count)
      values ($1, 'alex', 'CUSTOM', 'accelerators', now(), 2.5, 4) returning id, gpu_hours`;

    await role("authenticated", member, "alex@example.org");
    await db.query("update public.profiles set full_name = 'Alex' where id = $1", [member]);
    const row = (await db.query(insert, [member])).rows[0];
    assert.equal(Number(row.gpu_hours), 10);
    assert.equal((await db.query("select display_name from public.usage_reports")).rows[0].display_name, "Alex");
    await db.query("update public.usage_reports set gpu_count = 2 where id = $1", [row.id]);
    assert.equal(Number((await db.query("select gpu_hours from public.usage_reports")).rows[0].gpu_hours), 5);
    await denied("select * from public.access_allowlist");
    await denied("truncate public.usage_reports");
    await denied("delete from public.cluster_live");

    await role("authenticated", other, "blair@example.org");
    await denied(insert, [other]);
    await denied(insert, [member]);
    assert.equal((await db.query("update public.usage_reports set reason = 'other' returning id")).rows.length, 0);
    assert.equal((await db.query("delete from public.usage_reports returning id")).rows.length, 0);
    assert.equal((await db.query("select id from public.profiles")).rows.length, 1);

    await role("service_role");
    await db.query("insert into public.cluster_live (cluster, collected_at, payload) values ('CUSTOM', now(), '{}')");
    await db.query("insert into public.cluster_live_history (cluster, collected_at) values ('CUSTOM', now())");
    await db.query("select nextval('public.cluster_live_history_id_seq')");
    await role("anon");
    for (const table of ["usage_reports", "cluster_live", "cluster_live_history"]) {
      assert.equal((await db.query(`select * from public.${table}`)).rows.length, 1);
      await denied(`delete from public.${table}`);
    }
    await denied("select * from public.profiles");
    await denied("select * from public.access_allowlist");
    await denied(insert, [member]);
    await role("service_role");
    await db.query("delete from public.access_allowlist");
    await db.query("delete from public.cluster_live_history");
    await role("authenticated", member, "alex@example.org");
    await denied(insert, [member]);
    assert.equal((await db.query("delete from public.usage_reports returning id")).rows.length, 1);
  } finally {
    await db.close();
  }
});
