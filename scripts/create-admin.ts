// Creates an admin or resets their password, and optionally links a Telegram account for one-tap sign-in.
// Usage: npm run admin:create -- --email you@company.com [--telegram-id 123456789]
// The password is read from ADMIN_PASSWORD or prompted for (input hidden), never passed as an argument.
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { hashPassword } from '../core/crypto.js';
import { closePool, getPool } from '../db_storage/db.js';

function promptHidden(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => out.output.write(s.includes(q) ? s : '');
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, 'telegram-id': { type: 'string' } } });
  const email = values.email?.trim().toLowerCase() ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Pass --email you@company.com');
  const tgRaw = values['telegram-id'];
  const tgId = tgRaw ? Number(tgRaw) : null;
  if (tgRaw && (!Number.isSafeInteger(tgId) || tgId! <= 0)) throw new Error('--telegram-id must be a numeric Telegram user ID');

  const pw = process.env.ADMIN_PASSWORD ?? (await promptHidden('New admin password (min 12 characters): '));
  if (pw.length < 12) throw new Error('Use a password of at least 12 characters.');
  const hash = await hashPassword(pw);
  const { rows } = await getPool().query(
    `insert into admins (email, password_hash, telegram_user_id) values ($1, $2, $3)
     on conflict (email) do update set password_hash = excluded.password_hash,
       telegram_user_id = coalesce(excluded.telegram_user_id, admins.telegram_user_id)
     returning (xmax = 0) as created`,
    [email, hash, tgId],
  );
  // Changing the password signs out every existing session.
  await getPool().query('update admin_sessions s set revoked_at = now() from admins a where a.id = s.admin_id and a.email = $1 and s.revoked_at is null', [email]);
  console.log(`${rows[0].created ? 'Created' : 'Updated'} admin ${email}${tgId ? ` (Telegram ${tgId} linked)` : ''}.`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(closePool);
