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

## Proficiency testing without an external seeder

Attestation establishes that a document is the one Certisyn published. It says nothing about
whether the determination inside it is right. That is a different question and it takes a
different instrument.

The hard part of building that instrument is not the arithmetic. It is that **a proficiency
scheme run by the party being measured lets that party choose the denominator** - which cases,
which fault, how large. The textbook remedy is an external seeder: a second organisation
injecting cases through normal intake. Where no second organisation exists, the usual conclusion
is that blindness is unavailable and the numbers are worth less.

It is available, and it does not need a second organisation. Two properties a stranger can
check, and one the scheme would rather not have to publish.

### Exhaustiveness replaces the seeder

Every point in a registered difficulty space is built and judged **before either beacon
publishes**. Four fault families, twelve rungs each, plus a clean variant, across 60 cases from a
Copernicus Sentinel-1 precise orbit: 2,940 evaluations, every one logged with its verdict.

Exhaustiveness *is* the independence proof. A catalogue containing every point has no free
parameter left to tune. `verify.mjs` recomputes the expected point set from the registration
alone - before it reads a single verdict - and requires an exact match: nothing missing, nothing
added, nothing duplicated, every magnitude equal to its registered rung.

### The beacon picks the headline

Which points make up the realised trial is drawn afterwards from two public beacons the scheme
does not operate, under a rule registered before either published.

| beacon | shape | period | unpublished value answers |
|---|---|---|---|
| drand quicknet | threshold BLS, League of Entropy, many operators | 3 s | `425 Too Early` |
| NIST Randomness Beacon 2.0 | one US federal instrument, own hardware | 60 s | `404 Not Found` |

`seed = sha256(drand_randomness || nist_output || case_list_root)`. Steering the selection takes
both operators at once, and the case list is committed before either beacon is named.

### The floor test

**A ladder whose lowest rung is still detected was chosen to flatter.** So every ladder must
contain rungs the register *fails*, and `verify.mjs` fails the document if any ladder does not.
A proficiency result that detected everything it tested has not found its floor and is not
evidence of one.

This is the check that costs something to pass, which is why it is here.

### What the register actually resolves

Measured 17 September 2026. Detection rate by fault magnitude, 60 cases per rung:

```
position_step (m)
  1    3    10   30   100  300  1k   3k   10k  30k  100k 300k
  0%   0%   0%   0%   0%   0%   28%  77%  92%  98%  100% 100%
  floor 30 km          highest level still missed: 10 km

position_drift (m, total across the window)
  0%   0%   0%   0%   0%   0%   20%  67%  85%  98%  100% 100%
  floor 30 km          highest level still missed: 10 km

velocity_step (m/s)
  0.001 0.003 0.01 0.03 0.1  0.3  1    3    10   30   100  300
  0%    0%    0%   0%   0%   0%   22%  83%  82%  97%  100% 100%
  floor 30 m/s         highest level still missed: 10 m/s

time_skew (s)
  0.001 0.01 0.1  0.5  1    2    5    10   30   60   120  300
  0%    0%   0%   0%   0%   0%   0%   100% 100% 100% 100% 100%
  floor 10 s           highest level still missed: 5 s
```

```
clean variants   60      false flags 0
specificity      1.0000  95% CI [0.9398, 1.0000]
FLOOR TEST       PASS    4 of 4 families contain rungs the register misses
```

Read the last row first. **This register refutes an orbital track that is inconsistent by 30 km
or more, and it does not see 300 m.** It is a feasibility check, not precision orbit
determination, and now it says so in numbers a relying party can design against.

Three findings worth naming:

- **`time_skew` is a step function at the sampling interval.** Nothing below 10 s, everything at
  and above it. A timestamp error smaller than the cadence is invisible to this register, because
  there is no state between two samples to contradict it. That is a structural blind spot, not a
  tuning problem, and it is published rather than discovered later.
- **Drift is harder than a step at every rung** - 20% against 28% at 1 km. A discontinuity is a
  contradiction between two adjacent states; a ramp is consistent with every neighbour and only
  contradicts the whole.
- **`velocity_step` reads 83% at 3 m/s and 82% at 10 m/s.** The intervals overlap at n=60, so it
  is one ladder's worth of noise rather than a reversal. It is printed as measured rather than
  smoothed.

### The realised trial

```
60 cases   tp=15 fn=33 tn=12 fp=0
sensitivity 0.3125   specificity 1.0000
```

The beacon drew uniformly across the whole registered range, so most faulted cases it selected
sit below the register's resolution. **That number is a property of the ladder as much as of the
register, and it is published beside the floors rather than instead of them.** A scheme reporting
only a headline sensitivity is reporting where it chose to sample.

### Check it yourself

No install, no dependencies, no permission from Certisyn:

```bash
node pt/verify.mjs
```

Fifteen things, from the sources that issued them:

| # | check |
|---|---|
| 1 | the checkpoint declares the canonical form it was signed in |
| 2 | the signature verifies under the published key |
| 3 | that signature binds every published figure |
| 4 | **the catalogue is exactly the registered space** - no point missing, none added |
| 5 | the case list hashes to the committed root |
| 6 | the detection curve recomputes from the catalogue |
| 7 | each detection floor recomputes from the curve |
| 8 | **the floor test holds** - every ladder reaches below the register's floor |
| 9 | the specificity figure recomputes from the clean variants |
| 10 | both beacons are real and land where the commitment said |
| 11 | both beacon commitments postdate the registration |
| 12 | the realised trial replays exactly from those beacons |
| 13 | the trial score recomputes from verdicts already in the catalogue |
| 14 | the whole log replays, leaf by leaf, to the published tree head |
| 15 | a committee Certisyn does not operate attested this exact document |

### Is the verifier itself any good?

```bash
node pt/negative-test.mjs
```

Twenty-six deliberately corrupted catalogues served over localhost, each shown to a copy of
`verify.mjs`, each required to be refused. All twenty-six are refused, each by a named check. The corruptions attack the three load-bearing
properties rather than exercising the code: deleting the rungs the register misses, marking the
misses as detected to erase the floor, adding a flattering entry, rewriting a magnitude, editing
the trial to drop the misses, swapping a beacon for one that has not published, back-dating the
registration.

The honest baseline is required to fail exactly one check and no others - the endpoint check,
which localhost cannot satisfy by construction. Requiring that specific single failure is a
stronger baseline than requiring a pass.

### Where the transfers came from

- **Metrology, limit of detection.** A laboratory does not publish "15 of 15 spikes recovered".
  It publishes the level at which the method detects with stated probability, over a ladder its
  validation protocol fixes rather than the run chooses.
- **Psychophysics, the method of constant stimuli.** Every intensity in a fixed range is
  presented, catch trials are interleaved at a registered rate, and the output is a curve. An
  observer cannot game a design in which every intensity appears.
- **Clinical trials, allocation concealment.** Distinct from blinding: it asks whether the party
  enrolling can foresee the assignment. Concealment by commitment substitutes for an independent
  randomisation centre. Inadequate concealment is measured to exaggerate effect estimates by 30
  to 40 percent, which is the size of the error this design avoids.

### What it still does not establish

The fault taxonomy is the scheme's own. A fault shape outside the four families is untested, and
no amount of exhaustiveness inside the taxonomy closes that.

The textbook answer to estimating what an instrument misses is capture-recapture, and it does not
transfer here: it needs two detectors that fail independently, and two registers over the same
track share the reference record, the frame handling and the regime. **That residue - fault-shape
diversity - is the part an external seeder would still buy.** Difficulty selection, headline
selection and concealment no longer require one.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Built by [Certisyn, Inc.](https://certisyn.com) - independent, pre-transaction
verification for agent commerce.
