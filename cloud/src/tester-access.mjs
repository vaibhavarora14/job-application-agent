import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const derive = promisify(scrypt);
const contexts = new WeakMap();
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');

export function hostingReady(env) {
  try {
    const url = new URL(env.CLOUD_TESTER_ORIGIN);
    return env.CLOUD_TESTER_HOSTED === '1' && isAbsolute(env.CLOUD_TESTER_DATA_DIR || '') &&
      url.protocol === 'https:' && url.origin === env.CLOUD_TESTER_ORIGIN &&
      !url.username && !url.password && url.hostname.includes('.') &&
      !/^(localhost|127\.|0\.)|\.localhost$|^\[|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
  } catch { return false; }
}

function accessDb(env) {
  if (!hostingReady(env)) throw new Error('Tester hosting is not configured.');
  mkdirSync(env.CLOUD_TESTER_DATA_DIR, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(env.CLOUD_TESTER_DATA_DIR, 'access.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS invites (digest TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL, redeemed_by TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  return db;
}

function emailAddress(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email.');
  return email;
}

export function issueInvite(email, env, { expiresAt = Date.now() + 48 * 3600000 } = {}) {
  email = emailAddress(email);
  const db = accessDb(env);
  const token = randomToken();
  try {
    if (db.prepare('SELECT id FROM accounts WHERE email = ?').get(email)) throw new Error('Account already exists.');
    db.prepare('INSERT INTO invites (digest, email, expires) VALUES (?, ?, ?)').run(hash(token), email, expiresAt);
    // Fragment avoids sending the bearer credential in access logs and referrers.
    return { token, url: `${env.CLOUD_TESTER_ORIGIN}/invite#${token}` };
  } finally { db.close(); }
}

export async function redeemInvite(token, password, env) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('Use a password of 12–128 characters.');
  const salt = randomBytes(16).toString('hex');
  const passwordHash = (await derive(password, salt, 64)).toString('hex');
  const db = accessDb(env);
  try {
    db.exec('BEGIN IMMEDIATE');
    const invite = db.prepare('SELECT * FROM invites WHERE digest = ? AND redeemed_by IS NULL AND expires > ?').get(hash(token), Date.now());
    if (!invite) throw new Error('Invite is invalid, expired or already used.');
    const id = randomUUID();
    db.prepare('INSERT INTO accounts (id, email, salt, password_hash) VALUES (?, ?, ?, ?)').run(id, invite.email, salt, passwordHash);
    db.prepare('UPDATE invites SET redeemed_by = ? WHERE digest = ?').run(id, hash(token));
    db.exec('COMMIT');
    return { id, email: invite.email };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

export async function signIn(email, password, env) {
  const db = accessDb(env);
  try {
    const row = db.prepare('SELECT * FROM accounts WHERE email = ? AND active = 1').get(emailAddress(email));
    const derived = await derive(String(password || '').slice(0, 129), row?.salt || 'unknown-account-salt', 64);
    if (!row || !timingSafeEqual(derived, Buffer.from(row.password_hash, 'hex'))) throw new Error('Invalid sign-in.');
    const token = randomToken();
    db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), row.id, Date.now() + 12 * 3600000);
    return { token };
  } finally { db.close(); }
}

export function authenticate(token, env) {
  const db = accessDb(env);
  try {
    return db.prepare(`SELECT a.id, a.email FROM accounts a JOIN sessions s ON s.account_id = a.id
      JOIN invites i ON i.redeemed_by = a.id WHERE a.active = 1 AND s.digest = ? AND s.expires > ?`).get(hash(token || ''), Date.now()) || null;
  } finally { db.close(); }
}

export function signOut(token, env) {
  const db = accessDb(env);
  try { db.prepare('DELETE FROM sessions WHERE digest = ?').run(hash(token || '')); }
  finally { db.close(); }
}

export function allowAuthAttempt(key, env) {
  const db = accessDb(env);
  try {
    db.prepare('DELETE FROM attempts WHERE expires <= ?').run(Date.now());
    db.prepare(`INSERT INTO attempts VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1`).run(hash(key), Date.now() + 15 * 60000);
    return db.prepare('SELECT count FROM attempts WHERE key = ?').get(hash(key)).count <= 10;
  } finally { db.close(); }
}

export function testerAccounts(env) {
  const db = accessDb(env);
  try { return db.prepare('SELECT a.id FROM accounts a JOIN invites i ON i.redeemed_by = a.id WHERE a.active = 1').all(); }
  finally { db.close(); }
}

export function workspaceEnv(id, env) {
  if (!testerAccounts(env).some(account => account.id === id)) throw new Error('Redeemed invite required.');
  const root = join(env.CLOUD_TESTER_DATA_DIR, 'workspaces', id);
  const scoped = Object.freeze({
    CLOUD_TESTER_MODE: '1', CLOUD_DATA_DIR: root, CLOUD_DB_PATH: join(root, 'cloud.sqlite'),
    JOB_APPLICATION_AGENT_STATE_DIR: join(root, 'skill-state'), CLOUD_BOARDS_PATH: env.CLOUD_BOARDS_PATH,
    CLOUD_SUBMIT_ALLOWLIST: 'greenhouse', CLOUD_ROUTINE_CHANNELS: '',
    OLLAMA_HOST: '', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PLAYWRIGHT_HEADLESS: '1',
  });
  contexts.set(scoped, { id, env });
  return scoped;
}

export const isTester = env => env.CLOUD_TESTER_MODE === '1';

export function testerAuthorized(env) {
  const context = contexts.get(env);
  return Boolean(context && hostingReady(context.env) && testerAccounts(context.env).some(account => account.id === context.id));
}
