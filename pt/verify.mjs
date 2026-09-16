// =============================================================================
// scripts/pt/pt-verify.mjs - check a published Certisyn proficiency series.
// =============================================================================
// Built for someone who has no reason to take Certisyn's word for anything. It
// imports nothing from this repository, takes no arguments, installs nothing,
// and fetches every value it checks from the source that issued it.
//
// What it establishes:
//
//    1  the checkpoint declares the canonical form it was signed in
//    2  the signature verifies under the published key
//    3  that signature binds the score - editing any published number breaks it
//    4  every drand round is real and its randomness derives from its signature
//    5  every NIST pulse is real and lands where the commitment said it would
//    6  every selection seed is the digest of both beacon outputs and the case list
//    7  every control selection replays exactly
//    8  both beacon commitments postdate the replicate's registration
//    9  the case list hashes to the committed root
//   10  the whole log replays, leaf by leaf, to the published tree head
//   11  the pooled figures recompute from the per-replicate figures
//   12  the Wilson interval recomputes from the pooled counts
//   13  a committee Certisyn does not operate attested this exact document
//
// Node and three public HTTPS endpoints. Seconds, not minutes.
//
// Run:  node scripts/pt/pt-verify.mjs
// =============================================================================

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const BASE = 'https://raw.githubusercontent.com/certisyn/genlayer-attestation/main/pt';
const DRAND_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const DRAND_GENESIS = 1692803367;
const DRAND_PERIOD = 3;
const NIST_PERIOD_S = 60;
const RPC = 'https://rpc-asimov.genlayer.com';
const CONTRACT = '0xc17444190051819529815C4e0C15a0557068a7f2';

// The GenLayer calldata for the zero-argument view method get_latest.
//
// Hard-coded rather than encoded. Reaching the chain through the genlayer CLI
// means an npx install that pulls eslint and a native addon - minutes on a cold
// cache, and a verifier nobody waits for is a verifier nobody runs. This is one
// POST to a public RPC endpoint with no dependencies at all.
//
// Captured from genlayer CLI 0.39.2 on the wire and cross-checked against three
// other zero-argument methods on the same contract. The structure is the map
// {"method": "get_latest"} in GenVM calldata encoding. A changed encoding makes
// the node answer with an error rather than a wrong record, so this fails loudly.
const CALLDATA_GET_LATEST = '0xd5930e066d6574686f64546765745f6c617465737400';

// Worth naming: GenLayer CLI 0.40.0-rc.3 cannot resolve methods on a contract
// built against genvm v0.2.16. It answers a view call with a bare genvm
// execution error and no message, which reads as a failed claim when it is a
// failed toolchain. Talking to the RPC directly sidesteps that entirely.
const CLI_PIN = 'genlayer@0.39.2';

// ------------------------------------------------------------- canonical form
// Identical to scripts/pt/canon.ts. Copied rather than imported, deliberately:
// a verifier that shares code with the thing it verifies checks less than it
// appears to.

const canonValue = (v) => {
  if (Array.isArray(v)) return v.map(canonValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      const cv = canonValue(v[k]);
      if (cv !== undefined) out[k] = cv;
    }
    return out;
  }
  return v;
};
const canon = (v) => JSON.stringify(canonValue(v));

// ------------------------------------------------------------------- the log

const sha256 = (b) => createHash('sha256').update(b).digest();

function mth(leaves) {
  if (leaves.length === 0) return sha256(Buffer.alloc(0));
  if (leaves.length === 1) return sha256(Buffer.concat([Buffer.from([0]), leaves[0]]));
  const k = 1 << (32 - Math.clz32(leaves.length - 1) - 1);
  return sha256(Buffer.concat([Buffer.from([1]), mth(leaves.slice(0, k)), mth(leaves.slice(k))]));
}

function wilson95(successes, trials) {
  if (trials === 0) return [0, 1];
  const z = 1.959963984540054;
  const p = successes / trials;
  const d = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const half = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return [Math.max(0, (centre - half) / d), Math.min(1, (centre + half) / d)];
}

// ------------------------------------------------------------------ reporting

let failed = 0;
let checked = 0;
const check = (ok, label, detail = '') => {
  checked++;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};
const note = (label, detail) => console.log(`  ----  ${label}   ${detail}`);
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
  return r.json();
}

async function main() {
  console.log('Checking a published Certisyn proficiency series.');
  console.log('Every value below is fetched from the source that issued it.\n');

  const signed = await getJson(`${BASE}/checkpoint.json`);
  const corpus = await getJson(`${BASE}/corpus.json`);
  const cp = signed.checkpoint;
  const p = cp.pooled;
  const reps = corpus.replicate_records;

  console.log(`origin       ${cp.origin}   scheme v${cp.scheme_version}`);
  console.log(`timestamp    ${cp.timestamp}`);
  console.log(`published    ${p.replicates} replicates, ${p.case_judgements} case judgements`);
  console.log(`             detected ${p.detected} of ${p.seeded} seeded, missed ${p.missed}`);
  console.log(`             false flags ${p.false_flags} of ${p.clean} clean`);
  console.log(`             sensitivity ${p.sensitivity?.toFixed(4)} `
    + `95% CI [${p.sensitivity_ci95[0].toFixed(4)}, ${p.sensitivity_ci95[1].toFixed(4)}]`);
  console.log(`             specificity ${p.specificity?.toFixed(4)} `
    + `95% CI [${p.specificity_ci95[0].toFixed(4)}, ${p.specificity_ci95[1].toFixed(4)}]\n`);

  // ---- 1 to 3. the signature, and what it covers ---------------------------
  const pub = createPublicKey({
    key: Buffer.from(signed.public_key_spki_b64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const verifies = (doc) =>
    edVerify(null, Buffer.from(canon(doc), 'utf8'), pub, Buffer.from(signed.signature, 'base64'));

  check(cp.canon_alg === 'sorted-keys-utf8-no-ws',
    'the checkpoint declares the canonical form it was signed in', `canon_alg=${cp.canon_alg}`);
  check(verifies(cp), 'the signature verifies under the published key');

  // A signature is worth exactly what it covers. JSON.stringify(obj, keyArray)
  // filters keys at every depth, so a checkpoint signed that way binds its
  // top-level scalars and serialises its score as {}. Under that form the
  // published sensitivity can be edited and the signature still verifies. These
  // three checks make that class of defect impossible to ship again.
  check(!verifies({ ...cp, pooled: { ...p, missed: 0, sensitivity: 1 } }),
    'editing the pooled score breaks the signature');
  check(!verifies({ ...cp, root_sha256: '0'.repeat(64) }),
    'editing the tree head breaks the signature');
  check(!verifies({ ...cp, per_replicate: cp.per_replicate.map((r) => ({ ...r, fn: 0 })) }),
    'editing a single replicate breaks the signature');

  // ---- 4 to 8. the beacons and the selection -------------------------------
  const listRoot = mth([...corpus.cases.map((c) => c.case_id)].sort()
    .map((c) => sha256(Buffer.from(c))));
  check(listRoot.toString('hex') === cp.case_list_root,
    'the case list hashes to the committed root', `${corpus.cases.length} cases`);

  const ids = corpus.cases.map((c) => c.case_id).sort();
  const fraction = corpus.decision_rule.control_fraction;
  const k = Math.max(1, Math.round(ids.length * fraction));

  let drandOk = 0; let nistOk = 0; let seedOk = 0; let selOk = 0; let futureOk = 0;
  const complaints = [];
  for (const r of reps) {
    const tag = `replicate ${r.i}`;

    const d = await getJson(`https://api.drand.sh/v2/chains/${DRAND_CHAIN}/rounds/${r.beacons.drand.committed_round}`);
    const randomness = sha256(Buffer.from(d.signature, 'hex')).toString('hex');
    if (d.round === r.beacons.drand.committed_round
      && d.signature === r.beacons.drand.signature
      && randomness === r.beacons.drand.randomness) drandOk++;
    else complaints.push(`${tag}: drand mismatch`);

    const nUrl = `https://beacon.nist.gov/beacon/2.0/chain/${r.beacons.nist.chain_index}/pulse/${r.beacons.nist.committed_pulse}`;
    const nj = await getJson(nUrl);
    const nOut = String(nj.pulse.outputValue).toLowerCase();
    const nTs = String(nj.pulse.timeStamp);
    const nMs = Date.parse(nTs.endsWith('Z') ? nTs : nTs + 'Z');
    if (Number(nj.pulse.pulseIndex) === r.beacons.nist.committed_pulse
      && nOut === r.beacons.nist.output_value
      && Math.abs(nMs - Date.parse(r.beacons.nist.expected_time)) <= NIST_PERIOD_S * 1000) nistOk++;
    else complaints.push(`${tag}: nist mismatch`);

    const seed = sha256(Buffer.concat([
      Buffer.from(r.beacons.drand.randomness, 'hex'),
      Buffer.from(r.beacons.nist.output_value, 'hex'),
      listRoot,
    ]));
    if (seed.toString('hex') === r.seed) seedOk++;
    else complaints.push(`${tag}: seed mismatch`);

    const scored = ids.map((id) => ({ id, v: sha256(Buffer.concat([seed, Buffer.from(id)])).readBigUInt64BE(0) }));
    scored.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
    const replayed = scored.slice(0, k).map((x) => x.id).sort();
    if (JSON.stringify(replayed) === JSON.stringify([...r.controls].sort())) selOk++;
    else complaints.push(`${tag}: selection does not replay`);

    // The load-bearing one. Everything else proves the arithmetic; this proves
    // the arithmetic was committed to before its inputs existed - and it takes
    // BOTH beacon operators at once to move it.
    const regAt = Date.parse(r.registered_at);
    const drandTimeMs = (DRAND_GENESIS + (r.beacons.drand.committed_round - 1) * DRAND_PERIOD) * 1000;
    if (drandTimeMs > regAt && nMs > regAt) futureOk++;
    else complaints.push(`${tag}: a committed beacon value already existed at registration`);
  }
  const N = reps.length;
  check(N === cp.pooled.replicates && N === cp.per_replicate.length,
    'the corpus carries every replicate the checkpoint claims', `${N} replicates`);
  check(drandOk === N, 'every drand round is real and its randomness derives from its signature', `${drandOk}/${N}`);
  check(nistOk === N, 'every NIST pulse is real and lands where the commitment said', `${nistOk}/${N}`);
  check(seedOk === N, 'every selection seed is the digest of both beacons and the case list', `${seedOk}/${N}`);
  check(selOk === N, 'every control selection replays exactly', `${selOk}/${N}, ${k} of ${ids.length} each`);
  check(futureOk === N, 'both beacon commitments postdate the replicate registration', `${futureOk}/${N}`);
  for (const c of complaints.slice(0, 8)) note('detail', c);

  // ---- 9 and 10. the whole log replays -------------------------------------
  // Not just the tree head: every leaf is rebuilt from published data. A case
  // added, dropped, reordered or reclassified after the fact does not land here.
  const header = {
    origin: corpus.origin,
    scheme_version: corpus.scheme_version,
    reference: corpus.reference,
    decision_rule: corpus.decision_rule,
    case_list_root: corpus.case_list_root,
    replicates: corpus.replicates,
  };
  const leaves = [Buffer.from(canon(header))];
  for (const c of corpus.cases) leaves.push(Buffer.from(canon(c)));
  for (const r of reps) leaves.push(Buffer.from(canon(r)));
  leaves.push(Buffer.from(canon({ pooled: p, violations: cp.violations })));
  check(leaves.length === cp.tree_size, 'the published tree size matches the published corpus',
    `${leaves.length} leaves`);
  check(mth(leaves).toString('hex') === cp.root_sha256,
    'the whole log replays to the published tree head');

  // ---- 11 and 12. the pooled arithmetic ------------------------------------
  const sum = (f) => cp.per_replicate.reduce((a, r) => a + r[f], 0);
  const tp = sum('tp'); const fn = sum('fn'); const tn = sum('tn'); const fp = sum('fp');
  check(tp === p.detected && fn === p.missed && tn + fp === p.clean && tp + fn === p.seeded
    && tp + fn + tn + fp === p.case_judgements,
    'the pooled counts are the sum of the per-replicate counts',
    `tp=${tp} fn=${fn} tn=${tn} fp=${fp}`);
  check(close(p.sensitivity, tp / (tp + fn)) && close(p.specificity, tn / (tn + fp)),
    'the pooled rates recompute from those counts');
  const sCi = wilson95(tp, tp + fn);
  const pCi = wilson95(tn, tn + fp);
  check(close(sCi[0], p.sensitivity_ci95[0], 1e-9) && close(sCi[1], p.sensitivity_ci95[1], 1e-9)
    && close(pCi[0], p.specificity_ci95[0], 1e-9) && close(pCi[1], p.specificity_ci95[1], 1e-9),
    'the Wilson 95 percent intervals recompute from those counts');
  check(p.sensitivity_ci95[0] < 1 || p.missed > 0,
    'the interval keeps a lower bound below 1, as a bounded sample requires',
    `lower ${p.sensitivity_ci95[0].toFixed(4)}`);

  // ---- 13. the witness ------------------------------------------------------
  const digest = sha256(Buffer.from(canon(signed), 'utf8')).toString('hex');
  console.log('');
  note('canonical digest of this document', digest);

  let rec = null;
  let why = '';
  try {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'gen_call',
        params: [{
          type: 'read',
          to: CONTRACT,
          from: '0x0000000000000000000000000000000000000000',
          data: CALLDATA_GET_LATEST,
          transaction_hash_variant: 'latest-nonfinal',
        }],
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message ?? JSON.stringify(j.error));
    const hex = typeof j.result === 'string' ? j.result : j.result?.data;
    if (!hex) throw new Error('no data in gen_call result');
    // The return value is a GenVM-encoded string whose payload is the JSON the
    // view method returns. Take the payload and refuse anything that is not a
    // single well-formed object.
    const text = Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('utf8');
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no JSON object in the returned value');
    rec = JSON.parse(text.slice(a, b + 1));
  } catch (e) {
    why = e?.message ?? String(e);
  }

  if (!rec) {
    note('on-chain witness', `could not read ${CONTRACT}: ${why}`);
    note('', `by hand: npx --yes ${CLI_PIN} call ${CONTRACT} get_latest --rpc ${RPC}`);
    note('', 'expected_digest in that record must equal the digest above');
    failed++; checked++;
    console.log('  FAIL  the on-chain witness could not be read');
  } else {
    check(rec.outcome === 'attested', 'the committee recorded an attestation', `outcome=${rec.outcome}`);
    check(rec.expected_digest === digest && rec.canonical_digest === digest,
      'the committee attested THIS document', `${String(rec.canonical_digest).slice(0, 16)}...`);
    check(rec.endpoint === `${BASE}/checkpoint.json`,
      'the committee read the URL this verifier read', rec.endpoint);
  }

  console.log('');
  if (failed === 0) {
    console.log(`ALL ${checked} CHECKS PASSED`);
  } else {
    console.log(`${failed} OF ${checked} CHECKS FAILED - do not rely on the published score`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('REFUSED -', e.message); process.exit(2); });
