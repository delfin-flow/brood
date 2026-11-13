import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cli,
  declaredFaultKeys,
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
  facts: unknown[];
}
interface Finding {
  id: string;
  fault_id: string;
  source: string;
  evidence: Record<string, string>;
  coverage: string;
}

let packets: Packet[] = [];
let findings: Finding[] = [];

beforeAll(async () => {
  await startBroodEnvironment();
  packets = await remoteJson<Packet[]>(cli("observe --scope /srv/scenario"));
  const assessment = await remoteJson<{ status: string; findings: Finding[] }>(
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

describe("L3 — declared-fault acceptance", () => {
  it("finds every declared fault, invents none, and attaches evidence to every finding", async () => {
    const expected = await declaredFaultKeys();
    expect(expected.length).toBeGreaterThan(0);
    const actual = findings.map((finding) => {
      const sourceRelative = finding.source.replace(/^\/srv\/scenario\/?/, "");
      return `${sourceRelative}|${finding.fault_id}`;
    }).sort();
    expect(actual).toEqual(expected);
    expect(findings.every((finding) => Boolean(finding.evidence?.path || finding.evidence?.packet_hash))).toBe(true);
    expect(findings.every((finding) => finding.coverage !== undefined)).toBe(true);
    expect(findings.some((finding) => /healthy|all[- ]clear/i.test(finding.fault_id))).toBe(false);
  });

  it("does not emit healthy findings for an incomplete/unsupported scan", async () => {
    const result = await remoteJson<{ status: string; coverage: string; findings: Finding[] }>(
      withRemoteEnv({ BROOD_DISABLE_COLLECTORS: "filesystem", BROOD_PROVIDER: "fake" }, cli("assess")),
      await remoteJson<Packet[]>(withRemoteEnv({ BROOD_DISABLE_COLLECTORS: "filesystem" }, cli("observe --scope /srv/scenario")))
    );
    expect(result.status).toBe("unsupported");
    expect(result.coverage).toBe("unsupported");
    expect(result.findings).toEqual([]);
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
  });
});

describe("blast radius — scenario state equality", () => {
  it("leaves the fixture tree byte-for-byte and mode-for-mode unchanged", async () => {
    expect(await scenarioSnapshotAfter()).toBe(await scenarioSnapshotBefore());
  });
});

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
