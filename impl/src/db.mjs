import { DatabaseSync } from 'node:sqlite'

// 最小数据层：所有业务表带 tenant_id，查询一律按 tenant_id 过滤（对齐文档 §6 / §2.4 硬约束 3）。
export function openDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    create table tenants (id text primary key, name text not null);
    create table users (id text primary key, tenant_id text not null, email text not null);
    create table sessions (id text primary key, tenant_id text not null, user_id text not null, title text not null);
    create table audit_log (
      id integer primary key autoincrement,
      tenant_id text not null,
      actor text not null,
      action text not null,
      detail_json text not null,
      ts text not null
    );
    create table runs (
      id text primary key,
      status text not null,
      started_at text not null,
      ended_at text
    );
    create table events (
      run_id text not null,
      seq integer not null,
      type text not null,
      payload_json text not null,
      ts text not null,
      primary key (run_id, seq)
    );
    create index idx_sessions_tenant on sessions (tenant_id);
    create index idx_audit_tenant on audit_log (tenant_id);
  `)
  return db
}

export function seedTwoTenants(db) {
  const now = new Date().toISOString()
  db.exec(`
    insert into tenants (id, name) values ('t_a', 'Tenant A'), ('t_b', 'Tenant B');
    insert into users (id, tenant_id, email) values
      ('u_a', 't_a', 'a@example.com'),
      ('u_b', 't_b', 'b@example.com');
    insert into sessions (id, tenant_id, user_id, title) values
      ('s_a1', 't_a', 'u_a', 'A 的会话'),
      ('s_b1', 't_b', 'u_b', 'B 的会话');
  `)
  return now
}
