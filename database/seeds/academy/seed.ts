// Loads the official question bank (database/seeds/academy/questions.json, verified against CFT_New_Agent_Test.pdf and
// CFT_Detailed_Answer_Key.pdf) and the inferred topic mapping (database/seeds/academy/topics.json).
// Idempotent: existing questions are left alone so admin edits survive re-seeding.
// Usage: npm run db:seed
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closePool, tx } from '../../db.js';
import { OPTION_KEYS, type OptionKey } from '../../../support/common/types.js';

interface SeedQuestion {
  n: number;
  text: string;
  options: { key: OptionKey; text: string }[];
  correct: OptionKey;
  explanation: string;
  whyCorrect: string;
  why: Record<string, string>;
  basis: string;
}

/** Source: test instructions — "Passing score: 21/30 (70%)"; the answer key calls it the suggested pass mark. */
const OFFICIAL_PASS_MARK = 21;

const dataDir = import.meta.dirname;

export function loadSeed() {
  const questions: SeedQuestion[] = JSON.parse(readFileSync(join(dataDir, 'questions.json'), 'utf8'));
  const topics: { topics: { id: string; name: string }[]; assignments: Record<string, string> } = JSON.parse(
    readFileSync(join(dataDir, 'topics.json'), 'utf8'),
  );
  const problems: string[] = [];
  const nums = new Set<number>();
  for (const q of questions) {
    if (nums.has(q.n)) problems.push(`Q${q.n} is duplicated`);
    nums.add(q.n);
    if (!q.text?.trim()) problems.push(`Q${q.n} has no text`);
    if (q.options?.map((o) => o.key).join('') !== OPTION_KEYS.join('') || q.options.some((o) => !o.text?.trim())) problems.push(`Q${q.n} needs options A–D`);
    if (!OPTION_KEYS.includes(q.correct)) problems.push(`Q${q.n} has no valid correct answer`);
    if (!q.explanation?.trim()) problems.push(`Q${q.n} has no explanation`);
    if (!topics.topics.some((t) => t.id === topics.assignments[q.n])) problems.push(`Q${q.n} has no topic`);
  }
  if (problems.length) throw new Error('Seed data problems:\n  ' + problems.join('\n  '));
  return { questions, topics };
}

export async function seed(log = console.log) {
  const { questions, topics } = loadSeed();
  await tx(async (c) => {
    for (const [i, t] of topics.topics.entries()) {
      await c.query('insert into topics (id, name, sort_order) values ($1, $2, $3) on conflict (id) do update set name = excluded.name, sort_order = excluded.sort_order', [t.id, t.name, i]);
    }
    let added = 0;
    for (const q of questions) {
      const { rows } = await c.query(
        'insert into questions (number, topic_id, topic_inferred) values ($1, $2, true) on conflict (number) do nothing returning id',
        [q.n, topics.assignments[q.n]],
      );
      if (!rows[0]) continue;
      const rev = await c.query(
        `insert into question_revisions (question_id, revision, text, options, correct_option, explanation, why_correct, why_incorrect, basis, source)
         values ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'official') returning id`,
        [rows[0].id, q.text, JSON.stringify(q.options), q.correct, q.explanation, q.whyCorrect ?? '', JSON.stringify(q.why ?? {}), q.basis ?? ''],
      );
      await c.query('update questions set current_revision_id = $2 where id = $1', [rows[0].id, rev.rows[0].id]);
      added++;
    }
    await c.query('insert into app_settings (id, pass_mark, min_sample) values (1, $1, 10) on conflict (id) do nothing', [OFFICIAL_PASS_MARK]);
    log(`Seeded ${added} new question(s); ${questions.length - added} already present.`);
  });
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  seed()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}
