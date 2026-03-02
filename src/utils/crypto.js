import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts a string value.
 * Returns "iv:authTag:ciphertext" (all hex), or null/undefined as-is.
 * If ENCRYPTION_KEY is not set, returns the value as plain text.
 */
export function encrypt(value) {
  if (value == null) return value;
  const key = getKey();
  if (!key) return String(value);
  const text = String(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a value encrypted by encrypt().
 * Returns the original string, or the value as-is if it wasn't encrypted.
 * If ENCRYPTION_KEY is not set, returns the value as-is.
 */
export function decrypt(value) {
  if (value == null) return value;
  const key = getKey();
  if (!key) return value;
  const parts = String(value).split(":");
  if (parts.length !== 3) return value; // not encrypted
  try {
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return value; // return as-is if decryption fails
  }
}
