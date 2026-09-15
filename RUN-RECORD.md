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
