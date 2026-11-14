import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectFilesystem } from "../../cli/src/collector.ts";
import { canonicalPacketHash, validatePacket } from "../../cli/src/lib.ts";

const temporary: string[] = [];

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brood-collector-"));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("L0 — filesystem collector: a fact is never a coverage failure", () => {
  it("records a broken symlink as a fact and keeps the scan complete", async () => {
    const root = await workspace();
    await fs.writeFile(path.join(root, "notes.txt"), "hello\n");
    await fs.symlink("missing/import.py", path.join(root, "legacy-import"));

    const result = await collectFilesystem(root);

    expect(result.coverage).toBe("complete-within-scope");
    expect(result.reasons).toEqual({ errors: [], skipped: [], problems: [] });
    const link = result.facts.find((fact) => fact.path === path.join(root, "legacy-import"));
    expect(link).toMatchObject({
      kind: "filesystem.symlink",
      target: "missing/import.py",
      target_exists: false,
      loop: false
    });
    const file = result.facts.find((fact) => fact.path === path.join(root, "notes.txt"));
    expect(file).toMatchObject({ kind: "filesystem.file", size: 6 });
  });

  it("records a symlink loop as a fact, not as a scan error", async () => {
    const root = await workspace();
    await fs.symlink("b", path.join(root, "a"));
    await fs.symlink("a", path.join(root, "b"));

    const result = await collectFilesystem(root);

    expect(result.coverage).toBe("complete-within-scope");
    expect(result.facts.filter((fact) => fact.kind === "filesystem.symlink")).toHaveLength(2);
    expect(result.facts.find((fact) => fact.path === path.join(root, "a"))).toMatchObject({
      loop: true,
      target_exists: false
    });
  });

  it("does not follow symlinks out of the scope", async () => {
    const outside = await workspace();
    await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
    const root = await workspace();
    await fs.symlink(outside, path.join(root, "escape"));

    const result = await collectFilesystem(root);

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ kind: "filesystem.symlink", target: outside, target_exists: true });
    expect(result.facts.some((fact) => fact.path.endsWith("secret.txt"))).toBe(false);
  });

  it("degrades coverage with a reason when a directory cannot be listed", async () => {
    const root = await workspace();
    const locked = path.join(root, "locked");
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root ignores the mode; nothing to observe here
      const result = await collectFilesystem(root);
      expect(result.coverage).toBe("partial");
      expect(result.reasons.errors.join("\n")).toMatch(/locked/);
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("reports an absent scope as unknown, with the reason on the packet", async () => {
    const root = await workspace();
    const result = await collectFilesystem(path.join(root, "not-there"));
    expect(result.coverage).toBe("unknown");
    expect(result.reasons.problems.join("\n")).toMatch(/does not exist/);
    const packet = {
      schema_version: 1,
      kind: "filesystem.snapshot",
      scope: path.join(root, "not-there"),
      coverage: result.coverage,
      observed_at: new Date().toISOString(),
      collector: { name: "filesystem", version: "1.0.0" },
      facts: result.facts,
      ...result.reasons
    };
    expect(validatePacket({ ...packet, canonical_hash: canonicalPacketHash(packet) })).toBeUndefined();
  });
});

describe("L0 — coverage honesty contract", () => {
  function packet(coverage: string, extra: Record<string, unknown> = {}) {
    const base = {
      schema_version: 1,
      kind: "filesystem.snapshot",
      scope: "/srv/scenario",
      coverage,
      observed_at: "2026-11-13T12:00:00.000Z",
      collector: { name: "filesystem", version: "1.0.0" },
      facts: [],
      ...extra
    };
    return { ...base, canonical_hash: canonicalPacketHash(base) };
  }

  it("refuses a non-complete coverage label with no reason", () => {
    expect(() => validatePacket(packet("partial"))).toThrow(/carries no reason/);
    expect(() => validatePacket(packet("unsupported"))).toThrow(/carries no reason/);
    expect(() => validatePacket(packet("partial", { errors: [], skipped: [], problems: [] }))).toThrow(/carries no reason/);
  });

  it("accepts a non-complete coverage label that carries a reason", () => {
    expect(validatePacket(packet("partial", { errors: ["directory could not be listed: locked"] }))).toBeUndefined();
    expect(validatePacket(packet("unsupported", { problems: ["collector 'filesystem' is unavailable"] }))).toBeUndefined();
    expect(validatePacket(packet("stale", { skipped: ["scope was not re-observed"] }))).toBeUndefined();
  });

  it("rejects malformed reason lists", () => {
    expect(() => validatePacket(packet("partial", { errors: "not-a-list" }))).toThrow(/must be an array/);
    expect(() => validatePacket(packet("partial", { errors: [""] }))).toThrow(/non-empty/);
  });

  it("refuses an unobserved fact shape", () => {
    const broken = [{ path: "/srv/scenario/link", kind: "filesystem.symlink", sha256: "a".repeat(64), size: 0, mode: 0o777 }];
    expect(() => validatePacket(packet("complete-within-scope", { facts: broken }))).toThrow(/target is required/);
    const noTargetState = [{ ...broken[0], target: "missing", loop: false }];
    expect(() => validatePacket(packet("complete-within-scope", { facts: noTargetState }))).toThrow(/target_exists is required/);
    const undeclared = [{ path: "/srv/scenario/x", kind: "filesystem.magic", sha256: "a".repeat(64), size: 0, mode: 0o644 }];
    expect(() => validatePacket(packet("complete-within-scope", { facts: undeclared }))).toThrow(/kind is undeclared/);
  });
});
