// =============================================================================
// scripts/pt/pt-verify.mjs - check a published Certisyn proficiency catalogue.
// =============================================================================
// Built for someone with no reason to take Certisyn's word for anything. It
// imports nothing from this repository, takes no arguments, installs nothing,
// and fetches every value it checks from the source that issued it.
//
// The claim it is checking is unusual, so it is worth stating plainly. A
// proficiency scheme run by the party being measured normally lets that party
// choose the denominator: which cases, which fault, how large. The usual remedy
// is an external seeder - a second organisation injecting cases through normal
// intake. This scheme replaces that with two properties a stranger can check:
//
//   EXHAUSTIVENESS. Every point in the registered difficulty space is present
//   in the catalogue, exactly once. That is what this verifier recomputes from
//   the registration alone, before it looks at a single verdict. A catalogue
//   containing every point has no free parameter left to tune.
//
//   BEACON SELECTION. The realised trial is drawn from two public beacons the
//   scheme does not operate, under a rule registered before either published.
//
// And one property the scheme would rather not have to publish:
//
//   THE FLOOR TEST. Every ladder must contain rungs the register FAILS. A
//   proficiency result that detected everything it tested has not found its
//   floor. This verifier fails the document if any ladder was chosen to flatter.
//
// What it establishes:
//
//    1  the checkpoint declares the canonical form it was signed in
//    2  the signature verifies under the published key
//    3  that signature binds every published figure
//    4  the catalogue is exactly the registered space - no point missing, none added
//    5  the case list hashes to the committed root
//    6  the detection curve recomputes from the catalogue
//    7  each detection floor recomputes from the curve
//    8  the floor test holds: every ladder reaches below the register's floor
//    9  the specificity figure recomputes from the clean variants
//   10  both beacons are real and land where the commitment said
//   11  both beacon commitments postdate the registration
//   12  the realised trial replays exactly from those beacons
//   13  the trial score recomputes from verdicts already in the catalogue
//   14  the whole log replays, leaf by leaf, to the published tree head
//   15  a committee Certisyn does not operate attested this exact document
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

// GenLayer CLI 0.40.0-rc.3 cannot resolve methods on a contract built against
// genvm v0.2.16. It answers a view call with a bare genvm execution error and
// no message, which reads as a failed claim when it is a failed toolchain.
// Talking to the RPC directly sidesteps that entirely.
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

function detectionFloor(rungs, detected, total) {
  for (let i = 0; i < rungs.length; i++) {
    let ok = true;
    for (let j = i; j < rungs.length; j++) {
      if (total[j] === 0 || detected[j] / total[j] < 0.95) { ok = false; break; }
    }
    if (ok) return rungs[i];
  }
  return null;
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
const tryJson = async (url) => { try { return await getJson(url); } catch (e) { return { __error: e.message }; } };

async function main() {
  console.log('Checking a published Certisyn proficiency catalogue.');
  console.log('Every value below is fetched from the source that issued it.\n');

  const signed = await getJson(`${BASE}/checkpoint.json`);
  const corpus = await getJson(`${BASE}/corpus.json`);
  const cp = signed.checkpoint;
  const rule = corpus.decision_rule;
  const ladders = rule.ladders;
  const families = Object.keys(ladders).sort();

  console.log(`origin       ${cp.origin}   scheme v${cp.scheme_version}`);
  console.log(`timestamp    ${cp.timestamp}`);
  console.log(`catalogue    ${cp.catalogue_size} evaluations over ${corpus.cases.length} cases\n`);
  console.log('detection floors, the level at and above which the register detects 95% of the time:');
  for (const f of families) {
    const dd = cp.detection[f];
    console.log(`  ${f.padEnd(15)} floor ${dd.detection_floor === null ? 'not reached in the ladder' : String(dd.detection_floor) + ' ' + dd.unit}`
      + `   highest level still missed ${dd.highest_missed === null ? 'none' : String(dd.highest_missed) + ' ' + dd.unit}`);
  }
  console.log('');

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
  check(!verifies({ ...cp, floor_test: !cp.floor_test })
    && !verifies({ ...cp, root_sha256: '0'.repeat(64) })
    && !verifies({ ...cp, trial: { ...cp.trial, fn: 0, sensitivity: 1 } }),
    'editing the floor test, the tree head or the trial score breaks the signature');

  // ---- 4. exhaustiveness: the point that replaces the external seeder ------
  // Recomputed from the registered ladders alone, before any verdict is read.
  // If the catalogue is exactly the registered space, there was nothing left to
  // choose - which is the property a second organisation would otherwise supply.
  const expected = new Set();
  for (const c of corpus.cases) {
    expected.add(`${c.case_id}|clean|-1`);
    for (const f of families) {
      ladders[f].rungs.forEach((_, i) => expected.add(`${c.case_id}|${f}|${i}`));
    }
  }
  const seen = new Set();
  let dupes = 0;
  let extras = 0;
  for (const e of corpus.catalogue) {
    const k = `${e.case_id}|${e.family}|${e.rung}`;
    if (seen.has(k)) dupes++;
    seen.add(k);
    if (!expected.has(k)) extras++;
  }
  const missing = [...expected].filter((k) => !seen.has(k)).length;
  check(missing === 0 && extras === 0 && dupes === 0 && corpus.catalogue.length === expected.size,
    'the catalogue is exactly the registered space, once each',
    `${corpus.catalogue.length} entries, ${missing} missing, ${extras} extra, ${dupes} duplicated`);
  check(cp.catalogue_size === corpus.catalogue.length,
    'the checkpoint states the catalogue size it published');

  // magnitudes must be the registered rung values, not values chosen per case
  let magOk = true;
  for (const e of corpus.catalogue) {
    const want = e.family === 'clean' ? 0 : ladders[e.family].rungs[e.rung];
    if (e.magnitude !== want) { magOk = false; break; }
  }
  check(magOk, 'every entry carries the registered magnitude for its rung');

  // ---- 5. the case list ----------------------------------------------------
  const listRoot = mth([...corpus.cases.map((c) => c.case_id)].sort().map((c) => sha256(Buffer.from(c))));
  check(listRoot.toString('hex') === cp.case_list_root,
    'the case list hashes to the committed root', `${corpus.cases.length} cases`);

  // ---- 6 to 8. the curve, the floors, and the floor test -------------------
  let curveOk = 0; let floorOk = 0; let belowOk = 0;
  const complaints = [];
  for (const f of families) {
    const rungs = ladders[f].rungs;
    const det = rungs.map(() => 0);
    const tot = rungs.map(() => 0);
    for (const e of corpus.catalogue) {
      if (e.family !== f) continue;
      tot[e.rung]++;
      if (e.flagged) det[e.rung]++;
    }
    const pubCurve = corpus.curve[f];
    const rateOk = rungs.every((_, i) => close(det[i] / tot[i], pubCurve.rate[i])
      && det[i] === pubCurve.detected[i] && tot[i] === pubCurve.total[i]);
    const ciOk = rungs.every((_, i) => {
      const w = wilson95(det[i], tot[i]);
      return close(w[0], pubCurve.ci95[i][0]) && close(w[1], pubCurve.ci95[i][1]);
    });
    if (rateOk && ciOk) curveOk++; else complaints.push(`${f}: curve does not recompute`);

    const fl = detectionFloor(rungs, det, tot);
    if (fl === pubCurve.detection_floor && fl === cp.detection[f].detection_floor) floorOk++;
    else complaints.push(`${f}: detection floor does not recompute`);

    const below = rungs.some((_, i) => det[i] / tot[i] < 0.05);
    if (below) belowOk++; else complaints.push(`${f}: the ladder never reaches below the register floor`);
  }
  const N = families.length;
  check(curveOk === N, 'the detection curve recomputes from the catalogue', `${curveOk}/${N} families`);
  check(floorOk === N, 'each detection floor recomputes from the curve', `${floorOk}/${N} families`);
  check(belowOk === N && cp.floor_test === true,
    'THE FLOOR TEST: every ladder contains rungs the register misses',
    `${belowOk}/${N} families`);
  for (const c of complaints) note('detail', c);

  // ---- 9. specificity ------------------------------------------------------
  const clean = corpus.catalogue.filter((e) => e.family === 'clean');
  const ff = clean.filter((e) => e.flagged).length;
  const sCi = wilson95(clean.length - ff, clean.length);
  check(clean.length === cp.specificity.clean && ff === cp.specificity.false_flags
    && close((clean.length - ff) / clean.length, cp.specificity.rate)
    && close(sCi[0], cp.specificity.ci95[0]) && close(sCi[1], cp.specificity.ci95[1]),
    'the specificity figure recomputes from the clean variants',
    `${ff} false flags in ${clean.length}`);

  // ---- 10 and 11. the beacons ---------------------------------------------
  const tb = corpus.trial.beacons;
  const d = await tryJson(`https://api.drand.sh/v2/chains/${DRAND_CHAIN}/rounds/${tb.drand.committed_round}`);
  const drandOk = !d.__error
    && d.round === tb.drand.committed_round
    && d.signature === tb.drand.signature
    && sha256(Buffer.from(d.signature, 'hex')).toString('hex') === tb.drand.randomness;
  check(drandOk, 'the drand round is real and its randomness derives from its signature',
    d.__error ? d.__error : `round ${tb.drand.committed_round}`);

  const nj = await tryJson(`https://beacon.nist.gov/beacon/2.0/chain/${tb.nist.chain_index}/pulse/${tb.nist.committed_pulse}`);
  let nMs = NaN;
  let nistOk = false;
  if (!nj.__error) {
    const nTs = String(nj.pulse.timeStamp);
    nMs = Date.parse(nTs.endsWith('Z') ? nTs : nTs + 'Z');
    nistOk = Number(nj.pulse.pulseIndex) === tb.nist.committed_pulse
      && String(nj.pulse.outputValue).toLowerCase() === tb.nist.output_value
      && Math.abs(nMs - Date.parse(tb.nist.expected_time)) <= NIST_PERIOD_S * 1000;
  }
  check(nistOk, 'the NIST pulse is real and lands where the commitment said',
    nj.__error ? nj.__error : `pulse ${tb.nist.committed_pulse}`);

  check(tb.drand.committed_round === corpus.beacons_committed.drand.committed_round
    && tb.nist.committed_pulse === corpus.beacons_committed.nist.committed_pulse
    && tb.drand.committed_round === cp.trial.drand_round
    && tb.nist.committed_pulse === cp.trial.nist_pulse,
    'the beacons used are the beacons registered');

  const regAt = Date.parse(corpus.registered_at);
  const drandMs = (DRAND_GENESIS + (tb.drand.committed_round - 1) * DRAND_PERIOD) * 1000;
  check(Number.isFinite(nMs) && drandMs > regAt && nMs > regAt,
    'both beacon commitments postdate the registration',
    `drand +${Math.round((drandMs - regAt) / 1000)} s, nist +${Math.round((nMs - regAt) / 1000)} s`);

  // ---- 12 and 13. the realised trial --------------------------------------
  const seed = sha256(Buffer.concat([
    Buffer.from(tb.drand.randomness, 'hex'),
    Buffer.from(tb.nist.output_value, 'hex'),
    listRoot,
  ]));
  check(seed.toString('hex') === corpus.trial.seed,
    'the selection seed is the digest of both beacons and the case list');

  const faulted = [];
  for (const f of families) ladders[f].rungs.forEach((m, i) => faulted.push({ family: f, rung: i }));
  // The variant order the selection indexes into is the registered order:
  // families in ladder declaration order, rungs ascending.
  const declOrder = Object.keys(ladders);
  const faultedDecl = [];
  for (const f of declOrder) ladders[f].rungs.forEach((m, i) => faultedDecl.push({ family: f, rung: i }));

  const replay = corpus.cases.map((c) => {
    const k = sha256(Buffer.concat([seed, Buffer.from(c.case_id)]));
    const u = k.readUInt32BE(0) / 2 ** 32;
    if (u < rule.clean_fraction) return { case_id: c.case_id, family: 'clean', rung: -1 };
    const pick = faultedDecl[k.readUInt32BE(4) % faultedDecl.length];
    return { case_id: c.case_id, family: pick.family, rung: pick.rung };
  });
  check(canon(replay) === canon(corpus.trial.selection),
    'the realised trial replays exactly from those beacons', `${replay.length} cases`);

  const byKey = new Map(corpus.catalogue.map((e) => [`${e.case_id}|${e.family}|${e.rung}`, e]));
  let tp = 0; let fn = 0; let tn = 0; let fp = 0;
  let allPresent = true;
  for (const t of replay) {
    const e = byKey.get(`${t.case_id}|${t.family}|${t.rung}`);
    if (!e) { allPresent = false; break; }
    if (t.family === 'clean') { if (e.flagged) fp++; else tn++; } else if (e.flagged) tp++; else fn++;
  }
  check(allPresent, 'every point the beacon selected was already in the catalogue');
  check(allPresent && tp === cp.trial.tp && fn === cp.trial.fn && tn === cp.trial.tn && fp === cp.trial.fp
    && close(cp.trial.sensitivity, tp / (tp + fn)) && close(cp.trial.specificity, tn / (tn + fp)),
    'the trial score recomputes from verdicts already in the catalogue',
    `tp=${tp} fn=${fn} tn=${tn} fp=${fp}`);

  // ---- 14. the whole log replays ------------------------------------------
  const header = {
    origin: corpus.origin,
    scheme_version: corpus.scheme_version,
    reference: corpus.reference,
    decision_rule: corpus.decision_rule,
    case_list_root: corpus.case_list_root,
    registered_at: corpus.registered_at,
    beacons_committed: corpus.beacons_committed,
  };
  const leaves = [Buffer.from(canon(header))];
  for (const c of corpus.cases) leaves.push(Buffer.from(canon(c)));
  for (const e of corpus.catalogue) leaves.push(Buffer.from(canon(e)));
  leaves.push(Buffer.from(canon(corpus.trial)));
  leaves.push(Buffer.from(canon({ curve: corpus.curve, floor_test: corpus.floor_test })));
  check(leaves.length === cp.tree_size, 'the published tree size matches the published corpus',
    `${leaves.length} leaves`);
  check(mth(leaves).toString('hex') === cp.root_sha256,
    'the whole log replays to the published tree head');

  // ---- 15. the witness ------------------------------------------------------
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
    console.log(`${failed} OF ${checked} CHECKS FAILED - do not rely on the published figures`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('REFUSED -', e.message); process.exit(2); });
