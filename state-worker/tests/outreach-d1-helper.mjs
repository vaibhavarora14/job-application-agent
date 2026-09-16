import initialize from 'sql.js/dist/sql-asm.js';
import { createMemoryD1, hasNodeSqlite } from './d1-mock.mjs';
const SQL = hasNodeSqlite ? null : await initialize();

// Keep outreach's transactional tests runnable on the package's Node 20 floor.
export function outreachD1(schema) {
  if (hasNodeSqlite) return createMemoryD1(schema);
  const db = new SQL.Database(); db.run(schema); let tail = Promise.resolve();
  return {
    async exec(sql) { db.run(sql); },
    prepare(sql) {
      let values = [];
      const rows = () => { const stmt = db.prepare(sql); try { stmt.bind(values); const result = []; while (stmt.step()) result.push(stmt.getAsObject()); return result; } finally { stmt.free(); } };
      const statement = {
        bind(...input) { values = input; return statement; },
        async first(column) { const row = rows()[0] ?? null; return column && row ? row[column] : row; },
        async all() { return { results: rows() }; },
        async run() { db.run(sql, values); return { meta: { changes: db.getRowsModified() } }; },
      }; return statement;
    },
    async batch(statements) {
      const previous = tail; let release; tail = new Promise(resolve => { release = resolve; }); await previous;
      db.run('BEGIN');
      try { const result = []; for (const statement of statements) result.push(await statement.run()); db.run('COMMIT'); return result; }
      catch (error) { db.run('ROLLBACK'); throw error; } finally { release(); }
    },
  };
}
