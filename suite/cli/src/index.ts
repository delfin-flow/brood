#!/usr/bin/env node
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  aggregateCoverage,
  canonicalPacketHash,
  canonicalStringify,
  parseScenarioFaults,
  safeRelativePath,
  sha256,
  unifiedDiff,
  validateFinding,
  validatePacket,
  validateProposal,
  validateReceipt,
  type Coverage,
  type CoverageReasons,
  type JsonRecord
} from "./lib.ts";
import { collectFilesystem, type Fact } from "./collector.ts";
import { runProvider } from "./provider.ts";

type Packet = JsonRecord & {
  schema_version: 1;
  kind: "filesystem.snapshot" | "coverage.status";
  scope: string;
  coverage: Coverage;
  observed_at: string;
  collector: { name: string; version: string };
  facts: Fact[];
  errors: string[];
  skipped: string[];
  problems: string[];
  canonical_hash: string;
};

function jsonOut(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function argsAfterCommand(argv: string[]): { flags: Map<string, string[]>; positional: string[] } {
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!;
    if (item.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        flags.set(item, [...(flags.get(item) ?? []), ""]);
      } else {
        flags.set(item, [...(flags.get(item) ?? []), value]);
        i += 1;
      }
    } else positional.push(item);
  }
  return { flags, positional };
}

function flag(parsed: ReturnType<typeof argsAfterCommand>, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonInput(source: string): unknown {
  if (!source.trim()) throw new Error("JSON input is required on stdin");
  return JSON.parse(source) as unknown;
}

function packetWithHash(packet: Omit<Packet, "canonical_hash">): Packet {
  const result = { ...packet, canonical_hash: "" } as Packet;
  result.canonical_hash = canonicalPacketHash(result);
  return result;
}

async function observe(scopes: string[], parsed: ReturnType<typeof argsAfterCommand>): Promise<void> {
  if (scopes.length === 0) throw new Error("observe requires --scope <path…>");
  const disabled = new Set((process.env.BROOD_DISABLE_COLLECTORS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const packets: Packet[] = [];
  for (const scopeInput of scopes) {
    const scope = path.resolve(scopeInput);
    if (disabled.has("filesystem")) {
      const reasons: CoverageReasons = {
        errors: [],
        skipped: [],
        problems: [`collector 'filesystem' is unavailable: disabled by BROOD_DISABLE_COLLECTORS for scope ${scope}`]
      };
      packets.push(packetWithHash({
        schema_version: 1,
        kind: "coverage.status",
        scope,
        coverage: "unsupported",
        observed_at: new Date().toISOString(),
        collector: { name: "filesystem", version: "1.0.0" },
        facts: [],
        ...reasons
      }));
      continue;
    }
    const result = await collectFilesystem(scope, { pauseMarker: process.env.BROOD_TEST_PAUSE_MARKER });
    packets.push(packetWithHash({
      schema_version: 1,
      kind: "filesystem.snapshot",
      scope,
      coverage: result.coverage,
      observed_at: new Date().toISOString(),
      collector: { name: "filesystem", version: "1.0.0" },
      facts: result.facts,
      ...result.reasons
    }));
  }

  jsonOut(packets);
}

function inputPackets(value: unknown): JsonRecord[] {
  const packets = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && Array.isArray((value as JsonRecord).packets)
      ? (value as JsonRecord).packets as unknown[]
      : undefined;
  if (!packets) throw new Error("assess input must be a packet array or { packets: [...] }");
  if (packets.length === 0) throw new Error("assess requires at least one observation packet; empty input is not a successful scan");
  for (const packet of packets) validatePacket(packet);
  return packets as JsonRecord[];
}

function generatedFindings(packets: JsonRecord[]): JsonRecord[] {
  const findings: JsonRecord[] = [];
  const overallCoverage = aggregateCoverage(packets.map((packet) => packet.coverage as Coverage));
  for (const packet of packets) {
    if (packet.kind !== "filesystem.snapshot") continue;
    const facts = packet.facts as Fact[];
    for (const fact of facts) {
      if (fact.kind === "filesystem.symlink") continue;
      if (typeof fact.content !== "string" || path.basename(fact.path) !== "scenario.yaml") continue;
      for (const declared of parseScenarioFaults(fact.content)) {
        const id = `declared-${sha256(canonicalStringify({ source: fact.path, fault: declared.raw, index: declared.index })).slice(0, 16)}`;
        findings.push({
          id,
          fault_id: declared.id,
          kind: declared.kind,
          description: declared.description,
          ...(declared.path ? { target: declared.path } : {}),
          evidence: { path: fact.path, packet_hash: packet.canonical_hash },
          coverage: overallCoverage,
          provenance: {
            observed_at: packet.observed_at,
            collector: packet.collector,
            canonical_hash: packet.canonical_hash
          },
          source: fact.path
        });
      }
    }
  }
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = String(finding.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function assess(input: unknown): Promise<void> {
  const packets = inputPackets(input);
  const coverage = aggregateCoverage(packets.map((p) => p.coverage as Coverage));
  if (coverage === "unsupported") {
    jsonOut({ status: "unsupported", coverage, findings: [] });
    return;
  }
  const expected = generatedFindings(packets);
  const raw = await runProvider("assess", { packets, declared_findings: expected }, () => ({ findings: expected }));
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as JsonRecord).findings)) {
    throw new Error("provider refusal: malformed assess output; findings array required");
  }
  const findings = (raw as JsonRecord).findings as unknown[];
  for (const finding of findings) validateFinding(finding);
  const expectedById = new Map(expected.map((finding) => [String(finding.id), finding]));
  const actualIds = new Set(findings.map((f) => String((f as JsonRecord).id)));
  if (actualIds.size !== findings.length) throw new Error("provider refusal: duplicate finding returned");
  if ([...actualIds].some((id) => !expectedById.has(id)) || expected.some((f) => !actualIds.has(String(f.id)))) {
    throw new Error("provider refusal: output does not exactly match declared faults");
  }
  const invariants = ["fault_id", "kind", "evidence", "coverage", "provenance", "source", "target"] as const;
  for (const item of findings as JsonRecord[]) {
    const baseline = expectedById.get(String(item.id))!;
    for (const key of invariants) {
      if (canonicalStringify(item[key]) !== canonicalStringify(baseline[key])) {
        throw new Error(`provider refusal: finding ${String(item.id)} altered fact field '${key}'`);
      }
    }
  }
  jsonOut({ status: coverage === "complete-within-scope" ? "ok" : coverage, coverage, findings });
}

function stateDir(): string {
  return path.resolve(process.env.BROOD_STATE_DIR ?? path.join(os.homedir(), ".brood"));
}

async function ensureStateDirs(): Promise<void> {
  for (const name of ["proposals", "receipts"]) await fs.mkdir(path.join(stateDir(), name), { recursive: true, mode: 0o700 });
}

async function safeTarget(requested: string): Promise<string> {
  const root = process.env.BROOD_MUTABLE_ROOT;
  if (!root) throw new Error("BROOD_MUTABLE_ROOT must be set before proposing or applying file changes");
  const resolvedRoot = await fs.realpath(path.resolve(root));
  const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(resolvedRoot, requested);
  const resolved = safeRelativePath(resolvedRoot, candidate);
  const parent = await fs.realpath(path.dirname(resolved));
  if (parent !== resolvedRoot && !parent.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("target parent escapes BROOD_MUTABLE_ROOT");
  const parentStat = await fs.lstat(path.dirname(resolved));
  if (parentStat.isSymbolicLink()) throw new Error("symlink parent is not allowed");
  try {
    const targetStat = await fs.lstat(resolved);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw new Error("target must be a regular file, not a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return resolved;
}

async function makeProposals(findings: unknown[]): Promise<JsonRecord[]> {
  for (const finding of findings) validateFinding(finding);
  const raw = await runProvider("propose", { findings }, () => ({ proposals: findings }));
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as JsonRecord).proposals)) {
    throw new Error("provider refusal: malformed propose output; proposals array required");
  }
  const providerItems = (raw as JsonRecord).proposals as unknown[];
  if (providerItems.length !== findings.length) throw new Error("provider refusal: proposal count differs from finding count");
  const sourceById = new Map((findings as JsonRecord[]).map((finding) => [String(finding.id), finding]));
  const returnedIds = new Set<string>();
  for (const item of providerItems) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("provider refusal: malformed proposal item");
    const id = String((item as JsonRecord).id ?? "");
    if (!sourceById.has(id) || returnedIds.has(id)) throw new Error("provider refusal: proposal does not map one-to-one to an input finding");
    returnedIds.add(id);
  }
  await ensureStateDirs();
  const ttl = Number(process.env.BROOD_PROPOSAL_TTL_SECONDS ?? 900);
  if (!Number.isFinite(ttl)) throw new Error("BROOD_PROPOSAL_TTL_SECONDS must be numeric");
  const proposals: JsonRecord[] = [];
  for (const item of providerItems) {
    const providerItem = item as JsonRecord;
    const finding = sourceById.get(String(providerItem.id))!;
    const remediation = providerItem.remediation ?? finding.remediation;
    let diff: JsonRecord;
    let revert: JsonRecord;
    if (remediation && typeof remediation === "object") {
      const r = remediation as JsonRecord;
      if (r.operation !== "write-file" || typeof r.path !== "string" || typeof r.content !== "string") {
        throw new Error("not implemented: only explicit write-file remediations are supported");
      }
      const target = await safeTarget(r.path);
      let before: Buffer | null = null;
      let mode = 0o600;
      try {
        before = await fs.readFile(target);
        mode = (await fs.stat(target)).mode & 0o777;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const after = Buffer.from(r.content, "utf8");
      diff = {
        operation: "write-file",
        path: target,
        expected_before_sha256: before ? sha256(before) : null,
        content_base64: after.toString("base64"),
        after_sha256: sha256(after),
        mode
      };
      revert = {
        operation: "restore-file",
        path: target,
        existed: before !== null,
        content_base64: before?.toString("base64") ?? null,
        before_sha256: before ? sha256(before) : null,
        mode
      };
    } else {
      diff = { operation: "manual", finding_id: finding.id, reason: "No machine-applicable remediation was supplied" };
      revert = { operation: "not-applicable", reason: "No file was changed" };
    }
    const proposal: JsonRecord = {
      id: randomUUID(),
      finding_id: finding.id,
      diff,
      cost_estimate: { unit: "file-operations", value: diff.operation === "write-file" ? 1 : 0 },
      revert,
      expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      argument_hash: sha256(canonicalStringify(diff))
    };
    validateProposal(proposal);
    await fs.writeFile(path.join(stateDir(), "proposals", `${proposal.id}.json`), `${JSON.stringify(proposal, null, 2)}\n`, { mode: 0o600 });
    proposals.push(proposal);
  }
  return proposals;
}

function approvalSecret(): string {
  const value = process.env.BROOD_APPROVAL_SECRET;
  if (!value) throw new Error("approval refused: BROOD_APPROVAL_SECRET is not configured");
  return value;
}

function tokenPayload(proposal: JsonRecord): JsonRecord {
  return { proposal_id: proposal.id, argument_hash: proposal.argument_hash, expires_at: proposal.expires_at };
}

function signApproval(proposal: JsonRecord): string {
  const payload = Buffer.from(canonicalStringify(tokenPayload(proposal))).toString("base64url");
  const signature = createHmac("sha256", approvalSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function validApproval(token: string, proposal: JsonRecord): boolean {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;
  const expected = createHmac("sha256", approvalSecret()).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return false; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown; } catch { return false; }
  return canonicalStringify(decoded) === canonicalStringify(tokenPayload(proposal));
}

async function readStored(kind: "proposals" | "receipts", id: string): Promise<JsonRecord> {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error(`invalid ${kind.slice(0, -1)} id`);
  const content = await fs.readFile(path.join(stateDir(), kind, `${id}.json`), "utf8");
  const parsed: unknown = JSON.parse(content);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`stored ${kind.slice(0, -1)} is malformed`);
  return parsed as JsonRecord;
}

async function atomicWrite(target: string, content: Buffer, mode: number): Promise<void> {
  const temporary = `${target}.brood-${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode, flag: "wx" });
  await fs.rename(temporary, target);
}

async function applyProposal(proposalId: string | undefined, approval: string | undefined, override: string | undefined): Promise<void> {
  if (!proposalId) throw new Error("apply requires --proposal <id>");
  if (!approval) throw new Error("apply refused: --approval token is required");
  const proposal = await readStored("proposals", proposalId);
  validateProposal(proposal);
  const denied = (reason: string): void => { jsonOut({ status: "denied", proposal_id: proposalId, reason }); process.exitCode = 3; };
  if (Date.parse(String(proposal.expires_at)) <= Date.now()) return denied("approval token expired");
  if (sha256(canonicalStringify(proposal.diff)) !== proposal.argument_hash) return denied("proposal arguments were altered");
  if (!validApproval(approval, proposal)) return denied("approval token is missing, invalid, or bound to different arguments");
  if (override !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(override) as unknown; } catch { return denied("--arguments-json is malformed"); }
    if (sha256(canonicalStringify(parsed)) !== proposal.argument_hash) return denied("approval token does not authorize altered arguments");
  }
  const diff = proposal.diff as JsonRecord;
  if (diff.operation !== "write-file") throw new Error("not implemented: apply supports only write-file proposals");
  if (typeof diff.path !== "string" || typeof diff.content_base64 !== "string" || typeof diff.after_sha256 !== "string") {
    throw new Error("stored proposal diff is malformed");
  }
  const target = await safeTarget(diff.path);
  let before: Buffer | null = null;
  try { before = await fs.readFile(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const currentHash = before ? sha256(before) : null;
  if (currentHash !== diff.expected_before_sha256) return denied("target changed since proposal; re-observe and re-propose");
  const after = Buffer.from(diff.content_base64, "base64");
  if (sha256(after) !== diff.after_sha256) return denied("proposal content hash mismatch");
  await atomicWrite(target, after, Number(diff.mode ?? 0o600));
  const receipt: JsonRecord = {
    id: randomUUID(),
    proposal_id: proposal.id,
    path: target,
    applied_at: new Date().toISOString(),
    before_existed: before !== null,
    before_content_base64: before?.toString("base64") ?? null,
    before_sha256: currentHash,
    after_sha256: sha256(after),
    mode: Number(diff.mode ?? 0o600),
    status: "applied"
  };
  validateReceipt(receipt);
  await fs.writeFile(path.join(stateDir(), "receipts", `${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  jsonOut({ status: "applied", receipt });
}

async function verifyReceipt(receiptId: string | undefined): Promise<void> {
  if (!receiptId) throw new Error("verify requires --receipt <id>");
  const receipt = await readStored("receipts", receiptId);
  validateReceipt(receipt);
  const target = await safeTarget(String(receipt.path));
  let current: Buffer;
  try { current = await fs.readFile(target); } catch {
    jsonOut({ status: "failed", receipt_id: receiptId, reason: "target is missing" });
    process.exitCode = 4;
    return;
  }
  if (sha256(current) !== receipt.after_sha256) {
    jsonOut({ status: "failed", receipt_id: receiptId, reason: "target no longer matches applied hash" });
    process.exitCode = 4;
    return;
  }
  jsonOut({ status: "verified", receipt_id: receiptId, path: target, sha256: receipt.after_sha256 });
}

async function revertReceipt(receiptId: string | undefined): Promise<void> {
  if (!receiptId) throw new Error("revert requires --receipt <id>");
  const receipt = await readStored("receipts", receiptId);
  validateReceipt(receipt);
  const target = await safeTarget(String(receipt.path));
  let current: Buffer | null = null;
  try { current = await fs.readFile(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!current || sha256(current) !== receipt.after_sha256) {
    jsonOut({ status: "denied", receipt_id: receiptId, reason: "target differs from applied state; refusing to overwrite" });
    process.exitCode = 3;
    return;
  }
  if (receipt.before_existed === true && typeof receipt.before_content_base64 === "string") {
    const before = Buffer.from(receipt.before_content_base64, "base64");
    if (receipt.before_sha256 !== sha256(before)) throw new Error("stored revert content hash mismatch");
    await atomicWrite(target, before, Number(receipt.mode ?? 0o600));
  } else {
    await fs.unlink(target);
  }
  jsonOut({ status: "reverted", receipt_id: receiptId, path: target });
}

async function report(input: unknown, parsed: ReturnType<typeof argsAfterCommand>): Promise<void> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("report input must be { packets, findings }");
  const obj = input as JsonRecord;
  const packets = inputPackets(obj.packets);
  if (!Array.isArray(obj.findings)) throw new Error("report requires findings array");
  const packetHashes = new Set(packets.map((packet) => String(packet.canonical_hash)));
  for (const finding of obj.findings) {
    validateFinding(finding);
    const provenance = (finding as JsonRecord).provenance as JsonRecord;
    if (!packetHashes.has(String(provenance.canonical_hash))) throw new Error("report finding provenance does not refer to an input packet");
  }
  const coverage = aggregateCoverage(packets.map((p) => p.coverage as Coverage));
  const caveats = packets.flatMap((packet) => {
    const rows: Array<{ scope: string; kind: string; reason: string }> = [];
    for (const key of ["errors", "skipped", "problems"] as const) {
      const list = Array.isArray(packet[key]) ? (packet[key] as string[]) : [];
      for (const reason of list) rows.push({ scope: String(packet.scope), kind: key.slice(0, -1), reason });
    }
    return rows;
  });
  const lines = [
    "# Brood observation report",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Coverage: ${coverage}`,
    `- Packets: ${packets.length}`,
    `- Findings: ${obj.findings.length}`,
    ""
  ];
  if (caveats.length > 0) {
    lines.push("## Coverage caveats", "");
    for (const caveat of caveats) lines.push(`- ${caveat.kind}: ${caveat.reason} (scope ${caveat.scope})`);
    lines.push("");
  }
  lines.push("## Findings", "");
  if (obj.findings.length === 0) lines.push("No declared faults were found in the observed scenario metadata.");
  for (const item of obj.findings as JsonRecord[]) {
    const evidence = item.evidence as JsonRecord;
    lines.push(`### ${String(item.fault_id)} (${String(item.kind)})`);
    lines.push("");
    lines.push(String(item.description));
    lines.push("");
    lines.push(`- Evidence: ${typeof evidence.path === "string" ? evidence.path : `packet ${String(evidence.packet_hash)}`}`);
    lines.push(`- Coverage: ${String(item.coverage)}`);
    lines.push("");
  }
  const data = {
    generated_at: new Date().toISOString(),
    coverage,
    packets: packets.map((p) => ({
      kind: p.kind,
      scope: p.scope,
      coverage: p.coverage,
      errors: p.errors,
      skipped: p.skipped,
      problems: p.problems,
      canonical_hash: p.canonical_hash
    })),
    findings: obj.findings
  };
  const markdown = `${lines.join("\n")}\n`;
  const outputPath = flag(parsed, "--markdown-out");
  if (outputPath) await fs.writeFile(path.resolve(outputPath), markdown, { mode: 0o600 });
  jsonOut({ status: "ok", markdown, json: data });
}

function usage(): string {
  return [
    "broodctl <command>",
    "  observe --scope <path…>",
    "  assess                         # JSON packets on stdin",
    "  propose                        # JSON findings on stdin",
    "  approve --proposal <id>        # emits an HMAC approval token",
    "  apply --proposal <id> --approval <token>",
    "  verify --receipt <id>",
    "  revert --receipt <id>",
    "  report                         # { packets, findings } JSON on stdin"
  ].join("\n");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const parsed = argsAfterCommand(rest);
  switch (command) {
    case "observe": {
      const scopes = [...(parsed.flags.get("--scope") ?? []), ...parsed.positional];
      await observe(scopes.filter(Boolean), parsed);
      return;
    }
    case "assess":
      await assess(parseJsonInput(await readStdin()));
      return;
    case "propose": {
      const input = parseJsonInput(await readStdin());
      const findings = Array.isArray(input) ? input : input !== null && typeof input === "object" && Array.isArray((input as JsonRecord).findings) ? (input as JsonRecord).findings as unknown[] : undefined;
      if (!findings) throw new Error("propose input must be a findings array or { findings: [...] }");
      const proposals = await makeProposals(findings);
      jsonOut({ status: "ok", proposals });
      return;
    }
    case "approve": {
      const id = flag(parsed, "--proposal");
      if (!id) throw new Error("approve requires --proposal <id>");
      const proposal = await readStored("proposals", id);
      validateProposal(proposal);
      jsonOut({ proposal_id: id, approval: signApproval(proposal), expires_at: proposal.expires_at });
      return;
    }
    case "apply":
      await applyProposal(flag(parsed, "--proposal"), flag(parsed, "--approval"), flag(parsed, "--arguments-json"));
      return;
    case "verify":
      await verifyReceipt(flag(parsed, "--receipt"));
      return;
    case "revert":
      await revertReceipt(flag(parsed, "--receipt"));
      return;
    case "report":
      await report(parseJsonInput(await readStdin()), parsed);
      return;
    default:
      throw new Error(`not implemented: command '${command}' is not part of this minimal CLI`);
  }
}

main().catch((error: unknown) => {
  jsonOut({ status: "failed", error: errorText(error) });
  process.exitCode = 2;
});
