/**
 * Envelope encryption for sensitive values (primarily OAuth refresh tokens).
 *
 * Approach: AES-256-GCM with the master key from PORTAGE_ENCRYPTION_KEY.
 * Each encryption produces a unique IV (initialization vector) and auth tag,
 * both of which are stored alongside the ciphertext in the database.
 *
 * For now the "master key" is a single env var. When we move to production,
 * this module is the single place to swap in KMS-backed key management
 * (AWS KMS, Google Cloud KMS, Doppler) without touching any calling code.
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // GCM standard

function getMasterKey(): Buffer {
  const rawKey = process.env.PORTAGE_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error("PORTAGE_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(rawKey, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `PORTAGE_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes; got ${key.length}. ` +
        `Generate a new one with: openssl rand -base64 32`
    );
  }
  return key;
}

export type EncryptedValue = {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
};

export function encrypt(plaintext: string): EncryptedValue {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decrypt(value: EncryptedValue): string {
  const key = getMasterKey();
  const iv = Buffer.from(value.iv, "base64");
  const authTag = Buffer.from(value.authTag, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * Generate a signed state token for OAuth CSRF protection.
 * Returns a random token; the same token is stored in the oauth_states table
 * so the callback can verify it.
 */
export function generateStateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}