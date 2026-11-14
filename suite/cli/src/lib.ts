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

/**
 * Why a scan is not `complete-within-scope`. Every non-complete coverage state must
 * carry at least one entry here — a coverage label without a reason is opaque and
 * therefore dishonest.
 */
export interface CoverageReasons {
  errors: string[];
  skipped: string[];
  problems: string[];
}

export const PACKET_KINDS = ["filesystem.snapshot", "coverage.status"] as const;
export const FACT_KINDS = ["filesystem.file", "filesystem.symlink"] as const;

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
  for (const [i, fact] of value.facts.entries()) validateFact(fact, `packet.facts[${i}]`);
  validateReasons(value, value.coverage);
  if (typeof value.canonical_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.canonical_hash)) {
    throw new Error("packet.canonical_hash must be a lowercase SHA-256 hash");
  }
  if (canonicalPacketHash(value) !== value.canonical_hash) throw new Error("packet.canonical_hash does not match its contents");
}

function validateReasons(value: JsonRecord, coverage: Coverage): void {
  const reasons: CoverageReasons = { errors: [], skipped: [], problems: [] };
  for (const key of ["errors", "skipped", "problems"] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.trim() === "")) {
      throw new Error(`packet.${key} must be an array of non-empty strings`);
    }
    reasons[key] = list as string[];
  }
  if (coverage === "complete-within-scope") return;
  const total = reasons.errors.length + reasons.skipped.length + reasons.problems.length;
  if (total === 0) {
    throw new Error(`packet.coverage is '${coverage}' but the scan carries no reason; errors, skipped or problems is required`);
  }
}

function validateFact(value: unknown, label: string): void {
  requireObject(value, label);
  requireNonEmptyString(value.path, `${label}.path`);
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error(`${label}.sha256 must be a lowercase SHA-256 hash`);
  if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size < 0) throw new Error(`${label}.size must be a non-negative integer`);
  if (typeof value.mode !== "number" || !Number.isInteger(value.mode)) throw new Error(`${label}.mode must be an integer`);
  if (value.kind === undefined) return;
  if (typeof value.kind !== "string" || !(FACT_KINDS as readonly string[]).includes(value.kind)) throw new Error(`${label}.kind is undeclared`);
  if (value.kind === "filesystem.symlink") {
    if (typeof value.target !== "string") throw new Error(`${label}.target is required for a symlink fact`);
    // A symlink fact must say whether its target resolved — a dangling link is a fact, not a failure.
    if (typeof value.target_exists !== "boolean") throw new Error(`${label}.target_exists is required for a symlink fact`);
    if (value.target_exists === false && typeof value.loop !== "boolean") throw new Error(`${label}.loop is required when a symlink target does not resolve`);
  }
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
  /** Stable fault identity, as declared by the scenario. */
  id: string;
  /** The fault kind this declaration expects to be observed (`expect_as`). */
  expectAs: string;
  /** Scenario-relative path of the record that carries the evidence. */
  evidence: string;
  /** Commands an honest observer could have used to find this. */
  discoverableBy: string[];
  note?: string;
  raw: JsonRecord;
  index: number;
}

/** The fixture schema is the contract: an undeclared field is a declaration bug, not a wart to tolerate. */
const FAULT_FIELDS = ["id", "expect_as", "evidence", "discoverable_by", "note"] as const;

export function parseScenarioFaults(content: string): DeclaredFault[] {
  const parsed: unknown = parseYaml(content);
  if (!isObject(parsed)) throw new Error("scenario.yaml must contain a YAML object");
  const scenario = isObject(parsed.scenario) ? parsed.scenario : undefined;
  let faultsValue: unknown;
  if ("faults" in parsed) faultsValue = parsed.faults;
  else if (scenario && "faults" in scenario) faultsValue = scenario.faults;
  else throw new Error("scenario.yaml must explicitly declare a faults array");
  if (!Array.isArray(faultsValue)) throw new Error("scenario.yaml faults declaration must be an array");
  return faultsValue.map((item, index) => {
    const label = `scenario.yaml faults[${index}]`;
    if (!isObject(item)) throw new Error(`${label} must be an object`);
    const undeclared = Object.keys(item).filter((key) => !(FAULT_FIELDS as readonly string[]).includes(key));
    if (undeclared.length > 0) {
      throw new Error(`${label} has undeclared field(s): ${undeclared.join(", ")}; declared fields are ${FAULT_FIELDS.join(", ")}`);
    }
    requireNonEmptyString(item.id, `${label}.id`);
    requireNonEmptyString(item.expect_as, `${label}.expect_as`);
    requireNonEmptyString(item.evidence, `${label}.evidence`);
    if (!Array.isArray(item.discoverable_by) || item.discoverable_by.length === 0) {
      throw new Error(`${label}.discoverable_by must be a non-empty array of commands`);
    }
    for (const [i, command] of item.discoverable_by.entries()) {
      requireNonEmptyString(command, `${label}.discoverable_by[${i}]`);
    }
    if (item.note !== undefined) requireNonEmptyString(item.note, `${label}.note`);
    return {
      id: item.id.trim(),
      expectAs: item.expect_as.trim(),
      evidence: item.evidence.trim(),
      discoverableBy: (item.discoverable_by as string[]).map((command) => command.trim()),
      ...(typeof item.note === "string" ? { note: item.note.trim() } : {}),
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
