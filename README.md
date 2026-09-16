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
That was measured rather than assumed, and the first evidence collected was
worthless.

Fourteen consecutive fetches returned identical bytes - but the response headers
showed `x-vercel-cache: HIT` with `age` climbing against `s-maxage=3600`. All
fourteen observations were one cached object replayed from one edge. Effective
sample size: 1. A cache-busting query string did not change the cache key.

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

Attestation establishes that a document is the one Certisyn published. It says
nothing about whether the determination inside it is right. That is a different
question and it takes a different instrument.

`pt/` carries a proficiency test in the ISO/IEC 17043 sense, run against the
production orbital register - the same function the product calls, not a stub.
Cases are minted from a Copernicus Sentinel-1 AUX_POEORB precise orbit. A
quarter of them carry a seeded 120 km displacement. Which quarter is decided by
a drand League of Entropy round that had not published when the decision rule
was registered, so the selection was unavailable to anyone - including Certisyn
- at the moment the rule was fixed. The run is logged as an RFC 6962 Merkle
tree, the head is signed, and the signed document is attested by the committee.

Check it yourself. Needs node, nothing else, no install:

```bash
node pt/verify.mjs
```

It fetches the checkpoint, the corpus, the drand round and the on-chain record
from their own sources and establishes eight things:

| # | check |
|---|---|
| 1 | the checkpoint signature verifies under the published key |
| 2 | that signature **binds the score** - editing it breaks the signature |
| 3 | the beacon round is real and the randomness derives from its signature |
| 4 | the case list hashes to the committed root |
| 5 | the control selection replays exactly from that root and that beacon |
| 6 | the entire log replays, leaf by leaf, to the published tree head |
| 7 | the committed round had not published when the rule was registered |
| 8 | a committee Certisyn does not operate attested this exact document |

Check 2 is not a formality. The first published checkpoint was signed with
`JSON.stringify(obj, Object.keys(obj).sort())`, which looks like a
canonicaliser and is not: the array replacer filters keys at every depth, so the
nested score serialised as `{}` and fell outside the signature. Two checkpoints
with entirely different scores produced byte-identical signing bodies. Found by
writing the verifier, which is the argument for writing one. The signing form is
now declared in the document as `canon_alg` and check 2 fails loudly if it ever
regresses.

### Is the verifier itself any good?

A verifier that has only ever been run against an honest document has not been
tested. `pt/negative-test.mjs` serves eleven deliberately corrupted checkpoints
over localhost, points a copy of `verify.mjs` at each one, and requires a
refusal every time.

```bash
node pt/negative-test.mjs
```

```
  ok      the honest document fails only the localhost endpoint check
  REFUSED score edited after signing          (signature)
  REFUSED tree head edited                    (signature)
  REFUSED beacon signature swapped            (signature)
  REFUSED canon_alg removed                   (declared canonical form)
  REFUSED signature replaced                  (signature)
  REFUSED violation counts edited             (signature)
  REFUSED a case removed from the corpus      (case list root)
  REFUSED a control reclassified              (selection replay)
  REFUSED registration back-dated             (log replay)
  REFUSED the decision rule rewritten         (log replay)
```

The honest baseline is required to fail exactly one check and no others: served
from localhost, the on-chain record says `raw.githubusercontent.com` and the
verifier is right to notice. Requiring that specific single failure is a
stronger baseline than requiring a pass.

Check 7 is the load-bearing one. Everything above it proves the arithmetic;
check 7 proves the arithmetic was committed to before its input existed.

### What the run found

Two defects, which is the point of running it.

**An interface defect.** Specific orbital energy is an inertial invariant.
AUX_POEORB publishes EARTH_FIXED state vectors, and the register applied the
invariant to them directly. Measured energy spread 23,681 J/kg against a
5,000 J/kg budget, falling to 8,494 J/kg once the rotation term was restored.
Uncorrected that flagged 35 of 45 clean orbits - specificity 0.2222. The frame
is now declared at the type boundary and converted before any energy conclusion
is drawn, with a regression test that fails if the conversion is removed.

**A detection floor.** The first run missed one seeded fault in 15. A later run
with a different control set missed none. One run is not a detection floor;
characterising it takes repetition, and the runs are published as they happen
rather than after the good one.

### Reading the on-chain record

```bash
npx --yes genlayer@0.39.2 call <contract> get_latest \
  --rpc https://rpc-asimov.genlayer.com
```

The version pin matters. GenLayer CLI 0.40.0-rc.3 cannot resolve methods on a
contract built against genvm v0.2.16: it answers a view call with a bare `genvm
execution error` and no message, which reads as a failed claim when it is a
failed toolchain. `verify.mjs` pins it for this reason and says so when it
cannot read the chain, rather than passing quietly.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Built by [Certisyn, Inc.](https://certisyn.com) - independent, pre-transaction
verification for agent commerce.
