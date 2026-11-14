import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The interruption failpoint is the only thing that makes L4 meaningful. It must hold
 * the process alive until a signal arrives: a signal listener alone does not keep the
 * event loop alive, and Node exits 13 ("unsettled top-level await") the moment the
 * marker is written — which made the kill in L4 target a process that was already gone.
 */

const temporary: string[] = [];

afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function waitForMarker(marker: string, child: { exitCode: number | null }, deadlineMs = 10_000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`observe exited (${child.exitCode}) before reaching the failpoint`);
    try {
      const text = (await fs.readFile(marker, "utf8")).trim();
      if (text) return text;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the failpoint never wrote its marker");
}

describe("L0 — observe interruption failpoint", () => {
  it("holds the process until a signal arrives, then fails loudly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brood-failpoint-"));
    temporary.push(root);
    await fs.writeFile(path.join(root, "a.txt"), "a\n");
    const marker = path.join(root, "state", "paused.marker");

    const child = spawn(
      process.execPath,
      ["cli/src/index.ts", "observe", "--scope", root],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: { ...process.env, BROOD_TEST_PAUSE_MARKER: marker, BROOD_STATE_DIR: path.join(root, "state") },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));

    const pid = Number(await waitForMarker(marker, child));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    // Alive is the point: a pause that has already ended cannot be interrupted.
    expect(() => process.kill(pid, 0)).not.toThrow();

    const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    process.kill(pid, "SIGTERM");

    expect(await exited).toBe(2);
    const output = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    expect(output.status).toBe("failed");
    expect(output.error).toMatch(/failpoint interrupted observe cycle/);
  }, 30_000);
});
