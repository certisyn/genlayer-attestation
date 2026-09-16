# CertisynAttestation

A GenLayer Intelligent Contract that records what an independent committee of
validators observed when it read a Certisyn determination endpoint.

```
                    each validator fetches independently
                    over its own network path
  certisyn.com  ->  canonicalise -> sha256  ->  strict_eq  ->  unanimous ACCEPTED
  /capability       (raw bytes never cross consensus)          on-chain record
```

The committee does not take Certisyn's word for anything. Each validator reads
the endpoint itself, reduces the document to a canonical digest, and the digests
are compared. What lands on chain is a statement by parties with no interest in
the outcome, checked against a digest the submitter declared **before** the read.

## Proven on Asimov

Live, unanimous, 15 September 2026.

```
contract   0x96db0Ba9E4F31eB4Ec12bAFf92Ed458a46742890
attest tx  0xcd208acef27fb8c0597c24af1d87cf7e6814407821a00ca6cdd9a900193d8b3e
status     ACCEPTED    execution FINISHED_WITH_RETURN    result AGREE
votes      AGREE, AGREE, AGREE, AGREE, AGREE   (5 of 5)
outcome    attested
```

Five validators, none of them operated by Certisyn, each read the endpoint over
its own network path and agreed on its digest - against a value declared in the
transaction before any of them read anything.

Full record, and four platform behaviours characterised along the way, in
[RUN-RECORD.md](RUN-RECORD.md).

## Why this is not a toy

Self-attestation cannot establish independence, by construction. A vendor
asserting its own conformance is the weakest evidence class there is, and no
amount of signing changes that - the signer and the subject are the same party.

GenLayer's Optimistic Democracy supplies the missing ingredient cheaply: a
committee of validators that the subject does not operate, does not pay, and
cannot select. Running a determination through `strict_eq` converts a
self-assertion into an independently witnessed one. That is a different
evidence class, not a better-presented version of the same one.

## What the committee actually agrees on

Only four values cross the equivalence principle:

| value | type | why |
|---|---|---|
| `canonical_digest` | `str` | sha256 of the document reduced to canonical JSON |
| `raw_digest` | `str` | sha256 of the exact response bytes |
| `status` | `int` | the HTTP status the validator saw |
| `size` | `int` | response length in bytes |

Raw web content never reaches strict equality. This satisfies the GenVM linter
rule **GL-S03**, and more importantly it means the committee cannot be split by
whitespace, key ordering or transport framing - only by the document actually
being different.

Canonicalisation is:

```python
json.dumps(document, sort_keys=True, separators=(",", ":"),
           ensure_ascii=True, allow_nan=False)
```

`ensure_ascii=True` is deliberate. The source document carries 3 non-ASCII
bytes; escaping them means no Unicode normalisation difference can ever reach
consensus. Verified idempotent - the canonical form of the canonical form is
byte-identical to itself.

## Refusal is a recorded outcome

A verifier that can only say yes is not a verifier. Four outcomes are stored,
and three of them are not a pass:

| outcome | meaning |
|---|---|
| `attested` | read, parsed, and the digest matched the one declared beforehand |
| `digest_mismatch` | read and parsed, but the document is not the one declared |
| `refused_unavailable` | endpoint did not answer 200, or answered with no body |
| `refused_unparseable` | answered, but the body is not JSON |

None of these throws. All four are written to storage with the HTTP status, the
byte count, the relying party and the transaction reference. A determination
that could not be made is evidence in its own right, and discarding it is how
verification systems quietly become rubber stamps.

## The failure mode worth naming out loud

If the document changes between one validator's read and another's - a
redeployment landing inside the consensus round - the digests differ and strict
equality fails. The transaction does not finalise.

**This is correct behaviour.** The committee declines to attest a document that
moved while it was being read. It is also an operational constraint: do not ship
to production while a committee is mid-round on a determination.

## Measured reproducibility

The design assumes the endpoint is byte-stable across validator geographies.
That was measured rather than assumed, and the first sample was rejected on
inspection of the transport.

Fourteen consecutive fetches returned identical bytes. The response headers
showed `x-vercel-cache: HIT` with `age` climbing against `s-maxage=3600`: all
fourteen observations were one cached object replayed from one edge, an
effective sample size of 1. A cache-busting query string did not change the
cache key. Reading the headers before the bytes is what distinguished fourteen
observations from one.

The real evidence came from a hostname with its own cache namespace, which
returned `x-vercel-cache: PRERENDER` carrying the identical content hash. The
document is a build-time prerendered artifact, not a per-request computation, so
every edge serves the same immutable object. Byte-identity across geographies is
therefore structural rather than incidental. Re-measured 24 hours later across
roughly 24 independent cache regenerations: unchanged.

```
size              6350 bytes
raw sha256        e66942181ed93bc2cb3548af47727abf85e2eb9636f68ba0911f2e3b990b78ce
canonical sha256  a3d632c0aeea0fbd587b0e6884c42d827f6a7a8f0cb6372da5435208ca76b905
```

The canonical form contains exactly one float, `0.6190476190476191`, at 17
significant digits - CPython's shortest-round-trip repr, stable across every
CPython 3.12 and later build. All validators run the same GenVM CPython 3.13.

## Quickstart

```bash
npm install -g genlayer
genlayer network set testnet-asimov

genlayer deploy --contract ./contracts/certisyn_attestation.py \
  --args https://certisyn.com/api/v1/verification/capability

genlayer write <address> attest \
  --args a3d632c0aeea0fbd587b0e6884c42d827f6a7a8f0cb6372da5435208ca76b905 \
         "Relying Party Name" "your-transaction-ref"

genlayer receipt <txId> --status ACCEPTED
genlayer call <address> get_latest
```

Pass an empty string as the first argument to record an observation without
asserting an expected digest.

**Read [RUN-RECORD.md](RUN-RECORD.md) first.** CLI 0.39.2 passes the bare gas
estimate and deploys revert with `FailedCall()`; 0.40.0-rc.3 does not broadcast
on this chain; and a second `#` comment line beneath the `Depends` header fails
the contract inside GenVM while the transaction still reports `ACCEPTED`. Each is
documented there with its working configuration.

## ABI

```
constructor(endpoint: str)

attest(expected_digest, relying_party, transaction_ref) -> str   [write]
get_endpoint()                                          -> str   [view]
get_record_count()                                      -> int   [view]
get_latest_id()                                         -> str   [view]
get_record(record_id)                                   -> str   [view]
get_latest()                                            -> str   [view]
list_record_ids()                                       -> str   [view]
```

Views returning `str` return JSON.

## Verification

```bash
pip install genvm-linter          # requires Python 3.12 or newer
genvm-lint check contracts/certisyn_attestation.py
```

Passes lint, SDK validation and Pyright with zero findings against genvm
v0.2.16. Note that the v0.3.0 release candidates break this API surface -
`import genlayer as gl`, `gl.contract.Contract` - so do not follow v0.3 docs
while the `Depends` header points at v0.2.16.

## What this establishes, and what it does not

**Establishes.** A committee of validators, none operated by Certisyn, each read
the document over its own network path and agreed unanimously on its digest,
against a value declared before the read.

**Does not establish.** Anything about whether the determination is correct. It
establishes that the determination is the one Certisyn published, read by
parties with no interest in the answer.

Naming that boundary is the point. A verification system that will not say what
it could not determine is not offering verification; it is offering reassurance.

## Proficiency testing, and how to check it yourself

Attestation establishes that a document is the one Certisyn published. It says nothing about
whether the determination inside it is right. That is a different question and it takes a
different instrument.

`pt/` carries a proficiency scheme in the ISO/IEC 17043 sense, run against the production orbital
register - the same function the product calls, not a stub. Cases are minted from a Copernicus
Sentinel-1 AUX_POEORB precise orbit. A quarter of them carry a seeded 120 km displacement. Which
quarter is decided by two independent public beacons that had not published when the replicate
was registered, so the selection was unavailable to anyone - Certisyn included - at the moment
the decision rule was fixed. The run is logged as an RFC 6962 Merkle tree, the head is signed,
and the signed document is attested by a committee of validators Certisyn does not operate.

### Two beacons, because they fail differently

| beacon | shape | period | unpublished value answers |
|---|---|---|---|
| drand quicknet | threshold BLS, League of Entropy, many operators | 3 s | `425 Too Early` |
| NIST Randomness Beacon 2.0 | one US federal instrument, own hardware | 60 s | `404 Not Found` |

The selection seed is `sha256(drand_randomness || nist_output || case_list_root)`. Steering the
selection requires both operators at the same time, and the case list is already committed before
either beacon is named, so neither can be chosen to suit the other. Certisyn operates neither
beacon and runs no randomness service of its own.

### The published series

Eight replicates, 16 September 2026, register `S1.orbital_feasible`, 60 cases per replicate from
one reference record.

```
480 case judgements   120 seeded   360 clean

detected     119 of 120        missed 1
false flags    0 of 360

sensitivity  0.9917   95% CI [0.9543, 0.9985]
specificity  1.0000   95% CI [0.9894, 1.0000]
Cohen kappa  0.9944
```

The interval is Wilson, not the normal approximation. At a proportion of 1.0 the normal
approximation returns [1, 1], which would state a detection floor of 100 percent from a finite
sample. Wilson keeps the lower bound below 1, which is the shape of claim a bounded run can
actually support. **The register misses roughly one seeded 120 km displacement in 120, and the
floor is bounded at 95.4 percent, not claimed at 100.**

### Check it yourself

No install, no dependencies, no permission from Certisyn:

```bash
node pt/verify.mjs
```

It fetches the checkpoint, the corpus, every drand round, every NIST pulse and the on-chain
record from their own sources, and establishes thirteen things:

| # | check |
|---|---|
| 1 | the checkpoint declares the canonical form it was signed in |
| 2 | the signature verifies under the published key |
| 3 | that signature **binds the score** - editing any published number breaks it |
| 4 | every drand round is real and its randomness derives from its signature |
| 5 | every NIST pulse is real and lands where the commitment said it would |
| 6 | every selection seed is the digest of both beacon outputs and the case list |
| 7 | every control selection replays exactly |
| 8 | both beacon commitments postdate the replicate's registration |
| 9 | the case list hashes to the committed root |
| 10 | the whole log replays, leaf by leaf, to the published tree head |
| 11 | the pooled figures recompute from the per-replicate figures |
| 12 | the Wilson intervals recompute from the pooled counts |
| 13 | a committee Certisyn does not operate attested this exact document |

Check 3 carries weight. The first published checkpoint was signed with
`JSON.stringify(obj, Object.keys(obj).sort())`, which reads as a canonicaliser and is not one:
the array replacer filters keys at every depth, so the nested score serialised as `{}` and fell
outside the signature. Two checkpoints with entirely different scores produced byte-identical
signing bodies. The scheme found it by asserting that tampering **fails**, rather than that the
honest document passes. The signing form is now declared in the document as `canon_alg` and
check 3 fails loudly if it ever regresses.

Check 8 is load bearing. Everything above it proves the arithmetic; check 8 proves the arithmetic
was committed to before its inputs existed, and that moving it takes two beacon operators at once.

### Is the verifier itself any good?

A verifier only ever run against an honest document has not been tested. `pt/negative-test.mjs`
serves fifteen deliberately corrupted checkpoints over localhost, points a copy of `verify.mjs`
at each one, and requires a refusal every time.

```bash
node pt/negative-test.mjs
```

The honest baseline is required to fail exactly one check and no others - the endpoint check,
which localhost cannot satisfy by construction. Requiring that specific single failure is a
stronger baseline than requiring a pass.

### What the scheme found

**An interface defect.** Specific orbital energy is an inertial invariant. AUX_POEORB publishes
EARTH_FIXED state vectors, and the register applied the invariant to them directly: measured
energy spread 23,681 J/kg against a 5,000 J/kg budget, falling to 8,494 J/kg once the rotation
term was restored. Uncorrected that flagged 35 of 45 clean orbits. The frame is now declared at
the type boundary and converted before any energy conclusion is drawn. Where a caller declares no
frame and the track fails the budget as supplied but passes it once treated as rotating, the
register reports that it cannot separate the two hypotheses and raises nothing - an inability is
not a finding.

**A signing defect**, described above, in the scheme's own evidence path.

**A detection floor**, now measured rather than asserted: 119 of 120, bounded at 95.4 percent.

### Reading the on-chain record by hand

```bash
npx --yes genlayer@0.39.2 call <contract> get_latest \
  --rpc https://rpc-asimov.genlayer.com
```

The version pin matters. GenLayer CLI 0.40.0-rc.3 cannot resolve methods on a contract built
against genvm v0.2.16: it answers a view call with a bare `genvm execution error` and no message,
which reads as a failed claim when it is a failed toolchain. `verify.mjs` does not use the CLI at
all - it posts one `gen_call` to the public RPC - and names the pin when a manual check is wanted.

### What the scheme does not establish

Cases are seeded openly: Certisyn mints them and knows which are controls. **Blindness requires a
third party to inject cases through normal intake.** One register, over one reference record, on
one day. Until an external seeder exists this is a measurement under a published method that
anyone can replay, and it is described in exactly those words wherever it is cited.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Built by [Certisyn, Inc.](https://certisyn.com) - independent, pre-transaction
verification for agent commerce.
