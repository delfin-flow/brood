import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DETECTORS,
  DEFAULT_STORAGE_THRESHOLD_PERCENT,
  detectStorage,
  parseDfH,
  readFactBytes,
  storageThreshold,
  type DetectorPacket
} from "../../cli/src/detectors.ts";
import type { FileFact } from "../../cli/src/collector.ts";
import { canonicalPacketHash, sha256 } from "../../cli/src/lib.ts";

const temporary: string[] = [];

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brood-detector-"));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
  delete process.env.BROOD_STORAGE_THRESHOLD_PERCENT;
});

const DF_H = [
  "Filesystem                         Size  Used Avail Use% Mounted on",
  "/dev/mapper/vg0-root                40G   18G   22G  45% /",
  "/dev/mapper/vg0-data               100G   93G    7G  93% /srv/data",
  "tmpfs                               2G  4.0M  2.0G   1% /run",
  "devtmpfs                            1G     0  1G   0% /dev",
  "not a df row",
  ""
].join("\n");

async function dfFact(root: string, text = DF_H): Promise<{ fact: FileFact; packet: DetectorPacket }> {
  const target = path.join(root, "df-h.txt");
  const bytes = Buffer.from(text, "utf8");
  await fs.writeFile(target, bytes);
  const packetBase = {
    canonical_hash: "",
    observed_at: "2026-11-14T00:00:00.000Z",
    collector: { name: "filesystem", version: "1.0.0" },
    coverage: "complete-within-scope" as const
  };
  const packet: DetectorPacket = { ...packetBase, canonical_hash: canonicalPacketHash(packetBase) };
  return {
    fact: { path: target, kind: "filesystem.file", sha256: sha256(bytes), size: bytes.byteLength, mode: 0o644 },
    packet
  };
}

describe("L0 — df parsing", () => {
  it("parses rows by header and skips volatile or unparsable rows", () => {
    const rows = parseDfH(DF_H);
    expect(rows).toEqual([
      { filesystem: "/dev/mapper/vg0-root", size: "40G", used: "18G", avail: "22G", use_percent: 45, mount: "/" },
      { filesystem: "/dev/mapper/vg0-data", size: "100G", used: "93G", avail: "7G", use_percent: 93, mount: "/srv/data" }
    ]);
  });

  it("returns nothing when the capture has no df header", () => {
    expect(parseDfH("this is not a df capture\n")).toEqual([]);
  });
});

describe("L0 — storage detector", () => {
  it("detects only a crossing filesystem and cites the observed fact", async () => {
    const root = await workspace();
    const { fact, packet } = await dfFact(root);

    const detections = await detectStorage([fact], packet, DEFAULT_STORAGE_THRESHOLD_PERCENT);

    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      fault_id: "storage.near_full",
      kind: "storage.headroom_low",
      evidence: { path: fact.path, sha256: fact.sha256, packet_hash: packet.canonical_hash },
      measured: { mount: "/srv/data", use_percent: 93, threshold: 80 },
      coverage: "complete-within-scope",
      source: fact.path
    });
    expect(detections[0]!.id).toMatch(/^detected-[a-f0-9]{16}$/);
  });

  it("produces the same id for the same fact and mount across scans", async () => {
    const root = await workspace();
    const { fact, packet } = await dfFact(root);
    const first = await detectStorage([fact], packet, 80);
    const second = await detectStorage([fact], packet, 80);
    expect(first.map((item) => item.id)).toEqual(second.map((item) => item.id));
  });

  it("stays silent below the threshold and honours an explicit one", async () => {
    const below = await workspace();
    const belowFact = await dfFact(below, DF_H.replace("93G    7G  93%", "57G   43G  57%"));
    expect(await detectStorage([belowFact.fact], belowFact.packet, 80)).toEqual([]);

    const above = await workspace();
    const aboveFact = await dfFact(above);
    expect(await detectStorage([aboveFact.fact], aboveFact.packet, 90)).toHaveLength(1);
    expect(await detectStorage([aboveFact.fact], aboveFact.packet, 95)).toEqual([]);
  });

  it("refuses a fact whose bytes changed after it was observed", async () => {
    const root = await workspace();
    const { fact } = await dfFact(root);
    await fs.writeFile(fact.path, DF_H.replace("93G    7G  93%", "10G   90G  10%"));
    await expect(readFactBytes(fact)).rejects.toThrow(/fact changed since it was observed/);
  });

  it("registers only the detector that exists", () => {
    expect(Object.keys(DETECTORS)).toEqual(["storage.headroom_low"]);
  });
});

describe("L0 — storage threshold is explicit, not resolved from the machine's documents", () => {
  it("defaults to 80 and reads the environment override", () => {
    delete process.env.BROOD_STORAGE_THRESHOLD_PERCENT;
    expect(storageThreshold()).toBe(80);
    process.env.BROOD_STORAGE_THRESHOLD_PERCENT = "85";
    expect(storageThreshold()).toBe(85);
  });

  it("fails loudly on a malformed threshold", () => {
    process.env.BROOD_STORAGE_THRESHOLD_PERCENT = "lots";
    expect(() => storageThreshold()).toThrow(/between 0 and 100/);
    process.env.BROOD_STORAGE_THRESHOLD_PERCENT = "101";
    expect(() => storageThreshold()).toThrow(/between 0 and 100/);
  });
});
