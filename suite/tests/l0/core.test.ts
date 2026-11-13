import { describe, expect, it } from "vitest";
import {
  aggregateCoverage,
  canonicalPacketHash,
  canonicalStringify,
  sha256,
  unifiedDiff,
  validateFinding,
  validatePacket,
  validateProposal
} from "../../cli/src/lib.ts";

function packet(observedAt: string, extra: Record<string, unknown> = {}) {
  const base = {
    schema_version: 1,
    kind: "filesystem.snapshot",
    scope: "/srv/scenario",
    coverage: "complete-within-scope",
    observed_at: observedAt,
    collector: { name: "filesystem", version: "1.0.0" },
    facts: [{ path: "/srv/scenario/a.txt", sha256: sha256("a"), size: 1, mode: 0o644 }],
    ...extra
  };
  return { ...base, canonical_hash: canonicalPacketHash(base) };
}

describe("L0 — canonical hashing", () => {
  it("ignores observation time and object key insertion order", () => {
    const first = packet("2026-11-13T00:00:00.000Z");
    const second = packet("2026-11-13T00:01:00.000Z", {
      facts: [{ mode: 0o644, size: 1, sha256: sha256("a"), path: "/srv/scenario/a.txt" }]
    });
    expect(first.canonical_hash).toBe(second.canonical_hash);
    expect(canonicalStringify({ z: 1, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":1}');
    expect(validatePacket(first)).toBeUndefined();
  });

  it("changes the hash when observed facts change", () => {
    const first = packet("2026-11-13T00:00:00.000Z");
    const second = packet("2026-11-13T00:00:00.000Z", {
      facts: [{ path: "/srv/scenario/a.txt", sha256: sha256("changed"), size: 7, mode: 0o644 }]
    });
    expect(first.canonical_hash).not.toBe(second.canonical_hash);
  });
});

describe("L0 — coverage arithmetic", () => {
  it("does not report full coverage when a component is incomplete", () => {
    expect(aggregateCoverage([])).toBe("unknown");
    expect(aggregateCoverage(["complete-within-scope", "complete-within-scope"])).toBe("complete-within-scope");
    expect(aggregateCoverage(["complete-within-scope", "partial"])).toBe("partial");
    expect(aggregateCoverage(["unsupported"])).toBe("unsupported");
    expect(aggregateCoverage(["unsupported", "complete-within-scope"])).toBe("partial");
    expect(aggregateCoverage(["stale", "complete-within-scope"])).toBe("stale");
    expect(aggregateCoverage(["unknown", "complete-within-scope"])).toBe("unknown");
  });
});

describe("L0 — deterministic diffing", () => {
  it("emits a reproducible patch for changed lines", () => {
    expect(unifiedDiff("old\n", "new\n", "config.txt")).toBe(
      "--- a/config.txt\n+++ b/config.txt\n@@ -1,1 +1,1 @@\n-old\n+new"
    );
    expect(unifiedDiff("same", "same", "same.txt")).toContain("@@ -1,1 +1,1 @@");
  });
});

describe("L0 — fact schema guards", () => {
  it("accepts evidenced findings and complete proposal shapes", () => {
    expect(validateFinding({
      id: "f-1", fault_id: "disk-space", kind: "threshold", description: "Declared fault",
      evidence: { packet_hash: "a".repeat(64) }, coverage: "complete-within-scope",
      provenance: { observed_at: "2026-11-13T12:00:00.000Z", collector: { name: "filesystem", version: "1.0.0" }, canonical_hash: "a".repeat(64) }
    })).toBeUndefined();
    expect(validateProposal({
      id: "p-1", diff: { operation: "manual" }, cost_estimate: { value: 0 },
      revert: { operation: "not-applicable" }, expires_at: "2026-11-14T00:00:00.000Z", argument_hash: "b".repeat(64)
    })).toBeUndefined();
  });
});
