import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256, type Coverage, type CoverageReasons } from "./lib.ts";

/**
 * The filesystem collector.
 *
 * Design rule (S1): a *fact about the machine* is never converted into a coverage
 * failure. A broken symlink is one of the planted faults, so it is collected as a
 * fact (`kind: filesystem.symlink`, `target_exists: false`) and the scan stays
 * `complete-within-scope`. Only things that could not be observed at all degrade
 * coverage, and every degradation carries a reason in `errors`/`skipped`/`problems`.
 */

export type FileFact = {
  path: string;
  kind: "filesystem.file";
  sha256: string;
  size: number;
  mode: number;
  content?: string;
};

export type SymlinkFact = {
  path: string;
  kind: "filesystem.symlink";
  sha256: string;
  size: number;
  mode: number;
  target: string;
  target_exists: boolean;
  loop: boolean;
};

export type Fact = FileFact | SymlinkFact;

export interface CollectOptions {
  /** Failpoint used by L4: pause after the first fact and wait for a signal. */
  pauseMarker?: string | undefined;
}

export interface CollectResult {
  facts: Fact[];
  coverage: Coverage;
  reasons: CoverageReasons;
}

function errnoText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.message : String(error));
  return String(code);
}

export function emptyReasons(): CoverageReasons {
  return { errors: [], skipped: [], problems: [] };
}

async function collectSymlink(linkPath: string, mode: number, relative: string, reasons: CoverageReasons): Promise<SymlinkFact> {
  let target = "";
  try {
    target = await fs.readlink(linkPath);
  } catch (error) {
    reasons.errors.push(`symlink could not be read: ${relative} (${errnoText(error)})`);
  }
  let targetExists = false;
  let loop = false;
  try {
    await fs.stat(linkPath);
    targetExists = true;
  } catch (error) {
    const code = errnoText(error);
    // A dangling link and a link loop are facts, not scan failures.
    if (code === "ELOOP") loop = true;
    else if (code !== "ENOENT") reasons.errors.push(`symlink target could not be checked: ${relative} (${code})`);
  }
  return {
    path: linkPath,
    kind: "filesystem.symlink",
    sha256: sha256(target),
    size: 0,
    mode,
    target,
    target_exists: targetExists,
    loop
  };
}

export async function collectFilesystem(scopeInput: string, options: CollectOptions = {}): Promise<CollectResult> {
  const scope = path.resolve(scopeInput);
  const facts: Fact[] = [];
  const reasons = emptyReasons();
  const pauseMarker = options.pauseMarker;
  let pauseUsed = false;
  let scopeExists = true;

  const relativeOf = (target: string): string => path.relative(scope, target) || ".";

  const visit = async (target: string): Promise<void> => {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      const code = errnoText(error);
      if (code === "ENOENT") {
        scopeExists = false;
        reasons.problems.push(`scope does not exist: ${scope}`);
      } else {
        reasons.errors.push(`path could not be read: ${relativeOf(target)} (${code})`);
      }
      return;
    }

    if (stat.isSymbolicLink()) {
      facts.push(await collectSymlink(target, stat.mode & 0o777, relativeOf(target), reasons));
      return;
    }

    if (stat.isDirectory()) {
      let entries;
      try {
        entries = await fs.readdir(target, { withFileTypes: true });
      } catch (error) {
        reasons.errors.push(`directory could not be listed: ${relativeOf(target)} (${errnoText(error)})`);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const entry of entries) await visit(path.join(target, entry.name));
      return;
    }

    if (!stat.isFile()) {
      reasons.skipped.push(`not a regular file, collected as no fact: ${relativeOf(target)}`);
      return;
    }

    let content: Buffer;
    try {
      content = await fs.readFile(target);
    } catch (error) {
      reasons.errors.push(`file could not be read: ${relativeOf(target)} (${errnoText(error)})`);
      return;
    }

    const fact: FileFact = {
      path: target,
      kind: "filesystem.file",
      sha256: sha256(content),
      size: content.byteLength,
      mode: stat.mode & 0o777
    };
    if (path.basename(target) === "scenario.yaml") {
      if (content.byteLength <= 1_048_576) fact.content = content.toString("utf8");
      else reasons.skipped.push(`inline content omitted for a file over 1 MiB: ${relativeOf(target)}`);
    }
    facts.push(fact);

    if (pauseMarker && !pauseUsed) {
      pauseUsed = true;
      await fs.mkdir(path.dirname(pauseMarker), { recursive: true });
      await fs.writeFile(pauseMarker, `${process.pid}\n`, { mode: 0o600 });
      await new Promise<void>((resolve) => {
        process.once("SIGTERM", () => resolve());
        process.once("SIGINT", () => resolve());
      });
      throw new Error("test failpoint interrupted observe cycle");
    }
  };

  await visit(scope);
  facts.sort((a, b) => a.path.localeCompare(b.path, "en"));

  const complete = reasons.errors.length === 0 && reasons.skipped.length === 0 && reasons.problems.length === 0;
  const coverage: Coverage = !scopeExists ? "unknown" : complete ? "complete-within-scope" : "partial";
  return { facts, coverage, reasons };
}
