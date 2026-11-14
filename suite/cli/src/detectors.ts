import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256, type Coverage, type JsonRecord } from "./lib.ts";
import type { Fact } from "./collector.ts";

/**
 * Detectors turn an observed packet fact into a finding.
 *
 * A detector never reads the scenario manifest: the finding it emits cites the
 * fact it measured (`path` + `sha256` + the packet's `canonical_hash`), and the
 * bytes are re-hashed before use so a file that changed after it was observed
 * is refused rather than trusted.
 */

export interface DetectorPacket {
  canonical_hash: string;
  observed_at: string;
  collector: { name: string; version: string };
  coverage: Coverage;
}

export interface Detection {
  /** Deterministic id derived from the observed fact, stable across rescans. */
  id: string;
  fault_id: string;
  /** The `expect_as` fault-kind space of the scenario manifests. */
  kind: string;
  description: string;
  evidence: { path: string; sha256: string; packet_hash: string };
  measured: JsonRecord;
  provenance: { observed_at: string; collector: { name: string; version: string }; canonical_hash: string };
  coverage: Coverage;
  source: string;
}

export interface DetectorContext {
  facts: Fact[];
  packet: DetectorPacket;
  threshold: number;
}

export type Detector = (context: DetectorContext) => Promise<Detection[]>;

export const DEFAULT_STORAGE_THRESHOLD_PERCENT = 80;

/**
 * The machine's own documents disagree about the storage line (80% in the
 * AGENTS notes, 85% in the runbook). That contradiction is a planted fault of
 * its own, so the detector does not resolve it: the threshold is explicit and
 * is written into every finding so a reader can disagree with it.
 */
export function storageThreshold(): number {
  const raw = process.env.BROOD_STORAGE_THRESHOLD_PERCENT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STORAGE_THRESHOLD_PERCENT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`BROOD_STORAGE_THRESHOLD_PERCENT must be a number between 0 and 100, got '${raw}'`);
  }
  return value;
}

/** Read a file fact's bytes and refuse them if they no longer match the observed hash. */
export async function readFactBytes(fact: Fact): Promise<Buffer> {
  if (fact.kind !== "filesystem.file") throw new Error(`not a file fact: ${fact.path}`);
  const bytes = await fs.readFile(fact.path);
  if (sha256(bytes) !== fact.sha256) throw new Error(`fact changed since it was observed: ${fact.path}`);
  return bytes;
}

export interface DfRow {
  filesystem: string;
  size: string;
  used: string;
  avail: string;
  use_percent: number;
  mount: string;
}

/**
 * Parse a captured `df -h` by header, not by fixed columns.
 *
 * `tmpfs`/`devtmpfs` are skipped: they are volatile and not the persistent
 * filesystems the cockpit documents talk about. Rows that do not parse are
 * dropped rather than guessed at.
 */
export function parseDfH(text: string): DfRow[] {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^Filesystem\s/.test(line.trim()) && /Mounted on/.test(line));
  if (headerIndex < 0) return [];
  const header = lines[headerIndex]!.trim().split(/\s+/);
  const useIndex = header.indexOf("Use%");
  if (useIndex < 3) return [];
  const rows: DfRow[] = [];
  for (const raw of lines.slice(headerIndex + 1)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/\s+/);
    if (cells.length < useIndex + 2) continue;
    const filesystem = cells[0]!;
    if (filesystem === "tmpfs" || filesystem === "devtmpfs") continue;
    const percent = /^(\d+)%$/.exec(cells[useIndex]!);
    if (!percent) continue;
    rows.push({
      filesystem,
      size: cells[1] ?? "",
      used: cells[2] ?? "",
      avail: cells[3] ?? "",
      use_percent: Number(percent[1]),
      mount: cells.slice(useIndex + 1).join(" ")
    });
  }
  return rows;
}

/** `df` captures are named `df-h.txt`; anything else is not a storage fact. */
const DF_FACT_PATTERN = /^df(-h)?\.txt$/i;

/** One detection per persistent filesystem whose observed `Use%` reaches the threshold. */
export async function detectStorage(facts: Fact[], packet: DetectorPacket, threshold: number): Promise<Detection[]> {
  const detections: Detection[] = [];
  for (const fact of facts) {
    if (fact.kind !== "filesystem.file") continue;
    if (!DF_FACT_PATTERN.test(path.basename(fact.path))) continue;
    const rows = parseDfH((await readFactBytes(fact)).toString("utf8"));
    for (const row of rows) {
      if (row.use_percent < threshold) continue;
      detections.push({
        id: `detected-${sha256(`${fact.path}:${fact.sha256}:${row.mount}`).slice(0, 16)}`,
        fault_id: "storage.near_full",
        kind: "storage.headroom_low",
        description: `${row.filesystem} mounted at ${row.mount} is ${row.use_percent}% used (threshold ${threshold}%)`,
        evidence: { path: fact.path, sha256: fact.sha256, packet_hash: packet.canonical_hash },
        measured: { mount: row.mount, use_percent: row.use_percent, threshold },
        provenance: {
          observed_at: packet.observed_at,
          collector: packet.collector,
          canonical_hash: packet.canonical_hash
        },
        coverage: packet.coverage,
        source: fact.path
      });
    }
  }
  return detections;
}

/**
 * Registry keyed by the manifest's `expect_as`. Only `storage.headroom_low` is
 * implemented; every other declared kind is the honest `undetected` case.
 */
export const DETECTORS: Record<string, Detector> = {
  "storage.headroom_low": ({ facts, packet, threshold }) => detectStorage(facts, packet, threshold)
};
