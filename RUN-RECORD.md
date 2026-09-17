# Run record - GenLayer Asimov testnet

Live, unanimous, 15 September 2026.

```
network      Asimov testnet, chain 4221
contract     0x96db0Ba9E4F31eB4Ec12bAFf92Ed458a46742890
attest tx    0xcd208acef27fb8c0597c24af1d87cf7e6814407821a00ca6cdd9a900193d8b3e
status       ACCEPTED
execution    FINISHED_WITH_RETURN
result       AGREE
votes        AGREE, AGREE, AGREE, AGREE, AGREE   (5 of 5)
```

The record the committee wrote, read back from chain with `get_latest`:

```json
{
  "record_id": "cs-1",
  "outcome": "attested",
  "endpoint": "https://certisyn.com/api/v1/verification/capability",
  "expected_digest":  "a3d632c0aeea0fbd587b0e6884c42d827f6a7a8f0cb6372da5435208ca76b905",
  "canonical_digest": "a3d632c0aeea0fbd587b0e6884c42d827f6a7a8f0cb6372da5435208ca76b905",
  "raw_digest": "e66942181ed93bc2cb3548af47727abf85e2eb9636f68ba0911f2e3b990b78ce",
  "doc_bytes": 6350,
  "http_status": 200,
  "relying_party": "Certisyn, Inc.",
  "transaction_ref": "asimov-proof-001",
  "attestor": "0x2e750251ad8Ea40FFebA0F2EB66240436B0A758E"
}
```

## What this settles

`expected_digest` was declared in the transaction, before any validator read
anything. `canonical_digest` is what the committee independently computed. They
match, so the outcome is `attested` rather than `digest_mismatch`.

`raw_digest` is the more interesting line. It is byte-for-byte the sha256
measured from a single client in Sydney hours earlier. Five validators, none of
them operated by Certisyn, each fetching over its own network path from its own
geography, produced that same hash. The byte-stability of the endpoint was an
open question that could not be settled from one vantage point. It has now been
settled by parties with no interest in the answer.

## Platform behaviours characterised during this deployment

Four, each reproducible. None of them concern the contract.

**1. The GenVM runner parse consumes beyond line 1.**
This file's first line is the `Depends` header and its second line is blank. A
second `#` line directly beneath the header produces:

```
target: genvm::runners::parse
error: { causes: [ 'trailing characters at line 1 column 84' ] }
```

Column 84 is the character immediately after the 83-character header. The outer
transaction reports `status: ACCEPTED` and returns a contract address; execution
reports `txExecutionResultName: FINISHED_WITH_ERROR` and no contract exists. A
module docstring in that position behaves identically. A failure that reports
success at the layer most callers check is worth surfacing.

**2. CLI 0.39.2 passes the bare gas estimate as the gas limit.**
An inner call in the ghost-factory deploy path exhausts gas, returns empty revert
data, and OpenZeppelin's `Address` converts that into `FailedCall()` - selector
`0xd6bda275`. Deploys revert at EVM `status 0x0`. Where estimation fails on the
RPC the fallback is a flat 200,000 against roughly 1.38M required.

Release candidate 0.40.0-rc.3 adds the headroom, but ships genlayer-js v2, whose
`addTransaction` calldata Asimov's consensus contract does not accept - its gas
estimation reverts every time and it never broadcasts at all.

Working configuration: 0.39.2 with `gas: estimatedGas` changed to
`gas: estimatedGas * 2n` in the bundled `genlayer-js`. Unused gas is refunded, so
headroom costs nothing. 3x overshoots the block limit on a 7KB contract and is
rejected with `gas limit too high`.

**3. `--fee-value` is accepted by the CLI and discarded by the SDK.**
CLI 0.39.2 parses it into a fees object and hands it to genlayer-js 1.1.8, which
carries no fee support. The transaction goes out at `value = 0x0` regardless.
Harmless on Asimov, which uses the v6 non-fee `addTransaction` ABI, but it points
diagnosis at a fee problem that does not exist. Omit it.

**4. The Asimov RPC does not implement `net_version`.**
MetaMask's manual "Add a network" flow calls it, receives `method not found`, and
surfaces "Could not fetch chain ID" - which misdirects, since `eth_chainId`
returns `0x107d` correctly. The faucet's one-click add is unaffected; only the
manual path breaks.

**5. CLI 0.40.0-rc.3 cannot resolve methods on a v0.2.16 contract.**
A view call against a contract deployed with `Depends` pointing at genvm
v0.2.16 returns:

```
ValueError: call to private method `<function Contract.__handle_undefined_method__ ...>`
```

wrapped in a `genvm execution error` with no message at the CLI surface. The
same call against the same contract with 0.39.2 returns the record. Anyone
checking a published contract address with a current install will conclude the
claim is false; it is the toolchain. Pin `genlayer@0.39.2` for reads until the
0.40 line resolves v0.2.x method tables.

## Proficiency testing

The attestation contract establishes that a document is the one Certisyn
published. Whether the determination inside it is correct is a separate
question, and `pt/` answers it with a proficiency test in the ISO/IEC 17043
sense, run against the production orbital register.

```
16 Sep 2026   run 001     n=60    sensitivity 0.9333   specificity 0.2222
                          register applied an inertial invariant to an
                          EARTH_FIXED reference record
16 Sep 2026   run 003     n=60    sensitivity 1.0000   specificity 1.0000
                          frame declared at the type boundary and converted
                          before any energy conclusion is drawn
16 Sep 2026   series v2   n=480   sensitivity 0.9917 [0.9543, 0.9985]
              8 replicates        specificity 1.0000 [0.9894, 1.0000]
                          dual beacon, drand quicknet and NIST Beacon 2.0,
                          both committed unpublished at each registration
```

Run 002 is recorded and withheld from publication. It carried the frame fix and
was signed in the canonical form superseded below; a checkpoint whose signature
does not cover its own score does not meet the publication bar. Every run is
recorded; the ones that clear the bar are published.

**The second beacon.** A single beacon operator is a single point of trust, so
the series consumes two that fail differently: drand quicknet, a threshold BLS
network with many operators and a 3 s period that answers `425 Too Early` on an
unpublished round; and NIST Randomness Beacon 2.0, one US federal instrument on
its own hardware with a 60 s period that answers `404` on an unpublished pulse.
The seed is `sha256(drand_randomness || nist_output || case_list_root)`, and the
case list is committed before either beacon is named. Steering the selection
takes both operators at the same time.

**The detection floor, measured.** 480 case judgements across 8 replicates, 120
seeded, 119 detected, 1 missed, 0 false flags in 360 clean orbits. The interval
is Wilson rather than the normal approximation: at a proportion of 1.0 the
normal approximation returns [1, 1], which would state a 100 percent detection
floor from a finite sample. The published claim is a floor of 95.4 percent.

**Scheme v3, and what it replaced.** Every figure above is a rate at ONE fault
magnitude, 120 km, chosen by the scheme. That is the denominator problem: the
party being measured picks what it is measured on, and the textbook remedy is an
external seeder that no second organisation was available to supply.

v3 removes the choice instead of outsourcing it. Four fault families, twelve
rungs each, plus a clean variant, across 60 cases - 2,940 evaluations, every
point in the registered space, all judged before either beacon published.
Exhaustiveness is the independence proof: a catalogue with every point in it has
no free parameter left to tune, and a verifier recomputes the expected point set
from the registration alone and requires an exact match. The beacons then draw
the realised trial, so the headline is not chosen either.

```
17 Sep 2026   catalogue v3   2,940 evaluations, 60 cases, 4 families x 12 rungs

  position_step    floor 30 km     highest level still missed 10 km
  position_drift   floor 30 km     highest level still missed 10 km
  velocity_step    floor 30 m/s    highest level still missed 10 m/s
  time_skew        floor 10 s      highest level still missed 5 s

  clean 60, false flags 0, specificity 1.0000 [0.9398, 1.0000]
  FLOOR TEST PASS - 4 of 4 families contain rungs the register misses
```

**The floor test.** A ladder whose lowest rung is still detected was chosen to
flatter. Every ladder must therefore contain rungs the register fails, and the
verifier fails the document if any ladder does not. It is the check that costs
something to pass.

**What the numbers say.** This register refutes an orbital track inconsistent by
30 km or more, and does not see 300 m. `time_skew` is a step function at the
sampling interval - nothing below 10 s, everything at and above it - because
there is no state between two samples to contradict a stamp that moved less than
the cadence. Drift is harder than a step at every rung. All three are
specifications a relying party can design against, which a single pass rate is
not.

**The signing defect, and why the verifier exists.** Run 001's checkpoint was
signed over `JSON.stringify(checkpoint, Object.keys(checkpoint).sort())`. That
reads as a canonicaliser and is not one: the array replacer filters keys at
every depth, so the nested `score` object serialised as `{}` and fell outside
the signature entirely. Two checkpoints carrying entirely different scores
produce byte-identical signing bodies, and the published sensitivity could have
been edited with the signature still verifying.

It was found by writing `pt/verify.mjs` - specifically by writing a check that
asserts tampering *fails*, rather than one that asserts the honest document
passes. A verifier that only tests the happy path would have reported PASS on a
signature covering nothing.

The signing form is now `canon()`: keys sorted at every depth, no whitespace,
declared in the document as `canon_alg` so a verifier does not have to guess.
Cross-checked byte for byte against the Python form the contract uses.

**The frame defect.** Specific orbital energy is an inertial invariant.
AUX_POEORB publishes EARTH_FIXED state vectors. The register applied the
invariant directly to them: measured spread 23,681 J/kg against a 5,000 J/kg
LEO budget, falling to 8,494 J/kg once the rotation term was restored. That
flagged 35 of 45 clean orbits. The frame is now declared at the type boundary,
converted before any energy conclusion is drawn, and held by a regression test
that builds a known-good inclined orbit in both frames and requires the same
conclusion from each. The inclination is load bearing - for an equatorial orbit
the frame error cancels exactly and the test would pass while the defect stood.

Both defects were found by the instrument, on the production code path, and are
published with the run that found them rather than after a clean one.
