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

## Three traps, for anyone else deploying to Asimov

Reproducing this took several hours, almost none of it spent on the contract.

**1. A second comment line under the `Depends` header breaks the runner.**
This file's first line is the `Depends` header and its second line is blank. Put
any other `#` line directly beneath the header and GenVM fails with:

```
target: genvm::runners::parse
error: { causes: [ 'trailing characters at line 1 column 84' ] }
```

Column 84 is the character after the 83-character header. The parse consumes
more than the first line. The transaction still reports `status: ACCEPTED` and
still returns a contract address, but with
`txExecutionResultName: FINISHED_WITH_ERROR`, and the contract does not exist.
A module docstring in that position fails the same way.

**2. CLI 0.39.2 sends the bare gas estimate with no headroom.**
An inner call in the ghost-factory deploy path runs out of gas, returns empty
revert data, and OpenZeppelin's `Address` library converts that into
`FailedCall()` - selector `0xd6bda275`. Every deploy reverts with EVM
`status 0x0`. When gas estimation fails on the RPC the CLI falls back to a flat
200,000, which is far below the roughly 1.38M a deploy needs.

Release candidate 0.40.0-rc.3 adds the headroom, but ships genlayer-js v2, whose
`addTransaction` calldata Asimov's consensus contract does not accept - its gas
estimation reverts every time and it never broadcasts at all.

What worked: 0.39.2, with `gas: estimatedGas` changed to `gas: estimatedGas * 2n`
in the bundled `genlayer-js`. Unused gas is refunded, so headroom costs nothing.
3x overshoots the block limit on a 7KB contract and is rejected with
`gas limit too high`.

**3. `--fee-value` is silently discarded on 0.39.2.**
The CLI parses it into a fees object and hands it to genlayer-js 1.1.8, which has
no fee support at all. The transaction goes out with `value = 0x0` regardless.
That is harmless on Asimov, which uses the v6 non-fee `addTransaction` ABI, but
it sends you hunting for a fee problem that is not there. Do not pass it.

Separately, the Asimov RPC does not implement `net_version`. MetaMask's manual
"Add a network" flow calls it, gets `method not found`, and reports
"Could not fetch chain ID" - misleading, since `eth_chainId` returns `0x107d`
correctly. The faucet's one-click add works; only the manual path breaks.
