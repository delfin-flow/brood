import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  REMOTE_SCENARIO_ROOT,
  cli,
  declaredExpectedCoverage,
  declaredFaultChain,
  declaredFaults,
  remote,
  remoteJson,
  requestedScenario,
  requireEnvironment,
  scenarioSnapshotAfter,
  scenarioSnapshotBefore,
  spawnRemote,
  startBroodEnvironment,
  stopBroodEnvironment,
  withRemoteEnv
} from "../support/remote.ts";

interface Packet {
  kind: string;
  coverage: string;
  canonical_hash: string;
  observed_at: string;
  facts: Array<Record<string, unknown>>;
  errors: string[];
  skipped: string[];
  problems: string[];
}
interface Finding {
  id: string;
  fault_id: string;
  kind: string;
  description?: string;
  source: string;
  evidence: { path?: string; sha256?: string; packet_hash?: string };
  measured?: { mount?: string; use_percent?: number; threshold?: number };
  coverage: string;
}

interface Undetected {
  fault_id: string;
  expect_as: string;
  evidence: string;
  reason: string;
}

interface Assessment {
  status: string;
  coverage: string;
  findings: Finding[];
  undetected: Undetected[];
}

/**
 * The harness mounts exactly one materialised scenario at `/srv/scenario`, so every scope
 * in this file is the mount root. Which scenario is mounted comes from `BROOD_SCENARIO`
 * (default `dirty-business`) — the per-scenario expectations below are read from that
 * scenario's own manifest, never assumed.
 */
const scope = REMOTE_SCENARIO_ROOT;
const scenarioName = requestedScenario();

let expectedCoverage = "";
let declared: Awaited<ReturnType<typeof declaredFaults>> = [];
let declaredChain: Awaited<ReturnType<typeof declaredFaultChain>> = [];
let declaredKinds = new Set<string>();
let packets: Packet[] = [];
let assessment: Assessment;
let findings: Finding[] = [];

beforeAll(async () => {
  await startBroodEnvironment();
  expectedCoverage = await declaredExpectedCoverage();
  declared = await declaredFaults();
  declaredChain = await declaredFaultChain();
  declaredKinds = new Set(declaredChain.map((fault) => fault.expectAs));
  packets = await remoteJson<Packet[]>(cli(`observe --scope '${scope}'`));
  assessment = await remoteJson<Assessment>(
    withRemoteEnv({ BROOD_PROVIDER: "fake" }, cli("assess")), packets
  );
  findings = assessment.findings;
}, 180_000);

afterAll(async () => {
  await stopBroodEnvironment();
}, 180_000);

describe("L2 — SSH command integration", () => {
  it("executes observe, assess, propose, apply, verify and report over SSH", async () => {
    expect(packets.length).toBeGreaterThan(0);
    expect(packets.every((packet) => typeof packet.canonical_hash === "string" && packet.canonical_hash.length === 64)).toBe(true);
    const providerFreeObservation = await remoteJson<Packet[]>(
      withRemoteEnv({ BROOD_PROVIDER: "provider-must-not-be-called" }, cli(`observe --scope '${scope}'`))
    );
    expect(providerFreeObservation.map((packet) => packet.canonical_hash).sort()).toEqual(packets.map((packet) => packet.canonical_hash).sort());

    const reassessment = await remoteJson<{ status: string; coverage: string; findings: Finding[]; undetected: Undetected[] }>(
      withRemoteEnv({ BROOD_PROVIDER: "fake" }, cli("assess")), packets
    );
    // The scenario declares its own coverage. `assess` reports the aggregate packet
    // coverage, so a degraded filesystem scan must read as partial — asserting "ok" there
    // would be asserting that the scan lies.
    const degradedScan = packets.some((packet) => packet.coverage !== "complete-within-scope");
    expect(reassessment.status).toBe(degradedScan ? "partial" : "ok");
    if (degradedScan) {
      expect(packets.some((packet) => packet.coverage === "partial")).toBe(true);
    } else if (expectedCoverage === "complete-within-scope") {
      expect(reassessment.coverage).toBe("complete-within-scope");
      expect(packets.flatMap((packet) => packet.errors)).toEqual([]);
    } else {
      // `partial-by-design` without a degraded scan: the declared gap is a collector
      // contract (e.g. `partial` — the packages tool is missing), not a filesystem
      // failure. It must still be named rather than read as a clean machine.
      expect(reassessment.undetected.length).toBeGreaterThan(0);
    }
    expect(reassessment.findings.every((finding) => finding.evidence && finding.coverage)).toBe(true);

    // S1 — a planted broken symlink is a fact, not a scan failure.
    if (declaredKinds.has("filesystem.broken_symlink")) {
      const symlinkFacts = packets.flatMap((packet) => packet.facts).filter((fact) => fact.kind === "filesystem.symlink");
      expect(symlinkFacts.length).toBeGreaterThan(0);
      expect(symlinkFacts.some((fact) => fact.target_exists === false)).toBe(true);
    }

    // S1 — no scan is ever labelled incomplete without saying why.
    for (const packet of packets) {
      if (packet.coverage === "complete-within-scope") continue;
      expect(packet.errors.length + packet.skipped.length + packet.problems.length).toBeGreaterThan(0);
    }

    const proposals = await remoteJson<{ status: string; proposals: Array<Record<string, unknown>> }>(
      withRemoteEnv({ BROOD_PROVIDER: "fake" }, cli("propose")), reassessment.findings
    );
    expect(proposals.status).toBe("ok");
    expect(proposals.proposals.every((proposal) =>
      Boolean(proposal.id) && Boolean(proposal.diff) && Boolean(proposal.cost_estimate) && Boolean(proposal.revert) && Boolean(proposal.expires_at)
    )).toBe(true);

    const applied = await runApprovedChange("L2-applied\n");
    expect(applied.verified.status).toBe("verified");
    expect(applied.reverted.status).toBe("reverted");

    const report = await remoteJson<{ status: string; markdown: string; json: Record<string, unknown> }>(
      withRemoteEnv({ BROOD_PROVIDER: "provider-must-not-be-called" }, cli("report")),
      { packets, findings: reassessment.findings }
    );
    expect(report.status).toBe("ok");
    expect(report.markdown).toContain("# Brood observation report");
    expect(report.json).toHaveProperty("coverage");
  });
});

describe("L3 — detection from observed facts", () => {
  it("cites an observed packet fact for every finding, never the scenario manifest", () => {
    const observed = new Map<string, { fact: Record<string, unknown>; packetHash: string }>();
    for (const packet of packets) {
      for (const fact of packet.facts) observed.set(String(fact.path), { fact, packetHash: packet.canonical_hash });
    }
    expect(findings.every((finding) => finding.kind === "storage.headroom_low")).toBe(true);
    for (const finding of findings) {
      const evidencePath = String(finding.evidence.path ?? "");
      expect(evidencePath.length).toBeGreaterThan(0);
      // The echo pointed at scenario.yaml; a real detection points at the measured fact.
      expect(evidencePath.endsWith("/scenario.yaml")).toBe(false);
      const fact = observed.get(evidencePath);
      expect(fact, `finding ${finding.id} cites a path that is not in the input packets`).toBeDefined();
      expect(finding.evidence.sha256).toBe(fact!.fact.sha256);
      expect(finding.evidence.packet_hash).toBe(fact!.packetHash);
      expect(finding.kind).toBe("storage.headroom_low");
      expect(finding.fault_id).toBe("storage.near_full");
      expect(finding.measured).toMatchObject({ mount: "/srv/data", threshold: 80 });
      expect(Number(finding.measured?.use_percent)).toBeGreaterThanOrEqual(80);
      expect(finding.coverage).toBeDefined();
    }
    expect(findings.some((finding) => /healthy|all[- ]clear/i.test(finding.fault_id))).toBe(false);
    // A declared storage fault must produce a detection; without one silence is correct.
    if (declaredKinds.has("storage.headroom_low")) expect(findings.length).toBeGreaterThan(0);
    else expect(findings).toEqual([]);
  });

  it("detects storage headroom over the threshold and stays silent below it", async () => {
    const storage = storageFindings(assessment);
    // Evidence paths come from the declarations that apply to this scenario (its own
    // manifest plus the `extends:` chain), expressed against the mount root.
    const expectedEvidence = new Set(
      declaredChain
        .filter((fault) => fault.expectAs === "storage.headroom_low")
        .map((fault) => `${scope}/${fault.evidence}`)
    );
    if (expectedEvidence.size === 0) {
      expect(storage).toEqual([]);
    } else {
      expect(storage.length).toBeGreaterThan(0);
      for (const finding of storage) expect(expectedEvidence.has(String(finding.evidence.path))).toBe(true);
    }

    // An explicit 95 % threshold leaves the same capture under the line. Only a scenario
    // that declares the storage fault itself can assert the `undetected` entry: the CLI
    // cross-checks the manifest embedded in the packet, and an inherited declaration lives
    // in its parent's manifest (roadmap S5 records the seam).
    const declaredStorage = declared.filter((fault) => fault.expectAs === "storage.headroom_low");
    if (declaredStorage.length > 0) {
      const strict = await remoteJson<Assessment>(
        withRemoteEnv({ BROOD_PROVIDER: "fake", BROOD_STORAGE_THRESHOLD_PERCENT: "95" }, cli("assess")),
        packets
      );
      expect(storageFindings(strict)).toEqual([]);
      expect(strict.undetected).toContainEqual(expect.objectContaining({
        fault_id: "storage.near_full",
        expect_as: "storage.headroom_low",
        reason: "detector ran, threshold not crossed"
      }));
    }
  });

  it("reports every declared fault without a finding as undetected, with a reason", async () => {
    // Invent none: every detected kind is one the scenario tree declares.
    for (const finding of findings) expect(declaredKinds.has(finding.kind)).toBe(true);

    if (declared.length === 0) {
      expect(findings).toEqual([]);
      expect(assessment.undetected).toEqual([]);
      return;
    }
    expect(declared.length).toBeGreaterThan(findings.length);

    // Exactly one declaration is backed by a detection: the mounted scenario is one
    // machine, so one capture and one finding — the count is derived, not assumed.
    const detectedEvidence = new Set(findings.map((finding) => String(finding.evidence.path)));
    expect(assessment.undetected).toHaveLength(
      declared.filter((fault) => !detectedEvidence.has(`${scope}/${fault.evidence}`)).length
    );

    for (const entry of assessment.undetected) {
      expect(entry.fault_id.length).toBeGreaterThan(0);
      expect(entry.expect_as.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      // A detection that ran without crossing the line says so; anything else names the gap.
      if (entry.expect_as === "storage.headroom_low") expect(entry.reason).toBe("detector ran, threshold not crossed");
      else expect(entry.reason).toContain(`no detector for kind '${entry.expect_as}'`);
    }

    // No declaration is silently dropped: each is either detected or listed as undetected.
    for (const fault of declared) {
      const accounted = detectedEvidence.has(`${scope}/${fault.evidence}`)
        || assessment.undetected.some((entry) => entry.fault_id === fault.id);
      expect(accounted, `declared fault ${fault.id} is neither detected nor undetected`).toBe(true);
    }
  });

  it("does not emit healthy findings for an incomplete/unsupported scan", async () => {
    const unsupportedPackets = await remoteJson<Packet[]>(withRemoteEnv({ BROOD_DISABLE_COLLECTORS: "filesystem" }, cli(`observe --scope '${scope}'`)));
    const result = await remoteJson<Assessment>(
      withRemoteEnv({ BROOD_DISABLE_COLLECTORS: "filesystem", BROOD_PROVIDER: "fake" }, cli("assess")),
      unsupportedPackets
    );
    expect(result.status).toBe("unsupported");
    expect(result.coverage).toBe("unsupported");
    expect(result.findings).toEqual([]);
    // S1 — the removed collector still reports unsupported *with a reason*.
    expect(unsupportedPackets[0]?.coverage).toBe("unsupported");
    expect(unsupportedPackets[0]?.problems.length).toBeGreaterThan(0);
  });
});

describe("L4 — interruption, approval and recovery", () => {
  it("recovers from an interrupted observe, rejects expired/altered approvals, reverts, and reports a removed collector", async () => {
    const env = requireEnvironment();
    const marker = `${env.stateDir}/observe-paused.marker`;
    const paused = spawnRemote(withRemoteEnv({ BROOD_TEST_PAUSE_MARKER: marker }, cli(`observe --scope '${scope}'`)));
    const deadline = Date.now() + 20_000;
    let pidText = "";
    while (Date.now() < deadline) {
      const found = await remote(`test -s '${marker}' && cat '${marker}'`);
      if (found.code === 0 && found.stdout.trim()) { pidText = found.stdout.trim(); break; }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(pidText).toMatch(/^\d+$/);
    const killed = await remote(`kill -TERM ${Number(pidText)}`);
    expect(killed.code).toBe(0);
    const interrupted = await paused.result;
    expect(interrupted.code).not.toBe(0);
    const recovered = await remoteJson<Packet[]>(cli(`observe --scope '${scope}'`));
    expect(recovered.map((p) => p.canonical_hash).sort()).toEqual(packets.map((p) => p.canonical_hash).sort());
    const reassessed = await remoteJson<{ findings: Finding[] }>(
      withRemoteEnv({ BROOD_PROVIDER: "fake" }, cli("assess")), recovered
    );
    expect(reassessed.findings.map((finding) => finding.id).sort()).toEqual(findings.map((finding) => finding.id).sort());
    expect(new Set(reassessed.findings.map((finding) => finding.id)).size).toBe(reassessed.findings.length);

    const malformedScript = JSON.stringify({ assess: { mode: "malformed", value: { nope: true } } });
    const refusal = await remote(withRemoteEnv({ BROOD_PROVIDER: "fake", BROOD_FAKE_PROVIDER_SCRIPT: malformedScript }, cli("assess")), JSON.stringify(packets));
    expect(refusal.code).not.toBe(0);
    expect(JSON.parse(refusal.stdout).status).toBe("failed");

    const expired = await createProposal("expired-content\n", { BROOD_PROPOSAL_TTL_SECONDS: "-5" });
    const expiredApproval = await remoteJson<{ approval: string }>(cli(`approve --proposal '${expired.id}'`));
    const expiredApply = await remote(withRemoteEnv({}, cli(`apply --proposal '${expired.id}' --approval '${expiredApproval.approval}'`)));
    expect(expiredApply.code).not.toBe(0);
    expect(JSON.parse(expiredApply.stdout).status).toBe("denied");

    const altered = await createProposal("altered-content\n");
    const alteredApproval = await remoteJson<{ approval: string }>(cli(`approve --proposal '${altered.id}'`));
    const changedArgs = JSON.stringify({ operation: "manual", finding_id: "changed" });
    const alteredApply = await remote(withRemoteEnv({}, cli(
      `apply --proposal '${altered.id}' --approval '${alteredApproval.approval}' --arguments-json '${changedArgs}'`
    )));
    expect(alteredApply.code).not.toBe(0);
    expect(JSON.parse(alteredApply.stdout).status).toBe("denied");

    const valid = await createProposal("restored-after-recovery\n");
    const validApproval = await remoteJson<{ approval: string }>(cli(`approve --proposal '${valid.id}'`));
    const applied = await remoteJson<{ status: string; receipt: { id: string } }>(
      cli(`apply --proposal '${valid.id}' --approval '${validApproval.approval}'`)
    );
    expect(applied.status).toBe("applied");
    const verified = await remoteJson<{ status: string }>(
      withRemoteEnv({ BROOD_PROVIDER: "provider-must-not-be-called" }, cli(`verify --receipt '${applied.receipt.id}'`))
    );
    expect(verified.status).toBe("verified");
    const reverted = await remoteJson<{ status: string }>(cli(`revert --receipt '${applied.receipt.id}'`));
    expect(reverted.status).toBe("reverted");
    const content = await remote(`cat '${env.mutableRoot}/proof.txt'`);
    expect(content.stdout).toBe("before\n");

    const unsupported = await remoteJson<Packet[]>(withRemoteEnv({ BROOD_DISABLE_COLLECTORS: "filesystem" }, cli(`observe --scope '${scope}'`)));
    expect(unsupported[0]?.coverage).toBe("unsupported");
    expect(unsupported[0]?.facts).toEqual([]);
    expect(unsupported[0]?.problems.length).toBeGreaterThan(0);
  });
});

describe("fixture materialisation", () => {
  it("mounts real git repositories, not `.git.fixture` placeholders", async () => {
    const repositories = await remote(`find '${scope}/srv/projects' -type d -name .git -prune -print`);
    expect(repositories.code).toBe(0);
    expect(repositories.stdout.trim().split("\n").filter(Boolean).length).toBeGreaterThan(0);
    const placeholder = await remote(`test -f '${scope}/srv/projects/portal/.git/HEAD'`);
    expect(placeholder.code).toBe(0);
    const leftovers = await remote(`find '${scope}' -type d -name .git.fixture -print`);
    expect(leftovers.stdout.trim()).toBe("");
  });

  // Only `hostile` declares the permission faults; the run is materialised, so the modes
  // must be in the mount and actually deny the `brood` user.
  it.skipIf(scenarioName !== "hostile")("applies the hostile permission faults in the mounted copy", async () => {
    for (const target of [`${scope}/home/keeper/locked`, `${scope}/srv/isolated/unreadable`]) {
      const mode = await remote(`stat -c %a '${target}'`);
      expect(mode.code, mode.stderr).toBe(0);
      expect(mode.stdout.trim()).toBe("0");
      const listing = await remote(`ls '${target}'`);
      expect(listing.code).not.toBe(0);
      expect(listing.stderr).toMatch(/permission denied/i);
    }
  });
});

describe("blast radius — scenario state equality", () => {
  it("leaves the mounted scenario byte-for-byte and mode-for-mode unchanged", async () => {
    expect(await scenarioSnapshotAfter()).toBe(await scenarioSnapshotBefore());
  });
});

function storageFindings(result: Assessment): Finding[] {
  return result.findings.filter((finding) => finding.kind === "storage.headroom_low");
}

async function createProposal(content: string, extraEnv: Record<string, string> = {}): Promise<{ id: string; diff: Record<string, unknown> }> {
  const env = requireEnvironment();
  const finding = {
    id: `synthetic-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    fault_id: "test-remediation",
    kind: "test-only",
    description: "Test-only reversible write under the isolated mutable root",
    evidence: { path: `${env.mutableRoot}/proof.txt` },
    coverage: "complete-within-scope",
    provenance: {
      observed_at: packets[0]?.observed_at ?? new Date().toISOString(),
      collector: { name: "filesystem", version: "1.0.0" },
      canonical_hash: packets[0]?.canonical_hash ?? "0".repeat(64)
    },
    remediation: { operation: "write-file", path: `${env.mutableRoot}/proof.txt`, content }
  };
  const result = await remoteJson<{ proposals: Array<{ id: string; diff: Record<string, unknown> }> }>(
    withRemoteEnv({ BROOD_PROVIDER: "fake", ...extraEnv }, cli("propose")), [finding]
  );
  const proposal = result.proposals[0];
  if (!proposal) throw new Error("fake provider returned no proposal for a test remediation");
  return proposal;
}

async function runApprovedChange(content: string): Promise<{
  verified: { status: string };
  reverted: { status: string };
}> {
  const proposal = await createProposal(content);
  const approval = await remoteJson<{ approval: string }>(cli(`approve --proposal '${proposal.id}'`));
  const applied = await remoteJson<{ status: string; receipt: { id: string } }>(
    cli(`apply --proposal '${proposal.id}' --approval '${approval.approval}'`)
  );
  expect(applied.status).toBe("applied");
  const verified = await remoteJson<{ status: string }>(cli(`verify --receipt '${applied.receipt.id}'`));
  const reverted = await remoteJson<{ status: string }>(cli(`revert --receipt '${applied.receipt.id}'`));
  return { verified, reverted };
}
