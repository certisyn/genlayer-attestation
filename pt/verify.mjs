// =============================================================================
// scripts/pt/pt-verify.mjs - check a published Certisyn proficiency checkpoint.
// =============================================================================
// Written to be run by someone who does not trust Certisyn. It imports nothing
// from this repository, takes no arguments, and fetches everything it needs
// from public sources: GitHub raw, the drand League of Entropy API, and a
// GenLayer Asimov node.
//
// What it establishes, in order:
//
//   1  the checkpoint signature verifies under the published key
//   2  that signature actually BINDS the score - not a formality: the first
//      published checkpoint was signed in a form that excluded it
//   3  the beacon round is real and the randomness derives from its signature
//   4  the case list hashes to the committed root
//   5  the control selection replays exactly from that root and that beacon
//   6  the entire log replays, leaf by leaf, to the published tree head
//   7  the committed round had not published when the rule was registered
//   8  a committee Certisyn does not operate attested this exact document
//
// No dependencies and no install: node, three public HTTPS endpoints, done in
// seconds. The canonical digest is printed either way so it can also be
// compared by hand against the chain.
//
// Run:  node scripts/pt/pt-verify.mjs
// =============================================================================

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

const BASE = 'https://raw.githubusercontent.com/certisyn/genlayer-attestation/main/pt';
const DRAND_CHAIN = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const DRAND_GENESIS = 1692803367;
const DRAND_PERIOD = 3;
const RPC = 'https://rpc-asimov.genlayer.com';
const CONTRACT = '0xc17444190051819529815C4e0C15a0557068a7f2';

// The GenLayer calldata for the zero-argument view method get_latest.
//
// Hard-coded rather than encoded, on purpose. Reaching the chain through the
// genlayer CLI means an npx install of a package that pulls eslint and a native
// addon - minutes on a cold cache, and a verifier nobody waits for is a
// verifier nobody runs. This is one POST to a public RPC endpoint with no
// dependencies at all.
//
// Captured from genlayer CLI 0.39.2 on the wire and cross-checked against three
// other zero-arg methods on the same contract. The structure is a map
// {"method": "get_latest"} in GenVM calldata encoding. If the encoding ever
// changes, the node answers with an error rather than a wrong record, so this
// fails loudly.
//
// Regenerate with:
//   node --import ./sniff.mjs <cli> call <address> get_latest
// where sniff.mjs wraps global fetch and prints the gen_call params.
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

// ------------------------------------------------------------------ reporting

let failed = 0;
let checked = 0;
const check = (ok, label, detail = '') => {
  checked++;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};
const note = (label, detail) => console.log(`  ----  ${label}   ${detail}`);

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
  return r.json();
}

async function main() {
  console.log('Checking a published Certisyn proficiency checkpoint.');
  console.log('Nothing below is taken on Certisyn\'s word.\n');

  const signed = await getJson(`${BASE}/checkpoint.json`);
  const corpus = await getJson(`${BASE}/corpus.json`);
  const cp = signed.checkpoint;
  const s = cp.score;

  console.log(`origin       ${cp.origin}`);
  console.log(`timestamp    ${cp.timestamp}`);
  console.log(`published    n=${s.n} tp=${s.tp} fn=${s.fn} tn=${s.tn} fp=${s.fp}`);
  console.log(`             sensitivity ${s.sensitivity} specificity ${s.specificity}`);
  console.log(`             kappa ${s.cohen_kappa}\n`);

  // ---- 1. the signature -----------------------------------------------------
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

  // ---- 2. the signature covers the score ------------------------------------
  // A signature is worth exactly what it covers. JSON.stringify(obj, keyArray)
  // filters keys at every depth, so a checkpoint signed that way binds its
  // top-level scalars and serialises its score as {}. Under that form the
  // published sensitivity can be edited and the signature still verifies. This
  // check is what makes that class of defect impossible to ship again.
  const tamperScore = { ...cp, score: { ...s, sensitivity: 0.123456, fn: (s.fn ?? 0) + 7 } };
  const tamperRoot = { ...cp, root_sha256: '0'.repeat(64) };
  check(!verifies(tamperScore), 'editing the score breaks the signature');
  check(!verifies(tamperRoot), 'editing the tree head breaks the signature');

  // ---- 3. the beacon --------------------------------------------------------
  const beacon = await getJson(`https://api.drand.sh/v2/chains/${DRAND_CHAIN}/rounds/${cp.beacon_round}`);
  check(beacon.round === cp.beacon_round, `drand round ${cp.beacon_round} exists and is that round`);
  check(beacon.signature === cp.beacon_signature,
    'the checkpoint quotes the signature the beacon actually published');
  const randomness = sha256(Buffer.from(beacon.signature, 'hex')).toString('hex');
  check(randomness === corpus.beacon.randomness,
    'the randomness is the digest of that beacon signature');

  // ---- 4 and 5. the selection ----------------------------------------------
  const ids = corpus.cases.map((c) => c.case_id).sort();
  const listRoot = mth(ids.map((c) => sha256(Buffer.from(c))));
  check(listRoot.toString('hex') === cp.case_list_root,
    'the case list hashes to the committed root', `${ids.length} cases`);

  const seed = sha256(Buffer.concat([Buffer.from(randomness, 'hex'), listRoot]));
  const scored = ids.map((id) => ({
    id,
    v: sha256(Buffer.concat([seed, Buffer.from(id)])).readBigUInt64BE(0),
  }));
  scored.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : 0));
  const k = Math.max(1, Math.round(ids.length * corpus.decision_rule.control_fraction));
  const replayed = scored.slice(0, k).map((x) => x.id).sort();
  const published = [...corpus.selection.controls].sort();
  check(JSON.stringify(replayed) === JSON.stringify(published),
    'the control selection replays exactly', `${replayed.length} of ${ids.length}`);

  // ---- 6. the whole log replays --------------------------------------------
  // Not just the tree head: every leaf is rebuilt from published data. If one
  // case were added, dropped, reordered or reclassified after the fact, the
  // head would not land here.
  const controls = new Set(published);
  const leaves = [Buffer.from(canon(corpus.registration))];
  for (const c of corpus.cases) {
    leaves.push(Buffer.from(canon({
      case_id: c.case_id,
      first_t: c.first_t,
      states: c.states,
      seeded: controls.has(c.case_id),
    })));
  }
  leaves.push(Buffer.from(canon({
    score: s, round: cp.beacon_round, case_list_root: cp.case_list_root, violations: cp.violations,
  })));
  const root = mth(leaves).toString('hex');
  check(leaves.length === cp.tree_size, 'the published tree size matches the published corpus',
    `${leaves.length} leaves`);
  check(root === cp.root_sha256, 'the whole log replays to the published tree head');

  // ---- 7. the selection could not have been chosen -------------------------
  // This is the load-bearing one. Everything above proves the arithmetic; this
  // proves the arithmetic was committed to before its input existed.
  const registeredAt = Date.parse(corpus.registration.registered_at) / 1000;
  const roundTime = DRAND_GENESIS + (cp.beacon_round - 1) * DRAND_PERIOD;
  check(roundTime > registeredAt,
    'the committed round had not published when the rule was registered',
    `${Math.round(roundTime - registeredAt)} s ahead`);
  check(corpus.registration.beacon.committed_round === cp.beacon_round,
    'the round scored is the round registered');

  // ---- 8. the witness -------------------------------------------------------
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
    check(rec.outcome === 'attested', 'the committee recorded an attestation',
      `outcome=${rec.outcome}`);
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
