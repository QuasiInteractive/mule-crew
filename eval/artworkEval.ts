// Artwork scoreboard. Every model checks the same labelled uploads
// (artwork/labels.json, made by eval/make_artwork.py). Two things are scored:
//  - the verdict and issues, which come from measurements in code, against the
//    labels (approving a bad file is the expensive mistake: it goes to print);
//  - the model's job: a customer note that explains every issue, and how often
//    it raises "extra concerns" on files that are actually fine (noise for humans).
// Usage: npm run artwork-eval -- ollama/qwen3.5:9b [more models]
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from '../src/db.js';
import { checkArtwork, ISSUES, type ArtworkOutput } from '../src/agents/artwork.js';

type Case = { file: string; product: string; width_in: number; height_in: number; issues: string[] };

async function main() {
  const models = process.argv.slice(2);
  if (!models.length) throw new Error('Pass one or more model ids');
  const dir = join(process.cwd(), 'artwork');
  const limit = Number(process.env.EVAL_LIMIT ?? 0);
  const all: Case[] = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  const cases = limit ? all.slice(0, limit) : all;
  const p = async (k: string) => Number((await pool.query('SELECT value FROM policy WHERE key=$1', [k])).rows[0].value);
  const limits = {
    min_dpi: await p('min_artwork_dpi'), min_sharpness: await p('min_artwork_sharpness'),
    min_contrast: await p('min_artwork_contrast'), max_safe_zone_ink_pct: await p('max_safe_zone_ink_pct'),
  };
  const board = [];

  for (const model of models) {
    let verdictRight = 0, exact = 0, unsafe = 0, falseReject = 0;
    let notesOk = 0, notesMissing = 0, notesContradict = 0, invalid = 0, errors = 0, repaired = 0, noise = 0, ms = 0;
    const found: Record<string, [number, number]> = Object.fromEntries(ISSUES.map((i) => [i, [0, 0]])); // [caught, present]
    for (const c of cases) {
      const r = await checkArtwork(model, { path: join(dir, 'cases', c.file), widthIn: c.width_in, heightIn: c.height_in, product: c.product }, limits);
      await pool.query(
        'INSERT INTO agent_runs (agent, model, ticket_id, output, ok, latency_ms, cost_usd) VALUES ($1,$2,NULL,$3,$4,$5,$6)',
        ['artwork:eval', model, JSON.stringify({ file: c.file, verdict: r.verdict, issues: r.issues, ...r.output as object }), r.ok, r.latencyMs, r.costUsd]);

      // The verdict is measured, so it is scored even when the model fails.
      const bad = c.issues.length > 0;
      const got = new Set<string>(r.issues);
      for (const i of c.issues) { found[i][1]++; if (got.has(i)) found[i][0]++; }
      if ((r.verdict === 'needs_changes') === bad) verdictRight++;
      if (bad && r.verdict === 'approve') unsafe++;
      if (!bad && r.verdict === 'needs_changes') falseReject++;
      const isExact = got.size === c.issues.length && c.issues.every((i) => got.has(i));
      if (isExact) exact++; else console.error(`\n  ${c.file} want [${c.issues}] measured [${r.issues}]`);

      if (r.providerError) { errors++; process.stdout.write('!'); continue; }
      ms += r.latencyMs;
      if (r.repaired) repaired++;
      if (r.ok) {
        notesOk++;
        if (!bad && (r.output as ArtworkOutput).extra_concerns.length) noise++;
        process.stdout.write('.');
      } else {
        if (r.noteMissing) notesMissing++; else if (r.noteContradicts) notesContradict++; else invalid++;
        process.stdout.write('x');
        console.error(`\n  ${c.file} [${r.issues}] -> ${(r.output as { error: string }).error}`);
      }
    }
    process.stdout.write('\n');
    const n = cases.length, ran = n - errors;
    const pct = (k: number, of: number) => (of ? (k / of * 100).toFixed(1) : '0');
    const clean = cases.filter((c) => !c.issues.length).length;
    board.push({
      model,
      'verdict % (code)': pct(verdictRight, n), 'exact issues % (code)': pct(exact, n),
      'bad files approved': unsafe, 'good files rejected': falseReject,
      'notes complete % (model)': pct(notesOk, ran), 'notes missing an issue': notesMissing, "'ready to print' on a reject": notesContradict, invalid,
      'concerns on clean files': `${noise}/${clean}`, 'self-corrected': repaired, 'provider errors': errors,
      'avg ms': ran ? Math.round(ms / ran) : 0,
    });
    console.table(board.at(-1));
    console.log('Issues caught by measurement (caught/present):');
    console.table(Object.fromEntries(Object.entries(found).map(([k, [a, b]]) => [k, `${a}/${b}`])));
  }
  if (models.length > 1) console.table(board);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
