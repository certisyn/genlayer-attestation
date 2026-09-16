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
  ['pooled score edited after signing', (c) => { c.checkpoint.pooled.missed = 0; c.checkpoint.pooled.sensitivity = 1; }],
  ['a single replicate edited', (c) => { c.checkpoint.per_replicate[0].fn = 0; c.checkpoint.per_replicate[0].tp += 1; }],
  ['tree head edited', (c) => { c.checkpoint.root_sha256 = 'a'.repeat(64); }],
  ['canon_alg removed', (c) => { delete c.checkpoint.canon_alg; }],
  ['signature replaced', (c) => { c.signature = Buffer.alloc(64, 7).toString('base64'); }],
  ['violation counts edited', (c) => { c.checkpoint.violations = { energy_discontinuity: 1 }; }],
  ['Wilson interval widened to hide the floor', (c) => { c.checkpoint.pooled.sensitivity_ci95 = [0.99, 1]; }],
];

const corpusCases = [
  ['a case removed from the corpus', (c) => { c.cases.pop(); }],
  ['a control reclassified', (c) => {
    const r = c.replicate_records[0];
    const swapIn = c.cases.map((x) => x.case_id).find((id) => !r.controls.includes(id));
    r.controls[0] = swapIn;
  }],
  ['a replicate back-dated to after its beacons', (c) => { c.replicate_records[0].registered_at = new Date(Date.now() + 86_400e3).toISOString(); }],
  ['the decision rule rewritten after the run', (c) => { c.decision_rule.fault_offset_m = 1; }],
  // Two shapes, deliberately. A round or pulse in the future does not exist, so
  // the beacon answers 425 or 404; an earlier one does exist but carries a
  // different value. The first tests that an unreadable beacon is reported as a
  // failed check rather than aborting the run, the second that a real but wrong
  // value is caught on its content.
  ['a drand round swapped for one that has not published', (c) => { c.replicate_records[0].beacons.drand.committed_round += 1000; }],
  ['a drand round swapped for an earlier real one', (c) => { c.replicate_records[0].beacons.drand.committed_round -= 1000; }],
  ['a NIST pulse swapped for one that has not published', (c) => { c.replicate_records[0].beacons.nist.committed_pulse += 1000; }],
  ['a NIST pulse swapped for an earlier real one', (c) => { c.replicate_records[0].beacons.nist.committed_pulse -= 100; }],
  ['a NIST pulse output edited', (c) => { c.replicate_records[0].beacons.nist.output_value = 'f'.repeat(128); }],
  ['a selection seed edited to justify the controls', (c) => { c.replicate_records[0].seed = '0'.repeat(64); }],
  ['a replicate dropped from the corpus', (c) => { c.replicate_records.pop(); }],
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

// A refusal counts whether it arrives as a named failed check or as the
// verifier declining to finish at all (exit 2). Counting only named failures
// scored an outright abort as a pass, which is the failure mode this harness
// exists to find - so it is tested for here too.
const refused = ({ code, out }) => code === 2 || failures(out).some((x) => x !== ENDPOINT_CHECK);
const reason = ({ code, out }) => {
  const f = failures(out).filter((x) => x !== ENDPOINT_CHECK);
  if (f.length) return f[0];
  return code === 2 ? 'the verifier refused to finish' : '';
};

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
  const r = await run();
  const ok = refused(r);
  console.log(`  ${ok ? 'REFUSED' : 'LET THROUGH - BAD'} ${label}${ok ? '   (' + reason(r) + ')' : ''}`);
  if (!ok) bad++;
}
for (const [label, mutate] of corpusCases) {
  load(mutate, 'corpus');
  const r = await run();
  const ok = refused(r);
  console.log(`  ${ok ? 'REFUSED' : 'LET THROUGH - BAD'} ${label}${ok ? '   (' + reason(r) + ')' : ''}`);
  if (!ok) bad++;
}

server.close();
console.log(`\n${bad === 0 ? 'THE VERIFIER REFUSED EVERY CORRUPTION TESTED' : bad + ' CORRUPTION(S) SLIPPED THROUGH'}`);
process.exit(bad === 0 ? 0 : 1);
