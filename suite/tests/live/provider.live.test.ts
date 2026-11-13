import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { canonicalPacketHash, sha256 } from "../../cli/src/lib.ts";

const enabled = process.env.BROOD_LIVE_PROVIDER_CONFIRM === "1";

describe.skipIf(!enabled)("manual live provider contract", () => {
  it("requires credentials and rejects provider output that violates the fact contract", () => {
    if (!process.env.BROOD_PROVIDER_API_KEY || !process.env.BROOD_PROVIDER_URL) {
      throw new Error("test:live requires BROOD_PROVIDER_API_KEY and BROOD_PROVIDER_URL");
    }
    const base = {
      schema_version: 1,
      kind: "filesystem.snapshot",
      scope: "/live-contract",
      coverage: "complete-within-scope",
      observed_at: new Date().toISOString(),
      collector: { name: "filesystem", version: "1.0.0" },
      facts: [{ path: "/live-contract/scenario.yaml", sha256: sha256("faults: []\n"), size: 10, mode: 0o600, content: "faults: []\n" }]
    };
    const packet = { ...base, canonical_hash: canonicalPacketHash(base) };
    const result = spawnSync("node", ["--import", "tsx", "cli/src/index.ts", "assess"], {
      input: JSON.stringify([packet]),
      encoding: "utf8",
      env: { ...process.env, BROOD_PROVIDER: "real" },
      timeout: 25_000
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).findings).toEqual([]);
  });
});
