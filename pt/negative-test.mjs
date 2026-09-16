// =============================================================================
// pt/negative-test.mjs - does the verifier actually refuse?
// =============================================================================
// A verifier that has only ever been run against an honest document has not
// been tested. This serves deliberately corrupted checkpoints over localhost,
// points a copy of the real verifier at them, and requires a non-zero exit for
// every one. Green here means the verifier catches what it claims to catch.
//
// Run:  node pt/negative-test.mjs
// =============================================================================

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/certisyn/genlayer-attestation/main/pt';
const real = {};
for (const f of ['checkpoint.json', 'corpus.json']) {
  real[f] = await (await fetch(`${BASE}/${f}`)).json();
}

const clone = (o) => JSON.parse(JSON.stringify(o));

const checkpointCases = [
  ['score edited after signing', (c) => { c.checkpoint.score.fn = 0; c.checkpoint.score.sensitivity = 1; c.checkpoint.score.tp = 99; }],
  ['tree head edited', (c) => { c.checkpoint.root_sha256 = 'a'.repeat(64); }],
  ['beacon signature swapped', (c) => { c.checkpoint.beacon_signature = 'b'.repeat(96); }],
  ['canon_alg removed', (c) => { delete c.checkpoint.canon_alg; }],
  ['signature replaced', (c) => { c.signature = Buffer.alloc(64, 7).toString('base64'); }],
  ['violation counts edited', (c) => { c.checkpoint.violations = { energy_discontinuity: 1 }; }],
];

const corpusCases = [
  ['a case removed from the corpus', (c) => { c.cases.pop(); }],
  ['a control reclassified', (c) => { c.selection.controls[0] = c.cases[0].case_id; }],
  ['registration back-dated to after the beacon', (c) => { c.registration.registered_at = new Date(Date.now() + 86_400e3).toISOString(); }],
  ['the decision rule rewritten after the run', (c) => { c.registration.decision_rule.fault_offset_m = 1; }],
];

const dir = mkdtempSync(join(tmpdir(), 'ptneg-'));
const src = readFileSync(new URL('./verify.mjs', import.meta.url), 'utf8');

const state = { checkpoint: null, corpus: null };
const server = createServer((req, res) => {
  const f = req.url.includes('corpus') ? 'corpus' : 'checkpoint';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(state[f]));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const verifier = join(dir, 'v.mjs');
writeFileSync(verifier, src.replace(
  /const BASE = '[^']+';/,
  `const BASE = 'http://127.0.0.1:${port}/pt';`,
));

// spawn, not execFileSync: the corrupted documents are served by an HTTP server
// in THIS process, and a synchronous child blocks the event loop that would
// answer it. The verifier then hangs on its first fetch, which is a deadlock
// that looks exactly like a slow test.
const run = () => new Promise((resolve) => {
  const p = spawn(process.execPath, [verifier], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { p.kill(); resolve({ code: -2, out }); }, 120_000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out }); });
});

// The honest baseline cannot pass cleanly here, and that is the verifier being
// right rather than the harness being wrong. Check 8 requires the committee to
// have read the same URL this verifier read; served from localhost, the chain
// says raw.githubusercontent.com and the two do not match. So the baseline
// requirement is exact: that one check fails and nothing else does.
const ENDPOINT_CHECK = 'the committee read the URL this verifier read';
const failures = (out) => out.split('\n').filter((l) => l.trim().startsWith('FAIL'))
  .map((l) => l.replace(/^\s*FAIL\s+/, '').split('   ')[0].trim());

const load = (mutate, which) => {
  state.checkpoint = clone(real['checkpoint.json']);
  state.corpus = clone(real['corpus.json']);
  if (mutate) mutate(which === 'checkpoint' ? state.checkpoint : state.corpus);
};

let bad = 0;
console.log('Negative testing the verifier. Every corruption must be REFUSED.\n');

load(null);
const honest = await run();
const hf = failures(honest.out);
const baselineOk = hf.length === 1 && hf[0] === ENDPOINT_CHECK;
console.log(`  ${baselineOk ? 'ok     ' : 'BROKEN '} the honest document fails only the localhost endpoint check`);
if (!baselineOk) { bad++; console.log(honest.out); }

for (const [label, mutate] of checkpointCases) {
  load(mutate, 'checkpoint');
  const { out } = await run();
  const f = failures(out).filter((x) => x !== ENDPOINT_CHECK);
  console.log(`  ${f.length ? 'REFUSED' : 'LET THROUGH - BAD'} ${label}${f.length ? '   (' + f[0] + ')' : ''}`);
  if (!f.length) bad++;
}
for (const [label, mutate] of corpusCases) {
  load(mutate, 'corpus');
  const { out } = await run();
  const f = failures(out).filter((x) => x !== ENDPOINT_CHECK);
  console.log(`  ${f.length ? 'REFUSED' : 'LET THROUGH - BAD'} ${label}${f.length ? '   (' + f[0] + ')' : ''}`);
  if (!f.length) bad++;
}

server.close();
console.log(`\n${bad === 0 ? 'THE VERIFIER REFUSED EVERY CORRUPTION TESTED' : bad + ' CORRUPTION(S) SLIPPED THROUGH'}`);
process.exit(bad === 0 ? 0 : 1);
