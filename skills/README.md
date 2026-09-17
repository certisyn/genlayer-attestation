# Certisyn agent skills

Published here so they can be fetched, pinned and vendored from a stable public source.

| Skill | Path | Entry | Licence |
|---|---|---|---|
| `certisyn-independent-verification` | `skills/certisyn-independent-verification/` | `SKILL.md` | `LicenseRef-Certisyn-Skill-1.0` - the file is MIT; the coverage-document and floor-test formats are granted royalty-free; names, marks and the engines are reserved. The terms are in the skill's own Notice section. |

## What the skill is for

Independent, pre-transaction verification of what a counterparty asserts about itself, before an
agent commits funds, signs, delegates authority, or admits that counterparty to a deal. It
returns one of four outcomes, always names what it could not determine, and states the conditions
under which its own evidence should be ruled out.

It complements an adjudication layer rather than competing with one. Adjudication decides a
dispute between parties; this establishes, beforehand, whether a claim one of them relies on was
ever checked by anyone with no interest in the answer.

## Vendoring it

Fetch from this repository at `skills/certisyn-independent-verification/SKILL.md` and pin the
commit. The skill's claims are checkable from public sources rather than taken on trust:

```bash
node pt/verify.mjs          # 24 checks, no install, seconds
node pt/negative-test.mjs   # 26 corruptions, every one must be refused
```

The coverage endpoint the skill describes is unauthenticated and needs no account:

```bash
curl -s https://certisyn.com/api/v1/verification/capability
```
