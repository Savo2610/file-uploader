// Räumt die Hinterlassenschaften von tools/test-api.mjs weg.
//
//   node tools/cleanup-tests.mjs            # lokaler Zustand
//   node tools/cleanup-tests.mjs --remote   # echter Bucket
//
// Löscht ausschließlich Dateien, deren Name mit TESTLAUF- beginnt. Alles
// andere wird aufgelistet und angefasst wird es nicht – ein pauschales
// „Bucket leeren“ hat hier schon einmal einen echten Upload erwischt.

import { execFileSync } from 'node:child_process';

const PREFIX = 'TESTLAUF-';
const remote = process.argv.includes('--remote');
const scope  = remote ? '--remote' : '--local';
const cwd    = new URL('..', import.meta.url).pathname;

const wrangler = args => execFileSync('npx', ['wrangler', ...args], { cwd, encoding: 'utf8' });

function query(sql) {
  const raw = wrangler(['d1', 'execute', 'upload-meta', scope, '--command', sql, '--json']);
  // wrangler stellt der JSON-Ausgabe je nach Version einen Banner voran.
  const json = raw.slice(raw.indexOf('['));
  return JSON.parse(json)[0].results;
}

const alle = query('SELECT r2_key, file_name, size FROM uploads ORDER BY created_at');
const test = alle.filter(r => r.file_name.startsWith(PREFIX));
const echt = alle.filter(r => !r.file_name.startsWith(PREFIX));

console.log(`\n${scope}: ${alle.length} Datei(en) insgesamt\n`);

if (echt.length) {
  console.log('Bleibt unangetastet:');
  for (const r of echt) console.log(`  · ${r.file_name}  (${r.size} Bytes)`);
  console.log();
}

if (!test.length) {
  console.log('Keine Testdateien gefunden.\n');
  process.exit(0);
}

console.log('Wird gelöscht:');
for (const r of test) console.log(`  × ${r.file_name}`);

for (const r of test) {
  try {
    wrangler(['r2', 'object', 'delete', `upload-veerka-mp/${r.r2_key}`, ...(remote ? [] : ['--local'])]);
  } catch {
    // Schon weg – dann bleibt nur noch die Zeile in der Datenbank.
  }
}

const keys = test.map(r => `'${r.r2_key.replace(/'/g, "''")}'`).join(',');
query(`DELETE FROM uploads WHERE r2_key IN (${keys})`);

console.log(`\n${test.length} Testdatei(en) entfernt, ${echt.length} echte behalten.\n`);
