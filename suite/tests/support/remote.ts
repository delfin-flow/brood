import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parseScenarioFaults, canonicalStringify, sha256, type DeclaredFault } from "../../cli/src/lib.ts";

/** Where the harness mounts the materialised scenario inside the container. */
export const REMOTE_SCENARIO_ROOT = "/srv/scenario";
/** Default scenario: the fully declared business machine. */
export const DEFAULT_SCENARIO = "dirty-business";

/** Scenario mounted by this run (readable at collection time, before any hook runs). */
export function requestedScenario(): string {
  return (process.env.BROOD_SCENARIO ?? "").trim() || DEFAULT_SCENARIO;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BroodEnvironment {
  containerId: string;
  containerName: string;
  /** Host path of the materialised scenario mounted at `/srv/scenario`. */
  scenarioDir: string;
  /** Throwaway directory that holds `scenarioDir`; removed at teardown. */
  workingRoot: string;
  /** The fixture tree as checked out (`BROOD_SCENARIO_DIR`) — never touched by a run. */
  fixturesRoot: string;
  /** Scenario name from `BROOD_SCENARIO` (default `dirty-business`). */
  scenarioName: string;
  sshKey: string;
  secret: string;
  remoteCli: string;
  stateDir: string;
  mutableRoot: string;
  /** Harness-provisioned state that every remote CLI call must see. */
  remoteEnv: Record<string, string>;
}

let environment: BroodEnvironment | undefined;
let scenarioHashBefore: string | undefined;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function expandHome(value: string): string {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function runLocal(binary: string, args: string[]): CommandResult {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000 });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

function sshArgs(remoteCommand: string): string[] {
  if (!environment) throw new Error("Brood test environment has not been started");
  return [
    "-i", environment.sshKey,
    "-p", "2222",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "brood@127.0.0.1",
    `sh -lc ${shellQuote(remoteCommand)}`
  ];
}

export function spawnRemote(command: string, input?: string): { child: ChildProcess; result: Promise<CommandResult> } {
  const child = spawn("ssh", sshArgs(command), { stdio: ["pipe", "pipe", "pipe"] });
  const chunksOut: Buffer[] = [];
  const chunksErr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunksOut.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunksErr.push(chunk));
  const result = new Promise<CommandResult>((resolve) => {
    child.on("error", (error) => resolve({ code: 1, stdout: Buffer.concat(chunksOut).toString(), stderr: error.message }));
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(chunksOut).toString("utf8"),
      stderr: Buffer.concat(chunksErr).toString("utf8")
    }));
  });
  if (input !== undefined) child.stdin?.end(input);
  else child.stdin?.end();
  return { child, result };
}

export async function remote(command: string, input?: string): Promise<CommandResult> {
  return spawnRemote(command, input).result;
}

export async function remoteJson<T = any>(command: string, input?: unknown): Promise<T> {
  const result = await remote(command, input === undefined ? undefined : JSON.stringify(input));
  if (result.code !== 0) throw new Error(`remote command failed (${result.code}): ${result.stdout}\n${result.stderr}`);
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error(`remote command did not return JSON: ${result.stdout}\n${result.stderr}`); }
}

export function cli(command: string): string {
  if (!environment) throw new Error("Brood test environment has not been started");
  return `${withRemoteEnv(environment.remoteEnv, `${shellQuote(environment.remoteCli)} ${command}`)}`;
}

export function withRemoteEnv(assignments: Record<string, string>, command: string): string {
  const envText = Object.entries(assignments).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  return `${envText} ${command}`;
}

export function requireEnvironment(): BroodEnvironment {
  if (!environment) throw new Error("Brood test environment has not been started");
  return environment;
}

async function snapshotDirectory(root: string): Promise<string> {
  const entries: Array<{ path: string; type: string; mode: number; sha256: string }> = [];
  const visit = async (target: string): Promise<void> => {
    const stats = await fs.lstat(target);
    const relative = path.relative(root, target).split(path.sep).join("/") || ".";
    if (stats.isSymbolicLink()) {
      entries.push({ path: relative, type: "symlink", mode: stats.mode & 0o777, sha256: sha256(await fs.readlink(target)) });
      return;
    }
    if (stats.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode: stats.mode & 0o777, sha256: sha256("") });
      let children: string[];
      try {
        children = (await fs.readdir(target)).sort();
      } catch (error) {
        // `hostile` plants mode-000 directories. A snapshot cannot read below one, so it
        // records the barrier (with its mode) instead of failing or pretending it is empty;
        // a mode change on the barrier itself still shows up in the comparison.
        if ((error as NodeJS.ErrnoException).code !== "EACCES" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        entries.push({ path: relative, type: "directory-unreadable", mode: stats.mode & 0o777, sha256: sha256("unreadable") });
        return;
      }
      for (const child of children) await visit(path.join(target, child));
      return;
    }
    if (stats.isFile()) {
      entries.push({ path: relative, type: "file", mode: stats.mode & 0o777, sha256: sha256(await fs.readFile(target)) });
    }
  };
  await visit(root);
  return sha256(canonicalStringify(entries));
}

/**
 * `hostile` plants mode-000 directories. They hold no scenario manifest, so a walk that
 * cannot enter one has seen everything it needs — the mode itself is the fault.
 */
async function scenarioTreeChildren(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return [];
    throw error;
  }
}

async function listDeclaredFaultKeys(root: string): Promise<string[]> {
  const keys: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const children = (await scenarioTreeChildren(directory)).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const target = path.join(directory, child.name);
      if (child.isDirectory()) await visit(target);
      else if (child.isFile() && child.name === "scenario.yaml") {
        const content = await fs.readFile(target, "utf8");
        const relative = path.relative(root, target).split(path.sep).join("/");
        for (const fault of parseScenarioFaults(content)) keys.push(`${relative}|${fault.id}`);
      }
    }
  };
  await visit(root);
  return keys.sort();
}

export async function declaredFaultKeys(): Promise<string[]> {
  return listDeclaredFaultKeys(requireEnvironment().scenarioDir);
}

async function listDeclaredFaults(root: string): Promise<Array<DeclaredFault & { scenario: string }>> {
  const records: Array<DeclaredFault & { scenario: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const children = (await scenarioTreeChildren(directory)).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const child of children) {
      const target = path.join(directory, child.name);
      if (child.isDirectory()) await visit(target);
      else if (child.isFile() && child.name === "scenario.yaml") {
        const content = await fs.readFile(target, "utf8");
        const relative = path.relative(root, target).split(path.sep).join("/");
        for (const fault of parseScenarioFaults(content)) records.push({ ...fault, scenario: relative });
      }
    }
  };
  await visit(root);
  return records.sort((a, b) => `${a.scenario}|${a.id}`.localeCompare(`${b.scenario}|${b.id}`, "en"));
}

export async function declaredFaults(): Promise<Array<DeclaredFault & { scenario: string }>> {
  return listDeclaredFaults(requireEnvironment().scenarioDir);
}

/**
 * Declarations that apply to the mounted scenario, following its `extends:` chain.
 * A derived scenario (e.g. `hostile extends dirty-business`) keeps the inherited faults
 * "declared in their source manifests", so a cross-check that only walked the mount
 * could not tell an invented kind from an inherited one. Reading the chain in the fixture
 * tree (not the mount) keeps that honest without adding anything the fixtures do not say.
 */
export async function declaredFaultChain(): Promise<Array<DeclaredFault & { scenario: string }>> {
  const environment = requireEnvironment();
  const records: Array<DeclaredFault & { scenario: string }> = [];
  const seen = new Set<string>();
  let name: string | null = environment.scenarioName;
  while (name && !seen.has(name)) {
    seen.add(name);
    let content: string;
    try {
      content = await fs.readFile(path.join(environment.fixturesRoot, name, "scenario.yaml"), "utf8");
    } catch {
      break;
    }
    for (const fault of parseScenarioFaults(content)) records.push({ ...fault, scenario: name });
    const parent = /^extends:[ \t]*(\S+)[ \t]*$/m.exec(content)?.[1];
    name = parent && parent !== "null" ? parent : null;
  }
  return records;
}

/** `expected_coverage` as declared by the mounted scenario's manifest. */
export async function declaredExpectedCoverage(): Promise<string> {
  const content = await fs.readFile(path.join(requireEnvironment().scenarioDir, "scenario.yaml"), "utf8");
  return /^expected_coverage:[ \t]*(\S+)[ \t]*$/m.exec(content)?.[1] ?? "unknown";
}

export async function startBroodEnvironment(): Promise<void> {
  const fixturesRoot = path.resolve(expandHome(process.env.BROOD_SCENARIO_DIR ?? ""));
  const scenarioName = requestedScenario();
  const sshKey = path.resolve(expandHome(process.env.BROOD_SSH_KEY ?? "~/.ssh/id_ed25519"));
  const image = process.env.BROOD_IMAGE;
  if (!image) throw new Error("L2-L4 require BROOD_IMAGE, the part-1 image with broodctl installed");
  if (!process.env.BROOD_SCENARIO_DIR) throw new Error("L2-L4 require BROOD_SCENARIO_DIR pointing to the part-2 fixtures tree");
  await fs.access(fixturesRoot);
  await fs.access(sshKey);

  // One scenario per run, materialised in a throwaway copy. `materialize.sh` renames
  // `.git.fixture` back to `.git` and re-applies the `hostile` modes — both are lost to a
  // git checkout — and it must never run against the checkout the developer is working in.
  const sourceDir = path.join(fixturesRoot, scenarioName);
  const sourceStats = await fs.stat(sourceDir).catch(() => undefined);
  if (!sourceStats?.isDirectory()) {
    throw new Error(`BROOD_SCENARIO must name a scenario directory under ${fixturesRoot}: ${scenarioName}`);
  }
  const workingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brood-vitest-scenario-"));
  const scenarioDir = path.join(workingRoot, scenarioName);
  const copied = runLocal("cp", ["-a", "--", sourceDir, scenarioDir]);
  if (copied.code !== 0) {
    runLocal("rm", ["-rf", workingRoot]);
    throw new Error(`could not copy scenario ${scenarioName} to ${workingRoot}: ${copied.stderr || copied.stdout}`);
  }
  const materialize = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "materialize.sh");
  const materialised = runLocal("bash", [materialize, "--root", workingRoot, scenarioName]);
  if (materialised.code !== 0) {
    runLocal("chmod", ["-R", "u+rwX", workingRoot]);
    runLocal("rm", ["-rf", workingRoot]);
    throw new Error(`could not materialise scenario ${scenarioName}: ${materialised.stderr || materialised.stdout}`);
  }

  const containerName = `brood-vitest-${process.pid}-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  const stateDir = "/tmp/brood-vitest-state";
  const mutableRoot = "/tmp/brood-vitest-mutable";
  environment = {
    containerId: "",
    containerName,
    scenarioDir,
    workingRoot,
    fixturesRoot,
    scenarioName,
    sshKey,
    secret,
    remoteCli: process.env.BROOD_REMOTE_CLI ?? "/usr/local/bin/broodctl",
    stateDir,
    mutableRoot,
    // `docker run --env` reaches PID 1 only; an SSH session gets a fresh environment.
    // The harness therefore passes its provisioned state on every remote command.
    remoteEnv: {
      BROOD_STATE_DIR: stateDir,
      BROOD_MUTABLE_ROOT: mutableRoot,
      BROOD_APPROVAL_SECRET: secret
    }
  };
  try {
    scenarioHashBefore = await snapshotDirectory(scenarioDir);
  } catch (error) {
    await stopBroodEnvironment();
    throw error;
  }
  const args = [
    "run", "--detach", "--name", containerName,
    "--publish", "127.0.0.1:2222:22",
    "--volume", `${scenarioDir}:/srv/scenario:ro`,
    "--env", `BROOD_STATE_DIR=${stateDir}`,
    "--env", `BROOD_MUTABLE_ROOT=${mutableRoot}`,
    "--env", `BROOD_APPROVAL_SECRET=${secret}`,
    image
  ];
  const started = runLocal("docker", args);
  if (started.code !== 0) {
    const cleanup = runLocal("docker", ["rm", "--force", containerName]);
    const inspect = runLocal("docker", ["inspect", containerName]);
    let copyCleanup = "";
    try { await stopBroodEnvironment(); } catch (error) { copyCleanup = (error as Error).message; }
    if (inspect.code === 0) throw new Error(`container leak detected after failed startup: ${containerName}`);
    if (cleanup.code !== 0 && !/no such container|not found/i.test(cleanup.stderr + cleanup.stdout)) {
      throw new Error(`startup failed and cleanup could not be verified: ${cleanup.stderr || cleanup.stdout}`);
    }
    throw new Error(`could not start part-1 image with Docker: ${started.stderr || started.stdout}${copyCleanup ? ` (${copyCleanup})` : ""}`);
  }
  environment.containerId = started.stdout.trim();
  try {
    await waitForSsh();
    const cliCheck = await remote(`command -v ${shellQuote(requireEnvironment().remoteCli)}`);
    if (cliCheck.code !== 0) throw new Error(`broodctl is not installed in the image at ${requireEnvironment().remoteCli}`);
    const init = await remote(`mkdir -p ${shellQuote(stateDir)} ${shellQuote(mutableRoot)} && printf 'before\\n' > ${shellQuote(`${mutableRoot}/proof.txt`)}`);
    if (init.code !== 0) throw new Error(`could not initialise remote test paths: ${init.stderr}`);
  } catch (error) {
    await stopBroodEnvironment();
    throw error;
  }
}

async function waitForSsh(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "no SSH response";
  while (Date.now() < deadline) {
    const result = await remote("true");
    if (result.code === 0) return;
    last = result.stderr || result.stdout || `ssh exit ${result.code}`;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`SSH readiness condition was not met on 127.0.0.1:2222: ${last}`);
}

export async function stopBroodEnvironment(): Promise<void> {
  const current = environment;
  environment = undefined;
  if (!current) return;
  const failures: string[] = [];
  if (current.containerId) {
    const id = current.containerId;
    const removed = runLocal("docker", ["rm", "--force", id]);
    if (removed.code !== 0) failures.push(removed.stderr || removed.stdout || `docker rm failed for ${id}`);
    const inspected = runLocal("docker", ["inspect", id]);
    if (inspected.code === 0) failures.push(`container leak detected: ${id} still exists`);
  }
  if (current.workingRoot) {
    // The materialised copy can contain mode-000 directories; `rm -rf` needs traversal.
    runLocal("chmod", ["-R", "u+rwX", current.workingRoot]);
    const removed = runLocal("rm", ["-rf", current.workingRoot]);
    if (removed.code !== 0) failures.push(`scenario copy cleanup failed: ${removed.stderr || removed.stdout}`);
    else if (existsSync(current.workingRoot)) failures.push(`scenario copy leak detected: ${current.workingRoot} still exists`);
  }
  if (failures.length) throw new Error(failures.join("; "));
}

export async function scenarioSnapshotBefore(): Promise<string> {
  if (!scenarioHashBefore) throw new Error("scenario snapshot was not captured");
  return scenarioHashBefore;
}

export async function scenarioSnapshotAfter(): Promise<string> {
  return snapshotDirectory(requireEnvironment().scenarioDir);
}

export function parseJsonOutput<T>(result: CommandResult): T {
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error(`expected JSON output, got: ${result.stdout}\n${result.stderr}`); }
}
