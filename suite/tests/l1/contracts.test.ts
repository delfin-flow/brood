import { describe, expect, it } from "vitest";
import {
  validateFinding,
  validateManifest,
  validatePacket,
  validateProposal,
  validateReceipt,
  parseScenarioFaults,
  canonicalPacketHash,
  sha256
} from "../../cli/src/lib.ts";

const goodPacketBase = {
  schema_version: 1,
  kind: "filesystem.snapshot",
  scope: "/srv/scenario",
  coverage: "complete-within-scope",
  observed_at: "2026-11-13T12:00:00.000Z",
  collector: { name: "filesystem", version: "1.0.0" },
  facts: [{ path: "/srv/scenario/a", sha256: sha256("a"), size: 1, mode: 0o644 }]
};
const goodPacket = { ...goodPacketBase, canonical_hash: canonicalPacketHash(goodPacketBase) };
const goodManifest = {
  schema_version: 1,
  owners: ["platform", "security"],
  fallback: "manual-review",
  packet_kinds: ["filesystem.snapshot"],
  collectors: [{ name: "filesystem", version: "1.0.0", kind: "filesystem.snapshot" }]
};
const goodFinding = {
  id: "f-1", fault_id: "declared-one", kind: "file-state", description: "Declared fault",
  evidence: { path: "/srv/scenario/a" }, coverage: "complete-within-scope",
  provenance: { observed_at: "2026-11-13T12:00:00.000Z", collector: { name: "filesystem", version: "1.0.0" }, canonical_hash: "a".repeat(64) }
};
const goodProposal = {
  id: "p-1", diff: { operation: "manual" }, cost_estimate: { unit: "operations", value: 0 },
  revert: { operation: "not-applicable" }, expires_at: "2026-11-14T00:00:00.000Z", argument_hash: "c".repeat(64)
};
const goodReceipt = { id: "r-1", proposal_id: "p-1", path: "/tmp/root/file", after_sha256: "d".repeat(64) };

describe("L1 — packet contract", () => {
  it("accepts a canonical packet", () => expect(validatePacket(goodPacket)).toBeUndefined());
  it("rejects undeclared packet kinds and malformed hashes", () => {
    expect(() => validatePacket({ ...goodPacket, kind: "invented.packet" })).toThrow(/undeclared/);
    expect(() => validatePacket({ ...goodPacket, canonical_hash: "not-a-hash" })).toThrow(/SHA-256/);
  });
});

describe("L1 — manifest contract", () => {
  it("accepts declared collectors, owners and fallback", () => expect(validateManifest(goodManifest)).toBeUndefined());
  it("rejects duplicate owners", () => expect(() => validateManifest({ ...goodManifest, owners: ["ops", "ops"] })).toThrow(/duplicate owners/));
  it("rejects a missing fallback", () => {
    const { fallback: _fallback, ...withoutFallback } = goodManifest;
    expect(() => validateManifest(withoutFallback)).toThrow(/fallback/);
  });
  it("rejects a collector whose packet kind is not declared", () => {
    expect(() => validateManifest({ ...goodManifest, collectors: [{ name: "x", version: "1", kind: "not-declared" }] })).toThrow(/undeclared packet kind/);
  });
});

describe("L1 — finding contract", () => {
  it("accepts either path or packet-hash evidence", () => {
    expect(validateFinding(goodFinding)).toBeUndefined();
    expect(validateFinding({ ...goodFinding, evidence: { packet_hash: "e".repeat(64) } })).toBeUndefined();
  });
  it("rejects evidence-free and untraceable findings", () => {
    expect(() => validateFinding({ ...goodFinding, evidence: {} })).toThrow(/path or packet_hash/);
    expect(() => validateFinding({ ...goodFinding, coverage: "healthy" })).toThrow(/coverage/);
  });
});

describe("L1 — scenario declaration contract", () => {
  it("accepts an explicit empty list and preserves declared fault identity", () => {
    expect(parseScenarioFaults("faults: []\n")).toEqual([]);
    expect(parseScenarioFaults("faults:\n  - id: missing-service\n    kind: service\n    description: Service is absent\n")[0]?.id).toBe("missing-service");
  });
  it("rejects an absent or malformed fault declaration instead of returning an empty success", () => {
    expect(() => parseScenarioFaults("name: scenario-without-declarations\n")).toThrow(/explicitly declare/);
    expect(() => parseScenarioFaults("faults: not-a-list\n")).toThrow(/must be an array/);
  });
});

describe("L1 — proposal and receipt contracts", () => {
  it("accepts complete proposal and receipt objects", () => {
    expect(validateProposal(goodProposal)).toBeUndefined();
    expect(validateReceipt(goodReceipt)).toBeUndefined();
  });
  it("rejects a proposal without revert path or expiry", () => {
    expect(() => validateProposal({ ...goodProposal, revert: undefined })).toThrow(/revert/);
    expect(() => validateProposal({ ...goodProposal, expires_at: "tomorrow" })).toThrow(/expires_at/);
  });
  it("rejects malformed receipt hashes", () => {
    expect(() => validateReceipt({ ...goodReceipt, after_sha256: "broken" })).toThrow(/SHA-256/);
  });
});
