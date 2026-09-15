# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

from dataclasses import dataclass

import hashlib
import json
import typing

# CertisynAttestation - Certisyn, Inc. - MIT
# Full annotated source: https://github.com/certisyn/genlayer-attestation


OUTCOME_ATTESTED = "attested"
OUTCOME_MISMATCH = "digest_mismatch"
OUTCOME_UNAVAILABLE = "refused_unavailable"
OUTCOME_UNPARSEABLE = "refused_unparseable"

EMPTY_DIGEST = ""


@allow_storage
@dataclass
class Attestation:
    endpoint: str
    outcome: str
    canonical_digest: str
    raw_digest: str
    expected_digest: str
    doc_bytes: u256
    http_status: u256
    relying_party: str
    transaction_ref: str
    attestor: Address


class CertisynAttestation(gl.Contract):
    endpoint: str
    record_count: u256
    latest_id: str
    records: TreeMap[str, Attestation]
    record_ids: DynArray[str]

    def __init__(self, endpoint: str):
        self.endpoint = endpoint
        self.record_count = u256(0)
        self.latest_id = ""


    def _observe(self) -> dict[str, typing.Any]:
        endpoint = str(self.endpoint)

        def observe() -> dict[str, typing.Any]:
            response = gl.nondet.web.get(
                endpoint,
                headers={"Accept": "application/json"},
            )
            status = int(response.status)
            body = response.body

            if status != 200 or body is None:
                return {
                    "outcome": OUTCOME_UNAVAILABLE,
                    "status": status,
                    "size": 0,
                    "raw_digest": EMPTY_DIGEST,
                    "canonical_digest": EMPTY_DIGEST,
                }

            raw_digest = hashlib.sha256(body).hexdigest()

            try:
                document = json.loads(body.decode("utf-8"))
            except Exception:
                return {
                    "outcome": OUTCOME_UNPARSEABLE,
                    "status": status,
                    "size": len(body),
                    "raw_digest": raw_digest,
                    "canonical_digest": EMPTY_DIGEST,
                }

            canonical = json.dumps(
                document,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
                allow_nan=False,
            )
            canonical_digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

            return {
                "outcome": OUTCOME_ATTESTED,
                "status": status,
                "size": len(body),
                "raw_digest": raw_digest,
                "canonical_digest": canonical_digest,
            }

        return gl.eq_principle.strict_eq(observe)


    @gl.public.write
    def attest(
        self,
        expected_digest: str,
        relying_party: str,
        transaction_ref: str,
    ) -> str:
        expected = expected_digest.strip().lower()
        observed = self._observe()

        outcome = str(observed["outcome"])
        canonical_digest = str(observed["canonical_digest"])
        raw_digest = str(observed["raw_digest"])
        status = int(observed["status"])
        size = int(observed["size"])

        if outcome == OUTCOME_ATTESTED and expected != "":
            if expected != canonical_digest:
                outcome = OUTCOME_MISMATCH

        next_index = int(self.record_count) + 1
        record_id = "cs-" + str(next_index)

        self.records[record_id] = Attestation(
            endpoint=str(self.endpoint),
            outcome=outcome,
            canonical_digest=canonical_digest,
            raw_digest=raw_digest,
            expected_digest=expected,
            doc_bytes=u256(size),
            http_status=u256(status),
            relying_party=relying_party,
            transaction_ref=transaction_ref,
            attestor=gl.message.sender_address,
        )
        self.record_ids.append(record_id)
        self.record_count = u256(next_index)
        self.latest_id = record_id

        return record_id


    @gl.public.view
    def get_endpoint(self) -> str:
        return str(self.endpoint)

    @gl.public.view
    def get_record_count(self) -> int:
        return int(self.record_count)

    @gl.public.view
    def get_latest_id(self) -> str:
        return str(self.latest_id)

    @gl.public.view
    def get_record(self, record_id: str) -> str:
        record = self.records.get(record_id)
        if record is None:
            return json.dumps({"found": False, "record_id": record_id}, sort_keys=True)
        return json.dumps(
            {
                "found": True,
                "record_id": record_id,
                "endpoint": str(record.endpoint),
                "outcome": str(record.outcome),
                "canonical_digest": str(record.canonical_digest),
                "raw_digest": str(record.raw_digest),
                "expected_digest": str(record.expected_digest),
                "doc_bytes": int(record.doc_bytes),
                "http_status": int(record.http_status),
                "relying_party": str(record.relying_party),
                "transaction_ref": str(record.transaction_ref),
                "attestor": record.attestor.as_hex,
            },
            sort_keys=True,
        )

    @gl.public.view
    def get_latest(self) -> str:
        return self.get_record(str(self.latest_id))

    @gl.public.view
    def list_record_ids(self) -> str:
        return json.dumps([str(x) for x in self.record_ids], sort_keys=True)
