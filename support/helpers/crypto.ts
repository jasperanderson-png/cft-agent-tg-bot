import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

/** 256-bit random bearer token, URL-safe. Only its SHA-256 is stored. */
export const newToken = (): string => randomBytes(32).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const N = 16384, R = 8, P = 1, LEN = 64;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(pw, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A real hash of a random password, used so unknown emails take as long as known ones. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));
