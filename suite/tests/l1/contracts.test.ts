import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  validateFinding,
  validateManifest,
  validatePacket,
  validateProposal,
  validateReceipt,
  parseScenarioFaults,
  parseScenarioHeader,
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
  const declaredFault = [
    "faults:",
    "  - id: service.unit_invalid",
    "    expect_as: service.unit_invalid",
    "    discoverable_by:",
    "      - systemd-analyze verify etc/systemd/system/ledger-reconcile.service",
    "    evidence: etc/systemd/system/ledger-reconcile.service",
    "    note: oneshot with Restart=always is invalid",
    ""
  ].join("\n");

  it("accepts an explicit empty list and reads the declared fields", () => {
    expect(parseScenarioFaults("faults: []\n")).toEqual([]);
    const [fault] = parseScenarioFaults(declaredFault);
    expect(fault).toMatchObject({
      id: "service.unit_invalid",
      expectAs: "service.unit_invalid",
      evidence: "etc/systemd/system/ledger-reconcile.service",
      discoverableBy: ["systemd-analyze verify etc/systemd/system/ledger-reconcile.service"],
      note: "oneshot with Restart=always is invalid"
    });
  });

  it("rejects an absent or malformed fault declaration instead of returning an empty success", () => {
    expect(() => parseScenarioFaults("name: scenario-without-declarations\n")).toThrow(/explicitly declare/);
    expect(() => parseScenarioFaults("faults: not-a-list\n")).toThrow(/must be an array/);
    expect(() => parseScenarioFaults("planted_faults: []\n")).toThrow(/explicitly declare/);
  });

  it("fails loudly on a wrong field name instead of silently discarding it", () => {
    const misspelled = declaredFault.replace("expect_as:", "expect:");
    expect(() => parseScenarioFaults(misspelled)).toThrow(/undeclared field\(s\): expect;/);
    const alias = declaredFault.replace("expect_as:", "kind:");
    expect(() => parseScenarioFaults(alias)).toThrow(/undeclared field\(s\): kind;/);
  });

  it("requires every declared field the detector contract depends on", () => {
    const withoutEvidence = declaredFault.replace("    evidence: etc/systemd/system/ledger-reconcile.service\n", "");
    expect(() => parseScenarioFaults(withoutEvidence)).toThrow(/evidence/);
    const withoutDiscoverable = declaredFault.replace(/    discoverable_by:\n      - .*\n/, "");
    expect(() => parseScenarioFaults(withoutDiscoverable)).toThrow(/discoverable_by/);
    const withoutId = declaredFault.replace("  - id: service.unit_invalid\n", "  - id: ''\n");
    expect(() => parseScenarioFaults(withoutId)).toThrow(/faults\[0\]\.id/);
    const emptyDiscoverable = declaredFault.replace(/      - .*\n/, "");
    expect(() => parseScenarioFaults(emptyDiscoverable)).toThrow(/non-empty array/);
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

/**
 * A scenario that `extends:` a parent keeps the inherited faults in the parent's manifest.
 * The CLI must never report the observed subset as the whole declared set: when the parent
 * manifest is not among the observed facts, `assess` says so instead of staying silent.
 */
function scenarioYaml(name: string, parent: string | null, faults: Array<{ id: string; expect_as: string; evidence?: string }>): string {
  const lines = [`name: ${name}`];
  if (parent !== null) lines.push(`extends: ${parent}`);
  if (faults.length === 0) {
    lines.push("faults: []");
    return `${lines.join("\n")}\n`;
  }
  lines.push("faults:");
  for (const fault of faults) {
    lines.push(`  - id: ${fault.id}`, `    expect_as: ${fault.expect_as}`, "    discoverable_by:", `      - cat ${fault.evidence ?? "evidence.txt"}`, `    evidence: ${fault.evidence ?? "evidence.txt"}`);
  }
  return `${lines.join("\n")}\n`;
}

function manifestPacket(scenarioRoot: string, content: string): Record<string, unknown> {
  const base = {
    schema_version: 1,
    kind: "filesystem.snapshot",
    scope: "/srv/scenario",
    coverage: "complete-within-scope",
    observed_at: "2026-11-13T12:00:00.000Z",
    collector: { name: "filesystem", version: "1.0.0" },
    facts: [{
      kind: "filesystem.file",
      path: `${scenarioRoot}/scenario.yaml`,
      sha256: sha256(content),
      size: Buffer.byteLength(content),
      mode: 0o644,
      content
    }]
  };
  return { ...base, canonical_hash: canonicalPacketHash(base) };
}

function assessWithCli(packets: unknown[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["cli/src/index.ts", "assess"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: { ...process.env, BROOD_PROVIDER: "fake" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`assess exited ${code}: ${Buffer.concat(err).toString()}${Buffer.concat(out).toString()}`));
        return;
      }
      resolve(JSON.parse(Buffer.concat(out).toString("utf8")) as Record<string, any>);
    });
    child.stdin?.end(JSON.stringify(packets));
  });
}

describe("L1 — declared-chain honesty", () => {
  it("names an inheritance it cannot verify when the parent manifest is out of scope", async () => {
    const child = scenarioYaml("child", "parent", [
      { id: "a", expect_as: "kind.a" },
      { id: "b", expect_as: "kind.b" }
    ]);
    const result = await assessWithCli([manifestPacket("/srv/scenario/child", child)]);
    expect(result.declarations).toMatchObject({
      source: "observed manifests",
      resolved: false,
      extends: "parent",
      unverified_inheritance: "parent",
      declared_count: 2,
      unverified_count: null
    });
    expect(result.declarations.reason).toMatch(/parent scenario manifest 'parent' is not in the observed scope/);
    expect(result.undetected).toHaveLength(2);
  });

  it("resolves the whole chain when every parent manifest is in scope", async () => {
    const child = scenarioYaml("child", "parent", [{ id: "a", expect_as: "kind.a" }]);
    const parent = scenarioYaml("parent", "grandparent", [{ id: "b", expect_as: "kind.b" }]);
    const grandparent = scenarioYaml("grandparent", null, [{ id: "c", expect_as: "kind.c" }]);
    const result = await assessWithCli([
      manifestPacket("/srv/scenario/child", child),
      manifestPacket("/srv/scenario/parent", parent),
      manifestPacket("/srv/scenario/grandparent", grandparent)
    ]);
    expect(result.declarations).toMatchObject({
      resolved: true,
      extends: "parent",
      declared_count: 3,
      unverified_inheritance: null,
      unverified_count: 0
    });
    expect(result.declarations).not.toHaveProperty("reason");
    // An inherited fault is named even when no detector exists for it.
    expect(result.undetected.map((entry: any) => entry.fault_id).sort()).toEqual(["a", "b", "c"]);
    for (const entry of result.undetected) expect(entry.reason).toContain("no detector for kind");
  });

  it("claims nothing when the scenario inherits nothing", async () => {
    for (const content of [scenarioYaml("solo", null, [{ id: "a", expect_as: "kind.a" }]), "name: solo\nfaults: []\n"]) {
      const result = await assessWithCli([manifestPacket("/srv/scenario/solo", content)]);
      expect(result.declarations).toMatchObject({
        resolved: true,
        extends: null,
        unverified_inheritance: null,
        unverified_count: 0
      });
      expect(result.declarations.reason).toBeUndefined();
    }
    const empty = await assessWithCli([manifestPacket("/srv/scenario/solo", scenarioYaml("solo", null, []))]);
    expect(empty.declarations.declared_count).toBe(0);
  });

  it("reads `extends` and `name` from the manifest header, rejecting a non-string parent", () => {
    expect(parseScenarioHeader("name: child\nextends: parent\nfaults: []\n")).toEqual({ name: "child", extends: "parent" });
    expect(parseScenarioHeader("name: solo\nextends: null\nfaults: []\n")).toEqual({ name: "solo", extends: null });
    expect(parseScenarioHeader("faults: []\n")).toEqual({ name: null, extends: null });
    expect(() => parseScenarioHeader("extends: [a]\nfaults: []\n")).toThrow(/extends/);
  });
});

