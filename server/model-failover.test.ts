import { describe, expect, it, vi } from "vitest";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { availableFailoverCandidate, ModelFailoverAttempt, modelFailoverReason, selectionKey } from "./model-failover.ts";
import { parseConfigPatch, parseStoredConfig } from "./config.ts";

const event = (value: Record<string, unknown>): RuntimeEvent => ({
  eventId: "event", provider: "claude", threadId: "thread", turnId: "turn", createdAt: "2026-09-23", ...value,
}) as RuntimeEvent;
const failure = event({ type: "turn.completed", ok: false, stopReason: "auth_required" });

describe("model failover policy", () => {
  it.each(["401 Invalid API key", "auth_required", "429 too many requests", "quota exceeded", "503 service unavailable", "model not found", "upstream_outage",
    "You've hit your limit", "You’ve hit your limit", "usage limit reached", "rate_limit_error", "usage_limit_reached", "insufficient_quota", "overloaded_error"])("allows availability failure %s", text => {
    expect(modelFailoverReason(text)).not.toBeNull();
  });
  it.each(["bad request", "permission_required", "cancelled", "429 interrupted", "401 provider_safety", "429 safety_policy_violation", "503 blocked by our safety systems", "429 budget_limit", "400 malformed", "403 violates organization policy", "rate_limit_error content_filter"])("rejects unsafe or unrelated failure %s", text => {
    expect(modelFailoverReason(text)).toBeNull();
  });
  it("requires explicit opt-in and rejects unbounded candidate/attempt lists", () => {
    expect(parseStoredConfig({}).modelFailover).toBeUndefined();
    const policy = { enabled: true, maxAttempts: 2, candidates: [{ instanceId: "codex", model: "model" }] };
    expect(parseConfigPatch({ modelFailover: policy }).modelFailover).toEqual(policy);
    expect(() => parseConfigPatch({ modelFailover: { ...policy, maxAttempts: 4 } })).toThrow();
    expect(() => parseConfigPatch({ modelFailover: { ...policy, candidates: Array(9).fill(policy.candidates[0]) } })).toThrow();
  });
  it("holds API diagnostics until the logical turn decides its final result", () => {
    const attempt = new ModelFailoverAttempt();
    expect(attempt.observe(event({ type: "runtime.error", message: "401 Invalid API key" }))).toBe("hold");
    expect(attempt.observe(failure)).toBe("retry");
    expect(attempt.takeBuffered()).toHaveLength(1);
    expect(attempt.takeBuffered()).toHaveLength(0);
  });
  it.each([
    { type: "content.delta", delta: "working", streamKind: "assistant_text" },
    { type: "content.delta", delta: "thinking", streamKind: "reasoning_text" },
    { type: "item.completed", itemType: "assistant_text", text: "partial answer" },
    { type: "item.completed", itemType: "assistant_image", data: "image" },
    { type: "item.started", itemType: "tool", title: "Bash" },
    { type: "item.updated", itemType: "tool" },
    { type: "item.completed", itemType: "tool", ok: false },
    { type: "request.opened", requestType: "permission", tool: "Bash", summary: "permission" },
  ])("never repeats visible output or work: $type $itemType", output => {
    const attempt = new ModelFailoverAttempt();
    attempt.observe(event(output));
    expect(attempt.observe(failure)).toBe("pass");
    expect(attempt.unsafe).toBe(true);
  });
  it("never changes providers to bypass a safety decision after rate-limit diagnostics", () => {
    const attempt = new ModelFailoverAttempt();
    attempt.observe(event({ type: "runtime.error", message: "429 rate limit" }));
    expect(attempt.observe(event({ type: "turn.completed", ok: false, stopReason: "provider_safety" }))).toBe("pass");
  });
  it("can recover synthetic API text but not real text containing an error code", () => {
    const synthetic = new ModelFailoverAttempt();
    expect(synthetic.observe(event({ type: "content.delta", streamKind: "assistant_text", delta: "401 Invalid API key", synthetic: true }))).toBe("hold");
    expect(synthetic.observe(failure)).toBe("retry");
    const real = new ModelFailoverAttempt();
    real.observe(event({ type: "content.delta", streamKind: "assistant_text", delta: "401 Invalid API key" }));
    expect(real.observe(failure)).toBe("pass");
  });
});

describe("configured candidate readiness", () => {
  const selection = { instanceId: "fallback", model: "model" };
  const instance = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
    instanceId: selection.instanceId, driverKind: "claude", enabled: true,
    models: { default: "model", options: [] },
    adapter: { capabilities: { images: true } },
    snapshot: vi.fn(async () => ({ state: "available", authenticated: true })),
    ...overrides,
  }) as ProviderInstance;
  const choose = (provider: ProviderInstance | null, extra = {}) => availableFailoverCandidate({
    candidates: [selection], visited: new Set<string>(), failedUntil: new Map<string, number>(),
    get: () => provider, excluded: () => false, active: () => true, ...extra,
  });
  it("accepts only a configured authenticated available candidate", async () => {
    expect(await choose(instance())).toEqual(selection);
    expect(await choose(instance({ snapshot: async () => ({ state: "available", authenticated: false }) }))).toBeNull();
    expect(await choose(instance({ snapshot: async () => ({ state: "available" }) }))).toBeNull();
    expect(await choose(instance({ snapshot: async () => ({ state: "unavailable", authenticated: true }) }))).toBeNull();
  });
  it("skips unavailable, disabled, managed, visited and known-bad accounts without probing", async () => {
    const provider = instance();
    expect(await choose(null)).toBeNull();
    expect(await choose(instance({ enabled: false }))).toBeNull();
    expect(await choose(provider, { excluded: () => true })).toBeNull();
    expect(await choose(provider, { visited: new Set([selectionKey(selection)]) })).toBeNull();
    expect(await choose(provider, { failedUntil: new Map([[selectionKey({ ...selection, model: "*" }), Date.now() + 60_000]]) })).toBeNull();
    expect(provider.snapshot).not.toHaveBeenCalled();
  });
  it("rechecks Stop and instance replacement after an asynchronous probe", async () => {
    let active = true;
    const provider = instance({ snapshot: async () => { active = false; return { state: "available", authenticated: true }; } });
    expect(await choose(provider, { active: () => active })).toBeNull();
  });
  it("bounds a stalled readiness probe", async () => {
    vi.useFakeTimers();
    try {
      const result = choose(instance({ snapshot: () => new Promise(() => {}) }));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
