import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// 最小数据层：所有业务表带 tenant_id，查询一律按 tenant_id 过滤（对齐文档 §6 / §2.4 硬约束 3）。
// path 省略 = 内存库（测试）；传路径 = 落盘（生产），重启不丢数据
export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  if (path !== ':memory:') {
    db.exec('pragma journal_mode = WAL')
    db.exec('pragma synchronous = NORMAL')
  }
  db.exec(`
    create table if not exists tenants (id text primary key, name text not null);
    create table if not exists users (id text primary key, tenant_id text not null, email text not null);
    create table if not exists sessions (id text primary key, tenant_id text not null, user_id text not null, title text not null);
    create table if not exists audit_log (
      id integer primary key autoincrement,
      tenant_id text not null,
      actor text not null,
      action text not null,
      detail_json text not null,
      ts text not null
    );
    create table if not exists messages (
      id text primary key,
      tenant_id text not null,
      session_id text not null,
      role text not null,
      content text not null,
      created_at text not null,
      parent_id text
    );
    create index if not exists idx_messages_session on messages (tenant_id, session_id);

    create table if not exists runs (
      id text primary key,
      status text not null,
      started_at text not null,
      ended_at text,
      tenant_id text,
      session_id text
    );
    create table if not exists session_grants (
      tenant_id text not null,
      session_id text not null,
      tool text not null,
      scope text not null default 'session',
      granted_at text not null,
      primary key (tenant_id, session_id, tool)
    );
    create table if not exists run_pending (
      run_id text primary key,
      tenant_id text,
      session_id text,
      messages_json text not null,
      call_json text not null,
      call_id text not null,
      steps integer not null default 0,
      created_at text not null
    );

    create table if not exists run_tool_results (
      run_id text not null,
      call_id text not null,
      ok integer not null,
      content text not null,
      artifact_json text,
      error text,
      created_at text not null,
      primary key (run_id, call_id)
    );

    create table if not exists events (
      run_id text not null,
      seq integer not null,
      type text not null,
      payload_json text not null,
      ts text not null,
      primary key (run_id, seq)
    );
    create index if not exists idx_sessions_tenant on sessions (tenant_id);
    create index if not exists idx_audit_tenant on audit_log (tenant_id);
    -- 会话级接口（pending/active/artifacts）与启动收敛都按这两组条件查 runs，补索引避免全表扫
    create index if not exists idx_runs_session on runs (tenant_id, session_id);
    create index if not exists idx_runs_status on runs (status);
  `)
  return db
}

export function seedTwoTenants(db) {
  const now = new Date().toISOString()
  const existing = db.prepare('select count(*) c from tenants').get()
  if (Number(existing.c) > 0) return now // 幂等：已有数据就不再灌种子
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
