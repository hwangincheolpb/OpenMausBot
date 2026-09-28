import type { ModelSelection, ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { classifyError } from "./drivers/retry.ts";

/** Allow only availability failures, never a provider's policy decision. */
export function modelFailoverReason(text: string): string | null {
  // Cancellation and safety always win over a nearby HTTP status.
  if (/\b(?:interrupt(?:ed)?|cancel(?:led|ed)|denied|refusal|refused|safety|policy|policies|provider_safety|budget[_ -](?:exceeded|limit)|permission[_ -](?:denied|required)|content[_ -](?:policy|filter)|safety[_ -]policy|policy[_ -]violation)\b/i.test(text)) return null;
  const classified = classifyError({ text });
  if (classified.reason === "provider_safety") return null;
  if (/\b(?:auth_required|invalid_credentials)\b/.test(text)) return "auth";
  if (/\b(?:inactive_subscription|quota_or_region_restriction)\b/.test(text)) return "quota";
  if (/\b(?:upstream_outage|model_catalog_outage)\b/.test(text)) return "server_error";
  if (/\b(?:insufficient_quota|usage_limit_reached|quota_exceeded)\b|\b(?:you(?:['’]ve| have) hit your limit|usage limit (?:reached|exceeded))\b/i.test(text)) return "quota";
  if (/\b(?:rate_limit_error|rate_limit_exceeded|too_many_requests)\b/i.test(text)) return "rate_limited";
  if (/\boverloaded_error\b/i.test(text)) return "overloaded";
  if (classified.transient || ["auth", "quota", "unknown_model"].includes(classified.reason)) return classified.reason;
  if (/\bmodel\b.{0,60}\b(?:unavailable|not available|not supported|does not exist)\b/i.test(text)) return "unknown_model";
  return null;
}

export class ModelFailoverAttempt {
  unsafe = false;
  buffered: RuntimeEvent[] = [];
  errors: string[] = [];

  observe(event: RuntimeEvent): "pass" | "hold" | "retry" {
    const text = event.type === "runtime.error" ? event.message
      : event.synthetic && event.type === "content.delta" ? event.delta
      : event.synthetic && event.type === "item.completed" && event.itemType === "assistant_text" ? event.text : null;
    if (text !== null) {
      this.errors.push(text.slice(0, 2_000));
      if (!modelFailoverReason(text)) this.unsafe = true;
      if (!this.unsafe) {
        // Bounded even if a broken provider floods diagnostics.
        if (this.buffered.length < 32) { this.buffered.push(event); return "hold"; }
        this.unsafe = true;
      }
    }
    if ((event.type === "content.delta" && !event.synthetic && Boolean(event.delta.trim())) ||
      (event.type === "item.completed" && !event.synthetic &&
        (event.itemType === "assistant_image" || (event.itemType === "assistant_text" && Boolean(event.text.trim())))) ||
      ((event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") && event.itemType === "tool") ||
      ((event.type === "item.started" || event.type === "item.updated") && event.itemType === "reasoning") ||
      event.type === "request.opened" || event.type === "request.resolved") this.unsafe = true;
    if (event.type === "turn.completed" && !event.ok && !this.unsafe && !event.denials?.length &&
      modelFailoverReason([...this.errors, event.stopReason ?? ""].join("\n"))) return "retry";
    return "pass";
  }

  takeBuffered(): RuntimeEvent[] {
    return this.buffered.splice(0);
  }
}

export const selectionKey = (selection: ModelSelection) => `${selection.instanceId}\0${selection.model}`;

/** Do not infer permission to use a provider from mere installation. */
export async function availableFailoverCandidate(args: {
  candidates: ModelSelection[];
  visited: ReadonlySet<string>;
  get: (id: string) => ProviderInstance | null;
  excluded: (id: string) => boolean;
  failedUntil: ReadonlyMap<string, number>;
  active: () => boolean;
  needsImages?: boolean;
}): Promise<ModelSelection | null> {
  for (const candidate of args.candidates) {
    if (!args.active()) return null;
    const key = selectionKey(candidate);
    const instance = args.get(candidate.instanceId);
    const instanceKey = selectionKey({ instanceId: candidate.instanceId, model: "*" });
    if (args.visited.has(key) || args.visited.has(instanceKey) ||
      (args.failedUntil.get(key) ?? 0) > Date.now() || (args.failedUntil.get(instanceKey) ?? 0) > Date.now() ||
      args.excluded(candidate.instanceId) || !instance?.enabled || instance.driverKind === "boxAgent" ||
      (args.needsImages && !instance.adapter.capabilities.images) ||
      (instance.models.default !== candidate.model && !instance.models.options.some(option => option.id === candidate.model))) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const snapshot = await Promise.race([
        instance.snapshot(),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2_000); timer.unref?.(); }),
      ]);
      if (args.active() && snapshot?.state === "available" && snapshot.authenticated === true &&
        args.get(candidate.instanceId) === instance && !args.excluded(candidate.instanceId)) {
        return { instanceId: candidate.instanceId, model: candidate.model };
      }
    } catch { /* An uncertain account is not a fallback candidate. */ }
    finally { if (timer) clearTimeout(timer); }
  }
  return null;
}
