import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `materialize.sh` re-applies the two things a git checkout loses. Its failure mode matters:
 * a `chmod 000` that silently does not apply would leave a planted fault readable, and only
 * the hostile-only integration guard would ever notice. The script must fail loudly instead.
 */
const script = path.resolve(import.meta.dirname, "../../../fixtures/materialize.sh");

describe("L0 — fixture materialisation honesty", () => {
  it("fails loudly when a declared hostile fault cannot be materialised", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brood-materialize-"));
    try {
      // A hostile manifest whose planted directories are absent: the modes cannot be applied.
      await fs.mkdir(path.join(root, "hostile"), { recursive: true });
      await fs.writeFile(path.join(root, "hostile", "scenario.yaml"), "name: hostile\nfaults: []\n");
      const result = spawnSync("bash", [script, "--root", root, "hostile"], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/could not materialise the declared faults/);
      expect(result.stderr).toMatch(/home\/keeper\/locked \(missing\)/);
      expect(result.stderr).toMatch(/srv\/isolated\/unreadable \(missing\)/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("is idempotent on a scenario that materialises cleanly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brood-materialize-"));
    try {
      await fs.mkdir(path.join(root, "clean", "srv"), { recursive: true });
      await fs.writeFile(path.join(root, "clean", "scenario.yaml"), "name: clean\nfaults: []\n");
      for (const attempt of [1, 2]) {
        const result = spawnSync("bash", [script, "--root", root, "clean"], { encoding: "utf8" });
        expect(result.status, `attempt ${attempt}: ${result.stderr}`).toBe(0);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
