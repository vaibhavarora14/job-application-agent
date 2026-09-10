import { DatabaseSync } from 'node:sqlite';

function resultRows(statement) {
  const rows = statement.all();
  return { results: rows, success: true, meta: {} };
}

export function createMemoryD1(schema = '') {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  return {
    exec(sql) {
      database.exec(sql);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    prepare(sql) {
      let values = [];
      const api = {
        bind(...next) {
          values = next;
          return api;
        },
        async first(column) {
          const row = database.prepare(sql).get(...values) ?? null;
          return column && row ? row[column] : row;
        },
        async all() {
          return resultRows(database.prepare(sql), values);
        },
        async run() {
          const result = database.prepare(sql).run(...values);
          return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
        },
        async raw() {
          return database.prepare(sql).all(...values).map((row) => Object.values(row));
        },
      };
      api.all = async () => ({ results: database.prepare(sql).all(...values), success: true, meta: {} });
      return api;
    },
    async batch(statements) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    database,
  };
}
