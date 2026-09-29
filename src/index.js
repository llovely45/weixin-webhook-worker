import QRCode from "qrcode-svg";
import { createAdminCredential, getAdminCredential } from "./admin-credentials.js";
import { deleteAccount, getAccount, listAccounts, makeAccountId, putAccount } from "./accounts.js";
import { pollQrLogin, pollUpdates, sendText, startQrLogin } from "./ilink.js";
import {
  claimReminder,
  completeOneTimeReminder,
  completeRecurringReminder,
  createReminder,
  deleteReminder,
  deleteRemindersForAccount,
  discardClaimedReminder,
  failReminder,
  getReminder,
  listDueReminderIds,
  listReminders,
  updateReminder,
} from "./reminders.js";
import { buildReminderSchedule, formatReminderAnchor, nextReminderOccurrence } from "./reminder-time.js";
import {
  clearSession,
  constantTimeStringEqual,
  createSession,
  hashAdminPassword,
  hashSecret,
  openTicket,
  sealTicket,
  verifySession,
} from "./security.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_LENGTH = 4000;
const TEST_MESSAGE_TEXT = "你好！这里是Cloudflare事务宣传部！";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, headers });
}

function methodNotAllowed(methods) {
  return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: methods.join(", ") });
}

function requireSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin !== new URL(request.url).origin) throw new ApiError(403, "same_origin_required");
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) throw new ApiError(415, "json_required");
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large");
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value;
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

async function requireAdmin(request, env) {
  const session = await verifySession(request, env);
  if (!session) throw new ApiError(401, "admin_login_required");
  return session;
}

function accountSummary(account) {
  return {
    id: account.id,
    displayName: account.displayName,
    defaultRecipient: account.defaultRecipient,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt || null,
  };
}

function reminderSummary(reminder, accountNames = new Map()) {
  return {
    id: reminder.id,
    accountId: reminder.accountId,
    accountName: accountNames.get(reminder.accountId) || reminder.accountId,
    text: reminder.text,
    at: formatReminderAnchor(reminder),
    nextRunAt: reminder.nextRunAt,
    frequency: reminder.frequency,
    timezone: reminder.timezone,
    lastError: reminder.lastError,
    isSending: Number.isFinite(reminder.leaseUntil) && reminder.leaseUntil > Date.now(),
    createdAt: reminder.createdAt,
    updatedAt: reminder.updatedAt,
  };
}

function randomSecret(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isValidAdminPassword(password) {
  return typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 1024 &&
    /[A-Za-z]/u.test(password) &&
    /[0-9]/u.test(password) &&
    /[\p{P}\p{S}]/u.test(password);
}

function jsonForStatus(status, extra = {}) {
  return json({ ok: true, status, ...extra });
}

async function serveAdminAsset(request, env, path, isDocument = false) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return json({ ok: false, error: "admin_assets_unavailable" }, 503);
  }
  const assetUrl = new URL(path, request.url);
  const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
  if (!assetResponse.ok) return new Response("Not found", { status: 404 });
  const headers = new Headers(assetResponse.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isDocument) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:",
    );
  }
  return new Response(assetResponse.body, { status: assetResponse.status, headers });
}

async function handleAdminLogin(request, env) {
  requireSameOrigin(request);
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const input = await readJson(request);
  if (typeof input.password !== "string" || input.password.length > 1024) {
    throw new ApiError(401, "invalid_credentials");
  }
  const credential = await getAdminCredential(env);
  if (!credential) throw new ApiError(409, "admin_setup_required");
  const suppliedHash = await hashAdminPassword(input.password, credential.salt, env);
  const expectedHash = credential.password_hash;
  if (!constantTimeStringEqual(suppliedHash, expectedHash)) throw new ApiError(401, "invalid_credentials");
  const session = await createSession(env);
  return json({ ok: true }, 200, { "Set-Cookie": session.cookie });
}

async function handleAdminStatus(request, env) {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const credential = await getAdminCredential(env);
  return json({ ok: true, initialized: Boolean(credential) });
}

async function handleAdminSetup(request, env) {
  requireSameOrigin(request);
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (await getAdminCredential(env)) throw new ApiError(409, "admin_already_initialized");
  const input = await readJson(request);
  if (!isValidAdminPassword(input.password)) {
    throw new ApiError(400, "invalid_admin_password");
  }

  const salt = randomSecret(24);
  const passwordHash = await hashAdminPassword(input.password, salt, env);
  const created = await createAdminCredential(env, { salt, passwordHash, createdAt: Date.now() });
  if (!created) throw new ApiError(409, "admin_already_initialized");
  const session = await createSession(env);
  return json({ ok: true }, 200, { "Set-Cookie": session.cookie });
}

async function handleQrStart(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  requireSameOrigin(request);
  const session = await requireAdmin(request, env);
  const accounts = await listAccounts(env);
  const tokens = accounts.map((account) => account.botToken).filter((token) => typeof token === "string").slice(-10);
  const qr = await startQrLogin(tokens, env);
  const ticket = await sealTicket({ sid: session.sid, qrcode: qr.qrcode, baseUrl: qr.baseUrl }, env);
  const qrSvg = new QRCode({
    content: qr.qrcodeImgContent,
    padding: 4,
    width: 280,
    height: 280,
    color: "#111827",
    background: "#ffffff",
    ecl: "M",
    join: true,
    container: "svg-viewbox",
    xmlDeclaration: false,
  }).svg();
  if (qrSvg.length > 64 * 1024) throw new ApiError(502, "qr_render_failed");
  return json({ ok: true, ticket, qrSvg, expiresAt: Date.now() + 5 * 60_000 });
}

async function handleQrPoll(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  requireSameOrigin(request);
  const session = await requireAdmin(request, env);
  const input = await readJson(request);
  const ticket = await openTicket(input.ticket, env);
  if (!ticket || ticket.sid !== session.sid || typeof ticket.qrcode !== "string" || typeof ticket.baseUrl !== "string") {
    throw new ApiError(401, "invalid_or_expired_qr_ticket");
  }
  if (input.verifyCode !== undefined && (typeof input.verifyCode !== "string" || !/^\d{1,12}$/u.test(input.verifyCode))) {
    throw new ApiError(400, "invalid_verify_code");
  }
  const result = await pollQrLogin(
    { qrcode: ticket.qrcode, baseUrl: ticket.baseUrl, verifyCode: input.verifyCode },
    env,
  );
  if (result.status === "redirect") {
    const nextTicket = await sealTicket(
      { sid: session.sid, qrcode: ticket.qrcode, baseUrl: result.baseUrl, iat: ticket.iat, exp: ticket.exp },
      env,
    );
    return jsonForStatus("redirect", { ticket: nextTicket });
  }
  if (result.status !== "confirmed") return jsonForStatus(result.status);

  const existing = await listAccounts(env);
  const duplicate = existing.find((account) => account.botId === result.account.botId);
  if (duplicate) return jsonForStatus("already_connected", { account: accountSummary(duplicate) });

  const webhookSecret = randomSecret();
  const createdAt = Date.now();
  const account = {
    id: makeAccountId(),
    botId: result.account.botId,
    botToken: result.account.botToken,
    baseUrl: result.account.baseUrl,
    scannerUserId: result.account.scannerUserId,
    displayName: `微信账号 ${existing.length + 1}`,
    defaultRecipient: result.account.scannerUserId,
    webhookSecretHash: await hashSecret(webhookSecret),
    createdAt,
  };
  await putAccount(env, account);
  return jsonForStatus("confirmed", { account: accountSummary(account), webhookSecret });
}

async function sendAccountText(account, text, env) {
  try {
    return await sendText(account, text, env);
  } catch (error) {
    if (error?.message === "weixin_send_failed" && error.upstreamRet === -2) {
      account.contextToken = "";
      await putAccount(env, account);
      throw new Error("weixin_context_missing");
    }
    throw error;
  }
}

function reminderInputFields(input, { existing = null, fixedAccountId = null, fixedText = undefined, scheduleOnly = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_reminder_schedule");
  }
  const allowed = new Set(scheduleOnly ? ["at", "frequency", "timezone"] : ["accountId", "text", "at", "frequency", "timezone"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new ApiError(400, "unsupported_reminder_field");

  const accountId = fixedAccountId || (Object.hasOwn(input, "accountId") ? input.accountId : existing?.accountId);
  if (typeof accountId !== "string" || !UUID_RE.test(accountId)) {
    throw new ApiError(400, "invalid_reminder_account");
  }
  const text = fixedText !== undefined ? fixedText : Object.hasOwn(input, "text") ? input.text : existing?.text;
  if (typeof text !== "string" || !text.trim()) throw new ApiError(400, "text_required");
  if (text.trim().length > MAX_TEXT_LENGTH) throw new ApiError(413, "text_too_long");

  const scheduleTouched = ["at", "frequency", "timezone"].some((key) => Object.hasOwn(input, key));
  let schedule;
  if (existing && !scheduleTouched) {
    schedule = {
      nextRunAt: existing.nextRunAt,
      frequency: existing.frequency,
      timezone: existing.timezone,
      anchorYear: existing.anchorYear,
      anchorMonth: existing.anchorMonth,
      anchorDay: existing.anchorDay,
      localHour: existing.localHour,
      localMinute: existing.localMinute,
    };
  } else {
    schedule = buildReminderSchedule({
      at: Object.hasOwn(input, "at") ? input.at : existing ? formatReminderAnchor(existing) : undefined,
      frequency: input.frequency === undefined ? existing?.frequency : input.frequency,
      timezone: input.timezone === undefined ? existing?.timezone : input.timezone,
    });
  }
  return { ...schedule, accountId, text: text.trim() };
}

async function requireConnectedAccount(env, accountId) {
  const account = await getAccount(env, accountId);
  if (!account) throw new ApiError(404, "account_not_found");
  return account;
}

async function handleReminders(request, env, url) {
  if (url.pathname === "/api/reminders") {
    if (request.method === "GET") {
      await requireAdmin(request, env);
      const [reminders, accounts] = await Promise.all([listReminders(env), listAccounts(env)]);
      const names = new Map(accounts.map((account) => [account.id, account.displayName]));
      return json({ ok: true, reminders: reminders.map((reminder) => reminderSummary(reminder, names)) });
    }
    if (request.method !== "POST") return methodNotAllowed(["GET", "POST"]);
    await requireAdmin(request, env);
    requireSameOrigin(request);
    const input = await readJson(request);
    const reminder = reminderInputFields(input);
    const account = await requireConnectedAccount(env, reminder.accountId);
    const created = await createReminder(env, reminder);
    return json({ ok: true, reminder: reminderSummary({ ...created, accountId: account.id }, new Map([[account.id, account.displayName]])) }, 201);
  }

  const match = /^\/api\/reminders\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (!match) return null;
  const reminderId = match[1];
  if (!UUID_RE.test(reminderId)) throw new ApiError(404, "reminder_not_found");
  await requireAdmin(request, env);
  requireSameOrigin(request);

  if (request.method === "DELETE") {
    const reminder = await getReminder(env, reminderId);
    if (!reminder) throw new ApiError(404, "reminder_not_found");
    if (!await deleteReminder(env, reminderId)) throw new ApiError(409, "reminder_in_progress");
    return json({ ok: true });
  }
  if (request.method !== "PATCH") return methodNotAllowed(["PATCH", "DELETE"]);

  const existing = await getReminder(env, reminderId);
  if (!existing) throw new ApiError(404, "reminder_not_found");
  if (existing.leaseUntil > Date.now()) throw new ApiError(409, "reminder_in_progress");
  const input = await readJson(request);
  if (!Object.keys(input).length) throw new ApiError(400, "empty_reminder_update");
  const reminder = reminderInputFields(input, { existing });
  const account = await requireConnectedAccount(env, reminder.accountId);
  if (!await updateReminder(env, reminderId, reminder)) throw new ApiError(409, "reminder_in_progress");
  const updated = await getReminder(env, reminderId);
  return json({ ok: true, reminder: reminderSummary(updated, new Map([[account.id, account.displayName]])) });
}

async function handleAccounts(request, env, url) {
  if (request.method === "GET" && url.pathname === "/api/accounts") {
    await requireAdmin(request, env);
    const accounts = await listAccounts(env);
    return json({ ok: true, accounts: accounts.map(accountSummary) });
  }

  const testMessageMatch = /^\/api\/accounts\/([0-9a-f-]+)\/test-message$/iu.exec(url.pathname);
  const match = /^\/api\/accounts\/([0-9a-f-]+)$/iu.exec(url.pathname);
  if (!testMessageMatch && !match) return null;
  const accountId = testMessageMatch?.[1] || match[1];
  if (!UUID_RE.test(accountId)) throw new ApiError(404, "account_not_found");
  await requireAdmin(request, env);
  requireSameOrigin(request);

  if (testMessageMatch) {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    const account = await getAccount(env, accountId);
    if (!account) throw new ApiError(404, "account_not_found");
    const result = await sendAccountText(account, TEST_MESSAGE_TEXT, env);
    return json({ ok: true, messageId: result.messageId });
  }

  if (request.method === "DELETE") {
    const deleted = await deleteAccount(env, accountId);
    if (!deleted) throw new ApiError(404, "account_not_found");
    await deleteRemindersForAccount(env, accountId);
    return json({ ok: true });
  }
  if (request.method !== "PATCH") return methodNotAllowed(["PATCH", "DELETE"]);

  const input = await readJson(request);
  const allowed = new Set(["displayName", "defaultRecipient", "rotateWebhookSecret"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new ApiError(400, "unsupported_account_field");
  const account = await getAccount(env, accountId);
  if (!account) throw new ApiError(404, "account_not_found");

  let webhookSecret;
  if (Object.hasOwn(input, "displayName")) {
    if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.trim().length > 80) {
      throw new ApiError(400, "invalid_display_name");
    }
    account.displayName = input.displayName.trim();
  }
  if (Object.hasOwn(input, "defaultRecipient")) {
    if (typeof input.defaultRecipient !== "string" || !input.defaultRecipient.trim() || input.defaultRecipient.trim().length > 512) {
      throw new ApiError(400, "invalid_default_recipient");
    }
    const nextRecipient = input.defaultRecipient.trim();
    if (nextRecipient !== account.defaultRecipient) {
      account.contextToken = "";
    }
    account.defaultRecipient = nextRecipient;
  }
  if (Object.hasOwn(input, "rotateWebhookSecret")) {
    if (input.rotateWebhookSecret !== true) throw new ApiError(400, "invalid_secret_rotation_request");
    webhookSecret = randomSecret();
    account.webhookSecretHash = await hashSecret(webhookSecret);
  }
  if (!Object.keys(input).length) throw new ApiError(400, "empty_account_update");
  account.updatedAt = Date.now();
  await putAccount(env, account);
  return json({ ok: true, account: accountSummary(account), ...(webhookSecret ? { webhookSecret } : {}) });
}

async function handleNotify(request, env) {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  const input = await readJson(request);
  if (typeof input.accountId !== "string" || !UUID_RE.test(input.accountId)) {
    throw new ApiError(401, "unauthorized");
  }
  if (typeof input.text !== "string" || !input.text.trim()) throw new ApiError(400, "text_required");
  const text = input.text.trim();
  if (text.length > MAX_TEXT_LENGTH) throw new ApiError(413, "text_too_long");

  const authorization = request.headers.get("Authorization") || "";
  const bearerMatch = /^Bearer ([A-Za-z0-9_-]{32,128})$/u.exec(authorization);
  const account = await getAccount(env, input.accountId);
  if (!bearerMatch || !account) throw new ApiError(401, "unauthorized");
  const suppliedHash = await hashSecret(bearerMatch[1]);
  if (!constantTimeStringEqual(suppliedHash, account.webhookSecretHash)) throw new ApiError(401, "unauthorized");

  if (Object.hasOwn(input, "reminder")) {
    const reminder = reminderInputFields(input.reminder, {
      fixedAccountId: account.id,
      fixedText: text,
      scheduleOnly: true,
    });
    const created = await createReminder(env, reminder);
    return json({
      ok: true,
      status: "scheduled",
      reminderId: created.id,
      nextRunAt: new Date(created.nextRunAt).toISOString(),
      frequency: created.frequency,
      timezone: created.timezone,
    }, 202);
  }

  const result = await sendAccountText(account, text, env);
  return json({ ok: true, messageId: result.messageId });
}

async function pollAccount(env, account) {
  try {
    const updates = await pollUpdates(account, env);
    let changed = updates.getUpdatesBuf !== account.getUpdatesBuf;
    account.getUpdatesBuf = updates.getUpdatesBuf;
    for (const message of updates.messages) {
      if (
        message &&
        message.from_user_id === account.defaultRecipient &&
        typeof message.context_token === "string" &&
        message.context_token.length > 0 &&
        message.context_token.length <= 8192 &&
        message.context_token !== account.contextToken
      ) {
        account.contextToken = message.context_token;
        changed = true;
      }
    }
    if (changed) await putAccount(env, account);
  } catch (error) {
    const code = typeof error?.message === "string" && /^[a-z0-9_]{1,64}$/u.test(error.message)
      ? error.message
      : "weixin_updates_failed";
    console.warn("weixin_updates_poll_failed", code);
  }
}

async function handleScheduled(env) {
  const accounts = await listAccounts(env);
  for (let index = 0; index < accounts.length; index += 5) {
    await Promise.all(accounts.slice(index, index + 5).map((account) => pollAccount(env, account)));
  }

  const dueReminderIds = await listDueReminderIds(env);
  for (let index = 0; index < dueReminderIds.length; index += 5) {
    await Promise.all(dueReminderIds.slice(index, index + 5).map(async (reminderId) => {
      const reminder = await claimReminder(env, reminderId);
      if (!reminder) return;
      try {
        const account = await getAccount(env, reminder.accountId);
        if (!account) {
          await discardClaimedReminder(env, reminder.id, reminder.leaseToken);
          return;
        }
        await sendAccountText(account, reminder.text, env);
        if (reminder.frequency === "once") {
          await completeOneTimeReminder(env, reminder.id, reminder.leaseToken);
          return;
        }
        const nextRunAt = nextReminderOccurrence(reminder, Date.now());
        await completeRecurringReminder(env, reminder.id, reminder.leaseToken, nextRunAt);
      } catch (error) {
        const code = typeof error?.message === "string" && /^[a-z0-9_]{1,64}$/u.test(error.message)
          ? error.message
          : "weixin_send_failed";
        await failReminder(env, reminder.id, reminder.leaseToken, code);
        console.warn("reminder_delivery_failed", code);
      }
    }));
  }
}

const ERROR_STATUSES = new Map([
  ["invalid_credentials", 401],
  ["admin_login_required", 401],
  ["admin_setup_required", 409],
  ["admin_already_initialized", 409],
  ["unauthorized", 401],
  ["invalid_or_expired_qr_ticket", 401],
  ["same_origin_required", 403],
  ["json_required", 415],
  ["payload_too_large", 413],
  ["text_too_long", 413],
  ["text_required", 400],
  ["invalid_json", 400],
  ["invalid_verify_code", 400],
  ["unsupported_account_field", 400],
  ["invalid_display_name", 400],
  ["invalid_default_recipient", 400],
  ["invalid_secret_rotation_request", 400],
  ["empty_account_update", 400],
  ["account_not_found", 404],
  ["reminder_not_found", 404],
  ["invalid_reminder_schedule", 400],
  ["invalid_reminder_time", 400],
  ["invalid_reminder_frequency", 400],
  ["invalid_reminder_timezone", 400],
  ["invalid_reminder_account", 400],
  ["unsupported_reminder_field", 400],
  ["empty_reminder_update", 400],
  ["reminder_in_progress", 409],
  ["invalid_admin_password", 400],
  ["data_encryption_key_not_configured", 503],
  ["account_store_unavailable", 503],
  ["reminder_record_unreadable", 500],
  ["reminder_next_occurrence_unavailable", 500],
  ["invalid_channel_version", 503],
  ["weixin_upstream_unreachable", 502],
  ["weixin_upstream_timeout", 504],
  ["weixin_qr_start_failed", 502],
  ["invalid_weixin_qr_response", 502],
  ["invalid_weixin_response", 502],
  ["weixin_response_too_large", 502],
  ["weixin_qr_poll_failed", 502],
  ["invalid_weixin_base_url", 502],
  ["invalid_weixin_redirect_host", 502],
  ["invalid_weixin_login_response", 502],
  ["weixin_send_failed", 502],
  ["account_send_not_configured", 502],
  ["weixin_context_missing", 409],
  ["weixin_updates_failed", 502],
  ["invalid_weixin_updates_response", 502],
  ["qr_render_failed", 502],
]);

function safeErrorResponse(error) {
  if (error instanceof ApiError) return json({ ok: false, error: error.code }, error.status);
  const code = typeof error?.message === "string" ? error.message : "";
  if (code === "weixin_send_failed") {
    const details = {
      ok: false,
      error: code,
      ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
      ...(Number.isInteger(error.upstreamRet) ? { upstreamRet: error.upstreamRet } : {}),
      ...(Number.isInteger(error.upstreamErrcode) ? { upstreamErrcode: error.upstreamErrcode } : {}),
    };
    return json(details, 502);
  }
  const qrHttpFailure = /^weixin_qr_upstream_http_(\d{3})$/u.exec(code);
  if (qrHttpFailure) {
    return json({ ok: false, error: "weixin_qr_upstream_http_error", upstreamStatus: Number(qrHttpFailure[1]) }, 502);
  }
  const status = ERROR_STATUSES.get(code);
  if (status) return json({ ok: false, error: code }, status);
  if (code === "account_record_unreadable") return json({ ok: false, error: code }, 500);
  return json({ ok: false, error: "internal_error" }, 500);
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/") return Response.redirect(new URL("/admin", url), 302);
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (request.method !== "GET") return methodNotAllowed(["GET"]);
    return serveAdminAsset(request, env, "/admin.html", true);
  }

  if (url.pathname === "/api/admin/login") return handleAdminLogin(request, env);
  if (url.pathname === "/api/admin/status") return handleAdminStatus(request, env);
  if (url.pathname === "/api/admin/setup") return handleAdminSetup(request, env);
  if (url.pathname === "/api/admin/logout") {
    if (request.method !== "POST") return methodNotAllowed(["POST"]);
    requireSameOrigin(request);
    return json({ ok: true }, 200, { "Set-Cookie": clearSession() });
  }
  if (url.pathname === "/api/accounts" || /^\/api\/accounts\//u.test(url.pathname)) {
    const result = await handleAccounts(request, env, url);
    if (result) return result;
  }
  if (url.pathname === "/api/reminders" || /^\/api\/reminders\//u.test(url.pathname)) {
    const result = await handleReminders(request, env, url);
    if (result) return result;
  }
  if (url.pathname === "/api/login/start") return handleQrStart(request, env);
  if (url.pathname === "/api/login/poll") return handleQrPoll(request, env);
  if (url.pathname === "/notify") return handleNotify(request, env);
  if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "not_found" }, 404);

  if (request.method === "GET" && env.ASSETS) return serveAdminAsset(request, env, url.pathname);
  return new Response("Not found", { status: 404, headers: { "X-Content-Type-Options": "nosniff" } });
}

export default {
  async scheduled(_controller, env) {
    await handleScheduled(env);
  },
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      return safeErrorResponse(error);
    }
  },
};
