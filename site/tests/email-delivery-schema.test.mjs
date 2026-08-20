import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("adds stored access duration and a permanently unique welcome delivery", async () => {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const purchaseMigrationFiles = (await readdir(migrationDirectory)).filter((name) => /^0004_.*\.sql$/.test(name));
  const migrationFiles = (await readdir(migrationDirectory)).filter((name) => /^0005_.*\.sql$/.test(name));
  assert.equal(purchaseMigrationFiles.length, 1, "expected one 0004 purchase migration");
  assert.equal(migrationFiles.length, 1, "expected one 0005 welcome-email migration");
  const purchaseMigration = await readFile(new URL(purchaseMigrationFiles[0], migrationDirectory), "utf8");
  const migration = await readFile(new URL(migrationFiles[0], migrationDirectory), "utf8");

  const database = new DatabaseSync(":memory:");
  database.exec(purchaseMigration.replaceAll("--> statement-breakpoint", ""));
  database.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const accessDays = database.prepare("SELECT name, dflt_value AS defaultValue FROM pragma_table_info('founding_purchases') WHERE name='access_days'").get();
  assert.equal(accessDays.name, "access_days");
  assert.equal(accessDays.defaultValue, "90");

  database.prepare("INSERT INTO founding_purchases (id,product_id) VALUES (?,?)").run("purchase-1", "product-1");
  const insert = database.prepare(`INSERT INTO customer_email_deliveries
    (id,purchase_id,message_kind,status) VALUES (?,?,?,'pending')`);
  insert.run("delivery-1", "purchase-1", "purchase-welcome-v1");
  assert.throws(
    () => insert.run("delivery-2", "purchase-1", "purchase-welcome-v1"),
    /UNIQUE constraint failed/,
  );
});

test("welcome-email migration applies when the runtime already added access duration", async () => {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationDirectory)).filter((name) => /^0005_.*\.sql$/.test(name));
  const migration = await readFile(new URL(migrationFiles[0], migrationDirectory), "utf8");
  const database = new DatabaseSync(":memory:");

  database.exec(`CREATE TABLE founding_purchases (
    id TEXT PRIMARY KEY NOT NULL,
    access_days INTEGER NOT NULL DEFAULT 90
  )`);

  assert.doesNotThrow(() => database.exec(migration.replaceAll("--> statement-breakpoint", "")));
});
