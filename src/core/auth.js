import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export function signatureFor(secret, timestamp, body) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export function verifySignature({ secret, timestamp, body, signature, now = Date.now() }) {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || Math.abs(now - parsed) > 5 * 60_000) {
    return false;
  }

  const expected = Buffer.from(signatureFor(secret, timestamp, body), "hex");
  const received = Buffer.from(signature ?? "", "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Password must contain at least 12 characters");
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 32);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  const [scheme, saltHex, hashHex] = String(encoded ?? "").split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export function createSessionToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  const [encoded, signature] = String(token ?? "").split(".");
  if (!encoded || !signature) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return Number(payload.exp) > now ? payload : null;
  } catch {
    return null;
  }
}
