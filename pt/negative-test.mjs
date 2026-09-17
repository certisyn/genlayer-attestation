// =============================================================================
// pt/negative-test.mjs - does the verifier actually refuse?
// =============================================================================
// A verifier that has only ever been run against an honest document has not
// been tested. This serves deliberately corrupted catalogues over localhost,
// points a copy of the real verifier at them, and requires a refusal for every
// one. Green here means the verifier catches what it claims to catch.
//
// The corruptions are chosen to attack the three properties the scheme rests
// on rather than to exercise the code: exhaustiveness, which is what stands in
// for an external seeder; the floor test, which is what stops a ladder being
// chosen to flatter; and beacon selection, which is what stops the operator
// choosing the headline.
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
  ['the floor test flipped to hide a flattering ladder', (c) => { c.checkpoint.floor_test = !c.checkpoint.floor_test; }],
  ['a detection floor lowered to look sharper', (c) => { c.checkpoint.detection.position_step.detection_floor = 1; }],
  ['the trial score edited after signing', (c) => { c.checkpoint.trial.fn = 0; c.checkpoint.trial.sensitivity = 1; }],
  ['the specificity interval narrowed to look certain', (c) => { c.checkpoint.specificity.ci95 = [1, 1]; }],
  ['the clean-variant count inflated to dilute a false flag', (c) => { c.checkpoint.specificity.clean = 600; }],
  ['the catalogue size overstated', (c) => { c.checkpoint.catalogue_size += 100; }],
  ['tree head edited', (c) => { c.checkpoint.root_sha256 = 'a'.repeat(64); }],
  ['canon_alg removed', (c) => { delete c.checkpoint.canon_alg; }],
  ['signature replaced', (c) => { c.signature = Buffer.alloc(64, 7).toString('base64'); }],
];

const corpusCases = [
  // Exhaustiveness - the property that replaces the external seeder.
  ['the rungs the register misses deleted from the catalogue', (c) => {
    c.catalogue = c.catalogue.filter((e) => e.family === 'clean' || e.rung >= 6);
  }],
  ['a flattering extra entry added', (c) => {
    c.catalogue.push({ ...c.catalogue[0], rung: 99, magnitude: 1, flagged: true, kinds: ['energy_discontinuity'] });
  }],
  ['an entry duplicated to double-count a detection', (c) => {
    const hit = c.catalogue.find((e) => e.flagged);
    c.catalogue.push(clone(hit));
  }],
  ['a case dropped from the case list', (c) => { c.cases.pop(); }],
  ['a magnitude rewritten so a hard rung reads as an easy one', (c) => {
    const e = c.catalogue.find((x) => x.family === 'position_step' && x.rung === 0);
    e.magnitude = 300000;
  }],
  // The floor test - the anti-flattery property.
  ['the missed rungs marked as detected, erasing the floor', (c) => {
    for (const e of c.catalogue) if (!e.flagged && e.family !== 'clean') { e.flagged = true; e.kinds = ['energy_discontinuity']; }
  }],
  ['the published curve edited to hide the floor', (c) => {
    const f = c.curve.position_step;
    f.rate = f.rate.map(() => 1);
    f.detected = f.total.slice();
    f.detection_floor = f.rungs[0];
  }],
  ['a clean variant that was falsely flagged quietly relabelled', (c) => {
    c.catalogue.find((e) => e.family === 'clean').family = 'position_step';
  }],
  ['a false flag on a clean variant hidden from the published specificity', (c) => {
    const e = c.catalogue.find((x) => x.family === 'clean');
    e.flagged = true;
    e.kinds = ['energy_discontinuity'];
  }],
  // Beacon selection - the property that stops the operator choosing the headline.
  ['the realised trial edited to drop the misses', (c) => {
    c.trial.selection = c.trial.selection.map((t) => (t.family === 'clean' ? t : { ...t, rung: 11 }));
  }],
  ['the selection seed edited to justify the trial', (c) => { c.trial.seed = '0'.repeat(64); }],
  ['the drand round swapped for one that has not published', (c) => { c.trial.beacons.drand.committed_round += 1000; }],
  ['the drand round swapped for an earlier real one', (c) => { c.trial.beacons.drand.committed_round -= 1000; }],
  ['the NIST pulse swapped for an earlier real one', (c) => { c.trial.beacons.nist.committed_pulse -= 100; }],
  ['the registration back-dated to after the beacons', (c) => {
    c.registered_at = new Date(Date.now() + 86_400e3).toISOString();
  }],
  ['the ladder rewritten after the run', (c) => { c.decision_rule.ladders.position_step.rungs[0] = 500; }],
  ['the clean fraction rewritten to justify the trial mix', (c) => { c.decision_rule.clean_fraction = 0.5; }],
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
writeFileSync(verifier, src.replace(/const BASE = '[^']+';/, `const BASE = 'http://127.0.0.1:${port}/pt';`));

// spawn, not execFileSync: the corrupted documents are served by an HTTP server
// in THIS process, and a synchronous child blocks the event loop that would
// answer it. The verifier then hangs on its first fetch, which is a deadlock
// that looks exactly like a slow test.
const run = () => new Promise((resolve) => {
  const p = spawn(process.execPath, [verifier], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { p.kill(); resolve({ code: -2, out }); }, 180_000);
  p.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? -1, out }); });
});

// The honest baseline cannot pass cleanly here, and that is the verifier being
// right rather than the harness being wrong. The witness check requires the
// committee to have read the same URL this verifier read; served from
// localhost, the chain says raw.githubusercontent.com and the two do not match.
// So the baseline requirement is exact: that one check fails and nothing else.
const ENDPOINT_CHECK = 'the committee read the URL this verifier read';
const failures = (out) => out.split('\n').filter((l) => l.trim().startsWith('FAIL'))
  .map((l) => l.replace(/^\s*FAIL\s+/, '').split('   ')[0].trim());

// A refusal counts whether it arrives as a named failed check or as the
// verifier declining to finish at all (exit 2). Counting only named failures
// once scored an outright abort as a pass, which is the failure mode this
// harness exists to find - so it is tested for here too.
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
