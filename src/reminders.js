import { decryptReminderRecord, encryptReminderRecord } from "./security.js";

const REMINDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LEASE_MILLISECONDS = 2 * 60_000;

function store(env) {
  if (!env.WEIXIN_ACCOUNTS || typeof env.WEIXIN_ACCOUNTS.prepare !== "function") {
    throw new Error("account_store_unavailable");
  }
  return env.WEIXIN_ACCOUNTS;
}

function parseRow(row, content) {
  return {
    id: row.id,
    accountId: row.account_id,
    nextRunAt: Number(row.next_run_at),
    frequency: row.frequency,
    timezone: row.timezone,
    anchorYear: Number(row.anchor_year),
    anchorMonth: Number(row.anchor_month),
    anchorDay: Number(row.anchor_day),
    localHour: Number(row.local_hour),
    localMinute: Number(row.local_minute),
    text: content.text,
    lastError: row.last_error || null,
    leaseUntil: row.lease_until === null ? null : Number(row.lease_until),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function decryptRow(row, env) {
  const value = await decryptReminderRecord(row.value, env);
  if (value.id !== row.id || typeof value.text !== "string") throw new Error("reminder_record_unreadable");
  return parseRow(row, value);
}

const ROW_COLUMNS = `id, account_id, next_run_at, frequency, timezone, anchor_year, anchor_month,
  anchor_day, local_hour, local_minute, value, last_error, lease_until, created_at, updated_at`;

export async function listReminders(env) {
  const { results = [] } = await store(env)
    .prepare(`SELECT ${ROW_COLUMNS} FROM reminder_tasks ORDER BY next_run_at, created_at`)
    .all();
  return Promise.all(results.map((row) => decryptRow(row, env)));
}

export async function getReminder(env, reminderId) {
  if (typeof reminderId !== "string" || !REMINDER_ID.test(reminderId)) return null;
  const row = await store(env)
    .prepare(`SELECT ${ROW_COLUMNS} FROM reminder_tasks WHERE id = ?`)
    .bind(reminderId)
    .first();
  return row ? decryptRow(row, env) : null;
}

export async function createReminder(env, reminder, createdAt = Date.now()) {
  const id = crypto.randomUUID();
  const value = await encryptReminderRecord({ id, text: reminder.text }, env);
  await store(env)
    .prepare(`INSERT INTO reminder_tasks (
      id, account_id, next_run_at, frequency, timezone, anchor_year, anchor_month, anchor_day,
      local_hour, local_minute, value, last_error, lease_token, lease_until, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
    .bind(
      id,
      reminder.accountId,
      reminder.nextRunAt,
      reminder.frequency,
      reminder.timezone,
      reminder.anchorYear,
      reminder.anchorMonth,
      reminder.anchorDay,
      reminder.localHour,
      reminder.localMinute,
      value,
      createdAt,
      createdAt,
    )
    .run();
  return { ...reminder, id, createdAt, updatedAt: createdAt, lastError: null, leaseUntil: null };
}

export async function updateReminder(env, reminderId, reminder, updatedAt = Date.now()) {
  const value = await encryptReminderRecord({ id: reminderId, text: reminder.text }, env);
  const result = await store(env)
    .prepare(`UPDATE reminder_tasks SET
      account_id = ?, next_run_at = ?, frequency = ?, timezone = ?, anchor_year = ?, anchor_month = ?, anchor_day = ?,
      local_hour = ?, local_minute = ?, value = ?, last_error = NULL, updated_at = ?
      WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)`)
    .bind(
      reminder.accountId,
      reminder.nextRunAt,
      reminder.frequency,
      reminder.timezone,
      reminder.anchorYear,
      reminder.anchorMonth,
      reminder.anchorDay,
      reminder.localHour,
      reminder.localMinute,
      value,
      updatedAt,
      reminderId,
      updatedAt,
    )
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function deleteReminder(env, reminderId, now = Date.now()) {
  const result = await store(env)
    .prepare("DELETE FROM reminder_tasks WHERE id = ? AND (lease_until IS NULL OR lease_until <= ?)")
    .bind(reminderId, now)
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function deleteRemindersForAccount(env, accountId) {
  await store(env).prepare("DELETE FROM reminder_tasks WHERE account_id = ?").bind(accountId).run();
}

export async function listDueReminderIds(env, now = Date.now(), limit = 100) {
  const { results = [] } = await store(env)
    .prepare(`SELECT id FROM reminder_tasks
      WHERE next_run_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY next_run_at, created_at LIMIT ?`)
    .bind(now, now, limit)
    .all();
  return results.map((row) => row.id);
}

export async function claimReminder(env, reminderId, now = Date.now()) {
  const leaseToken = crypto.randomUUID();
  const result = await store(env)
    .prepare(`UPDATE reminder_tasks SET lease_token = ?, lease_until = ?
      WHERE id = ? AND next_run_at <= ? AND (lease_until IS NULL OR lease_until <= ?)`)
    .bind(leaseToken, now + LEASE_MILLISECONDS, reminderId, now, now)
    .run();
  if (Number(result.meta?.changes || 0) === 0) return null;
  const reminder = await getReminder(env, reminderId);
  return reminder ? { ...reminder, leaseToken } : null;
}

export async function completeOneTimeReminder(env, reminderId, leaseToken) {
  const result = await store(env)
    .prepare("DELETE FROM reminder_tasks WHERE id = ? AND lease_token = ?")
    .bind(reminderId, leaseToken)
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function discardClaimedReminder(env, reminderId, leaseToken) {
  const result = await store(env)
    .prepare("DELETE FROM reminder_tasks WHERE id = ? AND lease_token = ?")
    .bind(reminderId, leaseToken)
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function completeRecurringReminder(env, reminderId, leaseToken, nextRunAt, updatedAt = Date.now()) {
  const result = await store(env)
    .prepare(`UPDATE reminder_tasks SET next_run_at = ?, lease_token = NULL, lease_until = NULL,
      last_error = NULL, updated_at = ? WHERE id = ? AND lease_token = ?`)
    .bind(nextRunAt, updatedAt, reminderId, leaseToken)
    .run();
  return Number(result.meta?.changes || 0) > 0;
}

export async function failReminder(env, reminderId, leaseToken, errorCode) {
  await store(env)
    .prepare(`UPDATE reminder_tasks SET lease_token = NULL, lease_until = NULL, last_error = ?
      WHERE id = ? AND lease_token = ?`)
    .bind(errorCode, reminderId, leaseToken)
    .run();
}
