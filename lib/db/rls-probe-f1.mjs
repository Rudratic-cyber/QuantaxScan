import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
const q = async (label, sql, params) => {
  try {
    const r = await db.query(sql, params);
    console.log(label, "=>", JSON.stringify(r.rows));
  } catch (e) {
    console.log(label, "=> ERROR:", e.message);
  }
};

await db.exec(`
  create role app_runtime login noinherit;
  create table orgs (id serial primary key, name text, personal boolean not null default false,
                     created_by text);
  create table members (org_id int not null references orgs(id), user_id text not null, role text,
                        primary key (org_id, user_id));
  grant select, insert, update, delete on orgs, members to app_runtime;
  grant usage, select on all sequences in schema public to app_runtime;
  grant usage on schema public to app_runtime;

  alter table orgs enable row level security; alter table orgs force row level security;
  create policy orgs_p on orgs as permissive for all to app_runtime
    using (id = nullif(current_setting('app.current_org_id', true), '')::int
        or id in (select m.org_id from members m where m.user_id = nullif(current_setting('app.current_user_id', true), ''))
        or created_by = nullif(current_setting('app.current_user_id', true), ''))
    with check (personal = true
            and created_by = nullif(current_setting('app.current_user_id', true), ''));

  alter table members enable row level security; alter table members force row level security;
  create policy members_p on members as permissive for all to app_runtime
    using (org_id = nullif(current_setting('app.current_org_id', true), '')::int
        or user_id = nullif(current_setting('app.current_user_id', true), ''))
    with check (org_id = nullif(current_setting('app.current_org_id', true), '')::int);
`);

await db.exec(`SET ROLE app_runtime`);

console.log("=== bootstrap in ONE transaction: user GUC, insert org, promote org GUC, insert membership ===");
await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u1', true)`);
await q("insert org RETURNING id", `insert into orgs (name, personal, created_by) values ('u1 personal', true, 'u1') returning id`);
await q("promote org guc", `select set_config('app.current_org_id', '1', true)`);
await q("insert membership", `insert into members (org_id, user_id, role) values (1, 'u1', 'owner') returning org_id`);
await q("read memberships", `select * from members`);
await db.exec("commit");

console.log("=== u1, user GUC only (the per-request membership re-read) ===");
await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u1', true)`);
await q("memberships", `select org_id, role from members`);
await q("orgs", `select id, name from orgs`);
await db.exec("commit");

console.log("=== u2 attacks ===");
await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u2', true)`);
await q("orgs seen by u2", `select id, name from orgs`);
await q("members seen by u2", `select * from members`);
await db.exec("commit");

await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u2', true)`);
await q("u2 self-joins u1's org (no org guc)", `insert into members (org_id, user_id, role) values (1, 'u2', 'owner') returning org_id`);
await db.exec("rollback");

await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u2', true)`);
await db.query(`select set_config('app.current_org_id', '1', true)`);
await q("u2 self-joins u1's org WITH forged org guc", `insert into members (org_id, user_id, role) values (1, 'u2', 'owner') returning org_id`);
await db.exec("rollback");

await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u2', true)`);
await q("u2 inserts NON-personal org", `insert into orgs (name, personal, created_by) values ('evil', false, 'u2') returning id`);
await db.exec("rollback");

await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u2', true)`);
await q("u2 inserts org created_by u1", `insert into orgs (name, personal, created_by) values ('evil2', true, 'u1') returning id`);
await db.exec("rollback");

console.log("=== anonymous (no GUC at all) ===");
await db.exec("begin");
await q("orgs", `select id, name from orgs`);
await q("insert org", `insert into orgs (name, personal, created_by) values ('anon', true, null) returning id`);
await db.exec("rollback");

console.log("=== revocation takes effect immediately ===");
await db.exec("RESET ROLE");
await db.query(`insert into orgs (id, name, personal, created_by) values (9, 'shared', false, null)`);
await db.query(`insert into members (org_id, user_id, role) values (9, 'u1', 'member')`);
await db.exec("SET ROLE app_runtime");
await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u1', true)`);
await q("u1 memberships before revoke", `select org_id from members order by org_id`);
await db.exec("commit");
await db.exec("RESET ROLE");
await db.query(`delete from members where org_id = 9 and user_id = 'u1'`);
await db.exec("SET ROLE app_runtime");
await db.exec("begin");
await db.query(`select set_config('app.current_user_id', 'u1', true)`);
await q("u1 memberships after revoke", `select org_id from members order by org_id`);
await db.exec("commit");

await db.close();
