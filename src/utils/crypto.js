import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error("ENCRYPTION_KEY must be 64 hex chars in .env");
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts a string value.
 * Returns "iv:authTag:ciphertext" (all hex), or null/undefined as-is.
 */
export function encrypt(value) {
  if (value == null) return value;
  const text = String(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a value encrypted by encrypt().
 * Returns the original string, or the value as-is if it wasn't encrypted.
 */
export function decrypt(value) {
  if (value == null) return value;
  const parts = String(value).split(":");
  if (parts.length !== 3) return value; // not encrypted
  try {
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return value; // return as-is if decryption fails
  }
}
