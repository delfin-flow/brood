import { createHash } from "node:crypto";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const COVERAGE_STATES = [
  "complete-within-scope",
  "partial",
  "unsupported",
  "unknown",
  "stale"
] as const;

export type Coverage = (typeof COVERAGE_STATES)[number];
export type JsonRecord = Record<string, unknown>;

export const PACKET_KINDS = ["filesystem.snapshot", "coverage.status"] as const;

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) out[key] = canonicalize(input[key]);
    return out;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Packet identity deliberately excludes observation time and the hash field itself. */
export function canonicalPacketHash(packet: JsonRecord): string {
  const { observed_at: _observedAt, canonical_hash: _canonicalHash, ...stable } = packet;
  return sha256(canonicalStringify(stable));
}

export function aggregateCoverage(states: readonly Coverage[]): Coverage {
  if (states.length === 0) return "unknown";
  if (states.every((s) => s === "unsupported")) return "unsupported";
  if (states.includes("stale")) return "stale";
  if (states.includes("unknown")) return "unknown";
  if (states.includes("unsupported") || states.includes("partial")) return "partial";
  return "complete-within-scope";
}

export function unifiedDiff(before: string, after: string, label = "file"): string {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();
  const rows = [`--- a/${label}`, `+++ b/${label}`, `@@ -1,${a.length} +1,${b.length} @@`];
  for (const line of a) rows.push(`-${line}`);
  for (const line of b) rows.push(`+${line}`);
  return rows.join("\n");
}

export function isCoverage(value: unknown): value is Coverage {
  return typeof value === "string" && (COVERAGE_STATES as readonly string[]).includes(value);
}

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): asserts value is JsonRecord {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

export function validatePacket(value: unknown): asserts value is JsonRecord {
  requireObject(value, "packet");
  if (value.schema_version !== 1) throw new Error("packet.schema_version must be 1");
  if (typeof value.kind !== "string" || !(PACKET_KINDS as readonly string[]).includes(value.kind)) {
    throw new Error("packet.kind is undeclared");
  }
  if (!isCoverage(value.coverage)) throw new Error("packet.coverage is invalid");
  requireNonEmptyString(value.observed_at, "packet.observed_at");
  if (Number.isNaN(Date.parse(value.observed_at))) throw new Error("packet.observed_at is not a timestamp");
  requireObject(value.collector, "packet.collector");
  requireNonEmptyString(value.collector.name, "packet.collector.name");
  requireNonEmptyString(value.collector.version, "packet.collector.version");
  if (!Array.isArray(value.facts)) throw new Error("packet.facts must be an array");
  if (typeof value.canonical_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.canonical_hash)) {
    throw new Error("packet.canonical_hash must be a lowercase SHA-256 hash");
  }
  if (canonicalPacketHash(value) !== value.canonical_hash) throw new Error("packet.canonical_hash does not match its contents");
}

export function validateFinding(value: unknown): asserts value is JsonRecord {
  requireObject(value, "finding");
  requireNonEmptyString(value.id, "finding.id");
  requireNonEmptyString(value.fault_id, "finding.fault_id");
  requireNonEmptyString(value.kind, "finding.kind");
  if (!isCoverage(value.coverage)) throw new Error("finding.coverage is invalid");
  requireObject(value.evidence, "finding.evidence");
  const evidence = value.evidence;
  const pathEvidence = typeof evidence.path === "string" && evidence.path.length > 0;
  const hashEvidence = typeof evidence.packet_hash === "string" && /^[a-f0-9]{64}$/.test(evidence.packet_hash);
  if (!pathEvidence && !hashEvidence) throw new Error("finding.evidence must contain a path or packet_hash");
  requireObject(value.provenance, "finding.provenance");
  requireNonEmptyString(value.provenance.observed_at, "finding.provenance.observed_at");
  requireObject(value.provenance.collector, "finding.provenance.collector");
  requireNonEmptyString(value.provenance.collector.name, "finding.provenance.collector.name");
  requireNonEmptyString(value.provenance.collector.version, "finding.provenance.collector.version");
  if (typeof value.provenance.canonical_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.provenance.canonical_hash)) {
    throw new Error("finding.provenance.canonical_hash must be a lowercase SHA-256 hash");
  }
}

export function validateProposal(value: unknown): asserts value is JsonRecord {
  requireObject(value, "proposal");
  requireNonEmptyString(value.id, "proposal.id");
  if (!isObject(value.diff)) throw new Error("proposal.diff must be an object");
  if (value.cost_estimate === undefined || value.cost_estimate === null) throw new Error("proposal.cost_estimate is required");
  if (!isObject(value.revert)) throw new Error("proposal.revert must be an object");
  requireNonEmptyString(value.expires_at, "proposal.expires_at");
  if (Number.isNaN(Date.parse(value.expires_at))) throw new Error("proposal.expires_at is invalid");
  if (typeof value.argument_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.argument_hash)) {
    throw new Error("proposal.argument_hash must be a lowercase SHA-256 hash");
  }
}

export function validateReceipt(value: unknown): asserts value is JsonRecord {
  requireObject(value, "receipt");
  requireNonEmptyString(value.id, "receipt.id");
  requireNonEmptyString(value.proposal_id, "receipt.proposal_id");
  requireNonEmptyString(value.path, "receipt.path");
  if (typeof value.after_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.after_sha256)) {
    throw new Error("receipt.after_sha256 must be a lowercase SHA-256 hash");
  }
}

export interface Manifest {
  schema_version: 1;
  owners: string[];
  fallback: string;
  packet_kinds: string[];
  collectors: Array<{ name: string; version: string; kind: string }>;
}

export function validateManifest(value: unknown): asserts value is Manifest {
  requireObject(value, "manifest");
  if (value.schema_version !== 1) throw new Error("manifest.schema_version must be 1");
  if (!Array.isArray(value.owners) || value.owners.some((x) => typeof x !== "string" || !x.trim())) {
    throw new Error("manifest.owners must be non-empty strings");
  }
  if (new Set(value.owners).size !== value.owners.length) throw new Error("manifest.owners contains duplicate owners");
  requireNonEmptyString(value.fallback, "manifest.fallback is required");
  if (!Array.isArray(value.packet_kinds) || value.packet_kinds.length === 0) throw new Error("manifest.packet_kinds is required");
  if (!Array.isArray(value.collectors)) throw new Error("manifest.collectors must be an array");
  for (const [i, collector] of value.collectors.entries()) {
    requireObject(collector, `manifest.collectors[${i}]`);
    requireNonEmptyString(collector.name, `manifest.collectors[${i}].name`);
    requireNonEmptyString(collector.version, `manifest.collectors[${i}].version`);
    requireNonEmptyString(collector.kind, `manifest.collectors[${i}].kind`);
    if (!value.packet_kinds.includes(collector.kind)) throw new Error(`manifest collector uses undeclared packet kind: ${collector.kind}`);
  }
}

export interface DeclaredFault {
  id: string;
  kind: string;
  description: string;
  path?: string;
  raw: JsonRecord;
  index: number;
}

export function parseScenarioFaults(content: string): DeclaredFault[] {
  const parsed: unknown = parseYaml(content);
  if (!isObject(parsed)) throw new Error("scenario.yaml must contain a YAML object");
  const scenario = isObject(parsed.scenario) ? parsed.scenario : undefined;
  let faultsValue: unknown;
  if ("faults" in parsed) faultsValue = parsed.faults;
  else if (scenario && "faults" in scenario) faultsValue = scenario.faults;
  else if ("planted_faults" in parsed) faultsValue = parsed.planted_faults;
  else throw new Error("scenario.yaml must explicitly declare a faults array");
  if (!Array.isArray(faultsValue)) throw new Error("scenario.yaml faults declaration must be an array");
  return faultsValue.map((item, index) => {
    if (!isObject(item)) throw new Error(`scenario.yaml faults[${index}] must be an object`);
    const rawId = item.id ?? item.name ?? item.key;
    const kindValue = item.kind ?? item.type ?? item.check ?? "declared-fault";
    const id = typeof rawId === "string" && rawId.trim()
      ? rawId.trim()
      : `${String(kindValue)}-${index + 1}`;
    const descriptionValue = item.description ?? item.title ?? rawId ?? kindValue;
    const pathValue = item.path ?? item.target ?? item.file;
    return {
      id,
      kind: typeof kindValue === "string" ? kindValue : "declared-fault",
      description: typeof descriptionValue === "string" ? descriptionValue : id,
      ...(typeof pathValue === "string" ? { path: pathValue } : {}),
      raw: item,
      index
    };
  });
}

export function safeRelativePath(root: string, requested: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(requested);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path is outside BROOD_MUTABLE_ROOT: ${requested}`);
  }
  return resolved;
}
