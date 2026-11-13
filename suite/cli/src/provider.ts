import { setTimeout as delay } from "node:timers/promises";
import type { JsonRecord } from "./lib.ts";

export type ProviderOperation = "assess" | "propose";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseScript(): Record<string, unknown> {
  const source = process.env.BROOD_FAKE_PROVIDER_SCRIPT;
  if (!source) return {};
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) throw new Error("BROOD_FAKE_PROVIDER_SCRIPT must be an object keyed by operation name");
  return parsed;
}

export async function runProvider<T>(
  operation: ProviderOperation,
  input: unknown,
  fakeDefault: (input: unknown) => T
): Promise<unknown> {
  const selected = process.env.BROOD_PROVIDER ?? "fake";
  if (selected === "fake") {
    const script = parseScript();
    const operationScript = script[operation];
    if (operationScript === undefined) return fakeDefault(input);
    if (!isRecord(operationScript)) throw new Error(`fake provider script for ${operation} must be an object`);
    switch (operationScript.mode) {
      case "refuse":
        throw new Error(typeof operationScript.message === "string" ? operationScript.message : `fake provider refused ${operation}`);
      case "timeout": {
        const ms = Number(operationScript.milliseconds ?? 30_000);
        await Promise.race([
          delay(Math.min(Math.max(ms, 0), 60_000)),
          delay(10_000).then(() => { throw new Error(`fake provider ${operation} timed out`); })
        ]);
        throw new Error(`fake provider ${operation} timed out`);
      }
      case "malformed":
        return operationScript.value ?? "malformed provider output";
      case "response":
        return operationScript.value;
      default:
        throw new Error(`unknown fake provider script mode for ${operation}`);
    }
  }
  if (selected !== "real") throw new Error(`unsupported BROOD_PROVIDER: ${selected}`);

  const apiKey = process.env.BROOD_PROVIDER_API_KEY;
  if (!apiKey) throw new Error("real provider refused: BROOD_PROVIDER_API_KEY is required");
  const endpoint = process.env.BROOD_PROVIDER_URL;
  if (!endpoint) throw new Error("not implemented: set BROOD_PROVIDER_URL for the real provider adapter");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ operation, input }),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`real provider returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (isRecord(body) && "result" in body) return body.result;
  return body;
}
