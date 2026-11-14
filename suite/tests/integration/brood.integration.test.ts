import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cli,
  declaredFaults,
  parseJsonOutput,
  remote,
  remoteJson,
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

let packets: Packet[] = [];
let assessment: Assessment;
let findings: Finding[] = [];

beforeAll(async () => {
  await startBroodEnvironment();
  packets = await remoteJson<Packet[]>(cli("observe --scope /srv/scenario"));
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
      withRemoteEnv({ BROOD_PROVIDER: "provider-must-not-be-called" }, cli("observe --scope /srv/scenario"))
    );
    expect(providerFreeObservation.map((packet) => packet.canonical_hash).sort()).toEqual(packets.map((packet) => packet.canonical_hash).sort());

    const assessment = await remoteJson<{ status: string; findings: Finding[] }>(
      withRemoteEnv({ BROOD_PROVIDER: "fake" }, cli("assess")), packets
    );
    expect(assessment.status).toBe("ok");
    expect(assessment.findings.every((finding) => finding.evidence && finding.coverage)).toBe(true);

    // S1 — a planted broken symlink is a fact, not a scan failure.
    const symlinkFacts = packets.flatMap((packet) => packet.facts).filter((fact) => fact.kind === "filesystem.symlink");
    expect(symlinkFacts.length).toBeGreaterThan(0);
    expect(symlinkFacts.some((fact) => fact.target_exists === false)).toBe(true);
    const dirtyBusiness = await remoteJson<Packet[]>(cli("observe --scope /srv/scenario/dirty-business"));
    expect(dirtyBusiness.map((packet) => packet.coverage)).toEqual(["complete-within-scope"]);
    expect(dirtyBusiness[0]?.errors).toEqual([]);

    // S1 — no scan is ever labelled incomplete without saying why.
    for (const packet of packets) {
      if (packet.coverage === "complete-within-scope") continue;
      expect(packet.errors.length + packet.skipped.length + packet.problems.length).toBeGreaterThan(0);
    }

    const proposals = await remoteJson<{ status: string; proposals: Array<Record<string, unknown>> }>(
      withRemoteEnv({ BROOD_PROVIDER: "fake" }, cli("propose")), assessment.findings
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
      { packets, findings: assessment.findings }
    );
    expect(report.status).toBe("ok");
    expect(report.markdown).toContain("# Brood observation report");
    expect(report.json).toHaveProperty("coverage");
  });
});

describe("L3 — detection from observed facts", () => {
  it("cites an observed packet fact for every finding, never the scenario manifest", () => {
    expect(findings.length).toBeGreaterThan(0);
    const observed = new Map<string, { fact: Record<string, unknown>; packetHash: string }>();
    for (const packet of packets) {
      for (const fact of packet.facts) observed.set(String(fact.path), { fact, packetHash: packet.canonical_hash });
    }
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
      expect(finding.coverage).toBeDefined();
    }
    expect(findings.some((finding) => /healthy|all[- ]clear/i.test(finding.fault_id))).toBe(false);
  });

  it("detects storage headroom over the threshold and stays silent below it", async () => {
    const business = await observeAndAssess("/srv/scenario/dirty-business");
    const businessStorage = storageFindings(business.assessment);
    expect(businessStorage).toHaveLength(1);
    expect(businessStorage[0]).toMatchObject({
      fault_id: "storage.near_full",
      kind: "storage.headroom_low",
      measured: { mount: "/srv/data", use_percent: 93, threshold: 80 }
    });
    expect(businessStorage[0]!.evidence.path).toBe("/srv/scenario/dirty-business/etc/brood/packets/df-h.txt");

    const hostile = await observeAndAssess("/srv/scenario/hostile");
    expect(storageFindings(hostile.assessment).map((finding) => finding.evidence.path)).toEqual([
      "/srv/scenario/hostile/etc/brood/packets/df-h.txt"
    ]);

    // Negative control: 57% used never crosses an 80% line.
    for (const name of ["clean", "dirty-dev", "partial"]) {
      const scoped = await observeAndAssess(`/srv/scenario/${name}`);
      expect(storageFindings(scoped.assessment), name).toEqual([]);
      for (const finding of scoped.assessment.findings) {
        expect(String(finding.evidence.path ?? "").endsWith("/scenario.yaml")).toBe(false);
      }
    }

    const partial = await observeAndAssess("/srv/scenario/partial");
    expect(partial.assessment.undetected).toEqual([
      expect.objectContaining({
        fault_id: "collector.packages_tool_missing",
        reason: expect.stringContaining("no detector for kind 'collector.unsupported'")
      })
    ]);
  });

  it("honours an explicit threshold instead of resolving the documents' contradiction", async () => {
    const business = await observeAndAssess("/srv/scenario/dirty-business");
    const strict = await remoteJson<Assessment>(
      withRemoteEnv({ BROOD_PROVIDER: "fake", BROOD_STORAGE_THRESHOLD_PERCENT: "95" }, cli("assess")),
      business.packets
    );
    expect(storageFindings(strict)).toEqual([]);
    expect(strict.undetected).toContainEqual(expect.objectContaining({
      fault_id: "storage.near_full",
      expect_as: "storage.headroom_low",
      reason: "detector ran, threshold not crossed"
    }));
  });

  it("reports every declared fault without a finding as undetected, with a reason", async () => {
    const declared = await declaredFaults();
    expect(declared.length).toBeGreaterThan(findings.length);

    // Invent none: every detected kind is one the scenario tree declares.
    const declaredKinds = new Set(declared.map((fault) => fault.expectAs));
    for (const finding of findings) expect(declaredKinds.has(finding.kind)).toBe(true);

    // Exactly one declaration is backed by a detection (the full tree has two 93% captures).
    const storageDeclarations = declared.filter((fault) => fault.expectAs === "storage.headroom_low");
    expect(storageDeclarations).toHaveLength(1);
    expect(findings.map((finding) => finding.fault_id).sort()).toEqual(["storage.near_full", "storage.near_full"]);
    expect(assessment.undetected).toHaveLength(declared.length - 1);

    for (const entry of assessment.undetected) {
      expect(entry.fault_id.length).toBeGreaterThan(0);
      expect(entry.expect_as.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      // Storage was detected, so every remaining gap names the missing detector.
      expect(entry.reason).toContain(`no detector for kind '${entry.expect_as}'`);
    }

    // No declaration is silently dropped: each is either detected or listed as undetected.
    expect(assessment.undetected.some((entry) => entry.fault_id === "storage.near_full")).toBe(false);
    for (const fault of declared) {
      const accounted = findings.some((finding) => finding.fault_id === fault.id)
        || assessment.undetected.some((entry) => entry.fault_id === fault.id);
      expect(accounted, `declared fault ${fault.id} is neither detected nor undetected`).toBe(true);
    }
  });

  it("does not emit healthy findings for an incomplete/unsupported scan", async () => {
    const unsupportedPackets = await remoteJson<Packet[]>(withRemoteEnv({ BROOD_DISABLE_COLLECTORS: "filesystem" }, cli("observe --scope /srv/scenario")));
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
    const paused = spawnRemote(withRemoteEnv({ BROOD_TEST_PAUSE_MARKER: marker }, cli("observe --scope /srv/scenario")));
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
    const recovered = await remoteJson<Packet[]>(cli("observe --scope /srv/scenario"));
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

    const unsupported = await remoteJson<Packet[]>(withRemoteEnv({ BROOD_DISABLE_COLLECTORS: "filesystem" }, cli("observe --scope /srv/scenario")));
    expect(unsupported[0]?.coverage).toBe("unsupported");
    expect(unsupported[0]?.facts).toEqual([]);
    expect(unsupported[0]?.problems.length).toBeGreaterThan(0);
  });
});

describe("blast radius — scenario state equality", () => {
  it("leaves the fixture tree byte-for-byte and mode-for-mode unchanged", async () => {
    expect(await scenarioSnapshotAfter()).toBe(await scenarioSnapshotBefore());
  });
});

async function observeAndAssess(scope: string): Promise<{ packets: Packet[]; assessment: Assessment }> {
  const scoped = await remoteJson<Packet[]>(cli(`observe --scope '${scope}'`));
  const result = await remoteJson<Assessment>(withRemoteEnv({ BROOD_PROVIDER: "fake" }, cli("assess")), scoped);
  return { packets: scoped, assessment: result };
}

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
