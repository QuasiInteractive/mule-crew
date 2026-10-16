// Freezes the dashboard into docs/ as a static page plus its data, for GitHub
// Pages. The agents run on a local GPU, so the hosted copy is a snapshot:
// same page, today's numbers, retire button disabled. Usage: npm run snapshot
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './db.js';
import { dashboardData } from './dashboard.js';

const root = join(import.meta.dirname, '..');
const out = join(root, 'docs');
mkdirSync(out, { recursive: true });

const data = await dashboardData();
writeFileSync(join(out, 'dashboard.json'), JSON.stringify(data, null, 1));
const page = readFileSync(join(root, 'src', 'dashboard.html'), 'utf8')
  .replace('<script>', '<script>window.MULE_STATIC = true;</script>\n<script>');
writeFileSync(join(out, 'index.html'), page);
// Pages would otherwise run the folder through Jekyll.
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Snapshot of ${data.totalRuns} runs written to docs/`);
await pool.end();
