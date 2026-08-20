import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("adds stored access duration and a permanently unique welcome delivery", async () => {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationDirectory)).filter((name) => /^0005_.*\.sql$/.test(name));
  assert.equal(migrationFiles.length, 1, "expected one 0005 welcome-email migration");
  const migration = await readFile(new URL(migrationFiles[0], migrationDirectory), "utf8");

  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE founding_purchases (id TEXT PRIMARY KEY NOT NULL)");
  database.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const accessDays = database.prepare("SELECT name, dflt_value AS defaultValue FROM pragma_table_info('founding_purchases') WHERE name='access_days'").get();
  assert.equal(accessDays.name, "access_days");
  assert.equal(accessDays.defaultValue, "90");

  database.prepare("INSERT INTO founding_purchases (id) VALUES (?)").run("purchase-1");
  const insert = database.prepare(`INSERT INTO customer_email_deliveries
    (id,purchase_id,message_kind,status) VALUES (?,?,?,'pending')`);
  insert.run("delivery-1", "purchase-1", "purchase-welcome-v1");
  assert.throws(
    () => insert.run("delivery-2", "purchase-1", "purchase-welcome-v1"),
    /UNIQUE constraint failed/,
  );
});
