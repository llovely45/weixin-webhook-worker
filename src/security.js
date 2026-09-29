const encoder = new TextEncoder();
const decoder = new TextDecoder();
const COOKIE_NAME = "__Host-weixin_admin";
const SESSION_SECONDS = 8 * 60 * 60;
const TICKET_SECONDS = 5 * 60;

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("invalid_encoding");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function requiredSecret(value, name) {
  if (typeof value !== "string" || value.length < 16) {
    throw new Error(`${name.toLowerCase()}_not_configured`);
  }
  return value;
}

async function hmacKey(secret, purpose) {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${purpose}:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signPayload(payload, secret, purpose) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, purpose);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

async function verifyPayload(token, secret, purpose) {
  if (typeof token !== "string" || token.length > 12_000) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await hmacKey(secret, purpose);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(parts[1]), encoder.encode(parts[0]));
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(parts[0])));
    if (!payload || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function createSession(env) {
  const secret = requiredSecret(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
  const session = {
    sid: crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };
  const value = await signPayload(session, secret, "weixin-admin-session-v2");
  return {
    session,
    cookie: `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
  };
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export async function verifySession(request, env) {
  const secret = requiredSecret(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
  const value = readCookie(request, COOKIE_NAME);
  if (!value) return null;
  const session = await verifyPayload(value, secret, "weixin-admin-session-v2");
  return typeof session?.sid === "string" ? session : null;
}

export function clearSession() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function sealTicket(payload, env) {
  const secret = requiredSecret(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
  const issuedAt = Number.isSafeInteger(payload?.iat) ? payload.iat : Math.floor(Date.now() / 1000);
  const ticket = {
    ...payload,
    iat: issuedAt,
    exp: Number.isSafeInteger(payload?.exp) ? payload.exp : issuedAt + TICKET_SECONDS,
  };
  if (ticket.exp - ticket.iat > TICKET_SECONDS || ticket.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("invalid_qr_ticket");
  }
  return signPayload(ticket, secret, "weixin-qr-ticket-v1");
}

export async function openTicket(ticket, env) {
  const secret = requiredSecret(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
  const payload = await verifyPayload(ticket, secret, "weixin-qr-ticket-v1");
  if (
    !payload ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat > Math.floor(Date.now() / 1000) + 60 ||
    payload.exp - payload.iat > TICKET_SECONDS
  ) return null;
  return payload;
}

async function encryptionKey(env) {
  const secret = requiredSecret(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`weixin-account-encryption-v1:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptProtectedRecord(record, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const plaintext = encoder.encode(JSON.stringify(record));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose), tagLength: 128 },
    key,
    plaintext,
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptProtectedRecord(value, env, purpose, errorCode) {
  if (typeof value !== "string" || value.length > 64_000) throw new Error(errorCode);
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra) throw new Error(errorCode);
  try {
    const key = await encryptionKey(env);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(encodedIv),
        additionalData: encoder.encode(purpose),
        tagLength: 128,
      },
      key,
      fromBase64Url(encodedCiphertext),
    );
    const record = JSON.parse(decoder.decode(plaintext));
    if (!record || typeof record.id !== "string") throw new Error(errorCode);
    return record;
  } catch {
    throw new Error(errorCode);
  }
}

export async function encryptRecord(record, env) {
  return encryptProtectedRecord(record, env, "weixin-account:v1");
}

export async function decryptRecord(value, env) {
  return decryptProtectedRecord(value, env, "weixin-account:v1", "account_record_unreadable");
}

export async function encryptReminderRecord(record, env) {
  return encryptProtectedRecord(record, env, "weixin-reminder:v1");
}

export async function decryptReminderRecord(value, env) {
  return decryptProtectedRecord(value, env, "weixin-reminder:v1", "reminder_record_unreadable");
}

export async function hashSecret(secret) {
  if (typeof secret !== "string" || !secret) throw new Error("secret_required");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return toBase64Url(new Uint8Array(digest));
}

export async function hashAdminPassword(password, salt, env) {
  const secret = requiredSecret(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
  if (typeof password !== "string" || typeof salt !== "string" || !salt) {
    throw new Error("invalid_admin_password");
  }
  const key = await hmacKey(secret, "weixin-admin-password-v1");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${salt}:${password}`));
  return toBase64Url(new Uint8Array(signature));
}

export function constantTimeStringEqual(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}
