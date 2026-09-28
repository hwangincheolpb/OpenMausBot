// Every request targets the canonical launcher's disposable fake-engine server.
// Account settings/routine setup use the same API as Settings; conversations
// use the shared control surface with explicit bot and task destinations.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

type Plan = {
  mode?: "happy" | "auth-error" | "partial-error" | "tool-error" | "gated-error";
  auth?: boolean;
  probeGate?: string;
  probeMarker?: string;
  errorGate?: string;
  errorText?: string;
  failureCost?: number;
  failureUsage?: { input_tokens: number; output_tokens: number };
};

describe("automatic model failover through the isolated control surface", () => {
  let fixture: VerificationServer;
  let stream: SseRecorder;
  let fallbackId: string;
  let model: string;
  let evidence: unknown[];
  const sockets: Socket[] = [];

  const file = (id: string, extension: string) => join(fixture.info.dataDir, `${id}.${extension}`);
  const plan = (id: string, value: Plan) => writeFileSync(file(id, "plan.json"), JSON.stringify(value));
  const prompts = (id: string): any[] => existsSync(file(id, "prompts.jsonl"))
    ? readFileSync(file(id, "prompts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status });
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const state = async (id: string) => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === id);
  const configure = (enabled = true, candidates = [{ instanceId: fallbackId, model }], maxAttempts = 2) =>
    api("PATCH", "/api/config", { modelFailover: { enabled, candidates, maxAttempts } });
  const newBot = async () => {
    const { bot } = await control(["new-bot", "--name", "Failover fixture"]);
    await control(["set-model", "--bot", bot.id, "--instance", "claude", "--model", model]);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { approvalMode: "ask" });
    return { id: bot.id as string, threadId: bot.activeTaskId as string };
  };
  const send = (bot: { id: string; threadId: string }, text = "FAILOVER_ONCE") =>
    control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text]);
  const wait = (bot: { id: string; threadId: string }) =>
    control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20"]);
  const messages = (bot: { id: string; threadId: string }) =>
    control(["messages", "--bot", bot.id, "--task", bot.threadId, "--limit", "30"]);
  const terminalEvents = (threadId: string) => stream.frames.filter(frame =>
    frame.kind === "runtime" && frame.event?.threadId === threadId
    && ["turn.completed", "turn.failed", "turn.interrupted"].includes(frame.event.type));

  const installFake = async (id: string) => {
    plan(id, { mode: "happy" });
    const wrapper = file(id, "mjs");
    // Only this fixture's repository fake CLI is imported. Gated probes and
    // synthetic frames make races observable without contacting a provider.
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const plan = JSON.parse(readFileSync(${JSON.stringify(file(id, "plan.json"))}, "utf8"));`,
      'if (process.argv[2] === "auth") {',
      '  if (plan.probeMarker) writeFileSync(plan.probeMarker, "probe started");',
      '  while (plan.probeGate && !existsSync(plan.probeGate)) await new Promise(resolve => setTimeout(resolve, 10));',
      '  console.log(JSON.stringify({ loggedIn: plan.auth !== false, authMethod: "claude.ai" }));',
      '  process.exit(0);',
      '}',
      `process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(file(id, "dump.json"))};`,
      `process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(file(id, "prompts.jsonl"))};`,
      'process.env.FAKE_CLAUDE_TOOL_CALLS = "[]";',
      `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify([`reply from ${id}`]))};`,
      'process.env.FAKE_CLAUDE_MODE = plan.mode === "happy" ? "happy" : "hang";',
      'if (process.argv.includes("--input-format") && plan.mode !== "happy") {',
      '  let input = ""; let started = false;',
      '  const out = frame => process.stdout.write(JSON.stringify(frame) + "\\n");',
      '  process.stdin.on("data", chunk => {',
      '    input += chunk; if (started || !input.includes("\\n")) return; started = true;',
      '    if (plan.mode === "partial-error") out({ type: "assistant", message: { content: [{ type: "text", text: "already visible" }] } });',
      '    if (plan.mode === "tool-error") out({ type: "assistant", message: { content: [{ type: "tool_use", id: "fixture-side-effect", name: "Bash", input: { command: "echo fixture" } }] } });',
      '    const fail = () => {',
      '      const text = plan.errorText || "API Error: 401 Invalid API key";',
      '      out({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, error: "authentication_failed", is_api_error_message: true });',
      '      out({ type: "result", is_error: true, terminal_reason: "api_error", result: text, total_cost_usd: plan.failureCost, usage: plan.failureUsage });',
      '    };',
      '    if (plan.errorGate) { const timer = setInterval(() => { if (existsSync(plan.errorGate)) { clearInterval(timer); fail(); } }, 10); }',
      '    else setTimeout(fail, 20);',
      '  });',
      '}',
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", `/api/instances/${id}`, { cli: wrapper });
  };

  beforeEach(async () => {
    fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, ["codex"]);
    evidence = [{ fixture: fixture.info }];
    await installFake("claude");
    const added = await api("POST", "/api/instances/claude-accounts", { displayName: "Fallback fixture" }, 201);
    fallbackId = added.instanceId;
    await installFake(fallbackId);
    const catalog = await control(["models"]);
    model = catalog.instances.find((instance: any) => instance.instanceId === "claude").models.default;
    expect(model).toBeTruthy();
    stream = await openSse(`${fixture.info.url}/api/events`);
    plan("claude", { mode: "auth-error" });
    await configure();
  }, 30_000);

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    stream?.close();
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.model-failover.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await fixture.close();
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath, fixtureRemoved: !existsSync(fixture.info.dataDir) }));
  });

  it("recovers one direct turn and a routine while preserving bot defaults, sibling models and approval scope", async () => {
    const bot = await newBot();
    const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Untouched sibling" }, 201)).task;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "auto" });
    const before = await state(bot.id);
    plan("claude", { mode: "auth-error", failureCost: 0.02, failureUsage: { input_tokens: 3, output_tokens: 2 } });
    await send(bot);
    expect((await wait(bot)).status).toBe("settled");
    const transcript = await messages(bot);
    expect(transcript.messages.filter((message: any) => message.role === "user" && message.text === "FAILOVER_ONCE")).toHaveLength(1);
    expect(JSON.stringify(transcript)).toContain(`reply from ${fallbackId}`);
    expect(prompts("claude")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(1);
    expect(terminalEvents(bot.threadId)).toHaveLength(1);
    const after = await state(bot.id);
    expect(after.modelSelection).toEqual(before.modelSelection);
    expect(after.tasks.find((task: any) => task.threadId === bot.threadId)).toMatchObject({ approvalMode: "ask", modelSelection: { instanceId: fallbackId, model } });
    expect(after.tasks.find((task: any) => task.threadId === sibling.threadId)).toEqual(before.tasks.find((task: any) => task.threadId === sibling.threadId));
    const dump = JSON.parse(readFileSync(file(fallbackId, "dump.json"), "utf8"));
    expect(dump.argv).not.toContain("bypassPermissions");
    expect(dump.argv).not.toContain("--resume");
    await expect.poll(async () => (await api("GET", "/api/usage")).total.turns, { timeout: 5_000 }).toBe(2);
    const usage = await api("GET", "/api/usage");
    expect(usage.total.costUsd).toBeCloseTo(0.03, 6);
    const ledger = readFileSync(join(fixture.info.dataDir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({ instanceId: "claude", model, input: 3, output: 2, costUsd: 0.02 });
    expect(ledger[1]).toMatchObject({ instanceId: fallbackId, model, costUsd: 0.01 });
    evidence.push({ usage, ledger });
    const { routine } = await api("POST", "/api/routines", {
      name: "Failover report", prompt: "ROUTINE_FAILOVER_ONCE", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.status,
      { timeout: 20_000 }).toBe("completed");
    const finished = (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id);
    const routineBot = { id: bot.id, threadId: finished.threadId };
    expect((await wait(routineBot)).status).toBe("settled");
    expect(JSON.stringify(await messages(routineBot))).toContain(`reply from ${fallbackId}`);
    expect(prompts("claude")).toHaveLength(2);
    expect(prompts(fallbackId)).toHaveLength(2);
    expect(terminalEvents(finished.threadId)).toHaveLength(1);
    evidence.push({ routine: finished, terminals: terminalEvents(bot.threadId), routineTerminals: terminalEvents(finished.threadId) });
  }, 60_000);

  it.each(["disabled", "exhausted"] as const)("preserves one terminal failure when failover is %s", async mode => {
    if (mode === "disabled") await configure(false);
    else plan(fallbackId, { mode: "auth-error" });
    const bot = await newBot();
    await send(bot);
    expect((await wait(bot)).status).toBe("failed");
    const transcript = await messages(bot);
    expect(JSON.stringify(transcript)).toMatch(/401|Invalid API key|auth_required/);
    expect(transcript.messages.filter((message: any) => message.role === "user" && message.text === "FAILOVER_ONCE")).toHaveLength(1);
    expect(prompts("claude")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(mode === "disabled" ? 0 : 1);
    expect(terminalEvents(bot.threadId)).toHaveLength(1);
  }, 40_000);

  it("skips a missing engine, unknown model and signed-out candidate before the ready alternative", async () => {
    const added = await api("POST", "/api/instances/claude-accounts", { displayName: "Signed out fixture" }, 201);
    await installFake(added.instanceId);
    plan(added.instanceId, { mode: "happy", auth: false });
    await configure(true, [
      { instanceId: "missing-fixture", model },
      { instanceId: fallbackId, model: "missing-model" },
      { instanceId: added.instanceId, model },
      { instanceId: fallbackId, model },
    ]);
    const bot = await newBot();
    await send(bot);
    expect((await wait(bot)).status).toBe("settled");
    expect(prompts(added.instanceId)).toHaveLength(0);
    expect(prompts(fallbackId)).toHaveLength(1);
    await messages(bot);
  }, 40_000);

  it.each(["partial-error", "tool-error"] as const)("does not replay a turn after %s", async mode => {
    plan("claude", { mode });
    const bot = await newBot();
    await send(bot);
    expect((await wait(bot)).status).toBe("failed");
    const transcript = await messages(bot);
    expect(JSON.stringify(transcript)).toContain(mode === "partial-error" ? "already visible" : "Bash");
    expect(prompts("claude")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(0);
    expect(terminalEvents(bot.threadId)).toHaveLength(1);
  }, 40_000);

  it("does not replay after a real approval request reaches the conversation", async () => {
    const gate = file("approval", "gate");
    plan("claude", { mode: "gated-error", errorGate: gate });
    const bot = await newBot();
    await send(bot);
    await expect.poll(() => existsSync(file("claude", "dump.json")), { timeout: 10_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(file("claude", "dump.json"), "utf8"));
    const socket = connect(dump.mcpConfig.mcpServers.ogb.args.at(-1));
    sockets.push(socket);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(`${JSON.stringify({ t: "ask", id: "failover-approval", kind: "permission", tool: "Bash", input: { command: "echo fixture" } })}\n`);
    expect((await wait(bot)).status).toBe("needs-user");
    writeFileSync(gate, "fail after the approval request");
    await expect.poll(async () => (await state(bot.id)).busy, { timeout: 15_000 }).toBe(false);
    expect((await wait(bot)).status).toBe("failed");
    await messages(bot);
    expect(prompts(fallbackId)).toHaveLength(0);
    expect(terminalEvents(bot.threadId)).toHaveLength(1);
  }, 40_000);

  it("honors Stop while the candidate readiness probe is pending", async () => {
    const bot = await newBot();
    const gate = file("probe", "gate");
    const marker = file("probe", "started");
    plan(fallbackId, { mode: "happy", probeGate: gate, probeMarker: marker });
    await send(bot);
    await expect.poll(() => existsSync(marker), { timeout: 10_000 }).toBe(true);
    await control(["interrupt", "--bot", bot.id, "--task", bot.threadId]);
    writeFileSync(gate, "release only the synthetic readiness probe");
    const settled = await wait(bot);
    expect(settled.status).toBe("settled");
    expect(prompts(fallbackId)).toHaveLength(0);
    expect(prompts("claude")).toHaveLength(1);
    await messages(bot);
    expect(terminalEvents(bot.threadId)).toHaveLength(1);
  }, 40_000);

  it("settles once when admission changes during a candidate readiness probe", async () => {
    const bot = await newBot();
    const gate = file("admission-probe", "gate");
    const marker = file("admission-probe", "started");
    plan(fallbackId, { mode: "happy", probeGate: gate, probeMarker: marker });
    await send(bot);
    await expect.poll(() => existsSync(marker), { timeout: 10_000 }).toBe(true);
    plan("claude", { mode: "gated-error", errorGate: file("sibling", "never-release") });
    const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Held sibling" }, 201)).task;
    const held = { id: bot.id, threadId: sibling.threadId };
    await send(held, "HOLD_SIBLING");
    await expect.poll(() => prompts("claude").length, { timeout: 10_000 }).toBe(2);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    writeFileSync(gate, "candidate ready after the concurrency limit changes");
    expect((await wait(bot)).status).toBe("failed");
    const transcript = await messages(bot);
    expect(transcript.messages.filter((message: any) => message.role === "user" && message.text === "FAILOVER_ONCE")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(0);
    expect(terminalEvents(bot.threadId)).toHaveLength(1);
    const current = await state(bot.id);
    expect(current.tasks.find((task: any) => task.threadId === bot.threadId).busy).toBe(false);
    expect(current.tasks.find((task: any) => task.threadId === held.threadId).busy).toBe(true);
    await control(["interrupt", "--bot", bot.id, "--task", held.threadId]);
    await wait(held);
  }, 40_000);

  it.each(["API Error: 429 quota exceeded", "API Error: 503 service unavailable"])("switches a blocked Claude turn to the ready Codex driver: %s", async errorText => {
    const wrapper = file("codex", "mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      `process.env.FAKE_CODEX_DUMP = ${JSON.stringify(file("codex", "dump.json"))};`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-codex-app-server.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/codex", { cli: wrapper });
    const catalog = await control(["models"]);
    const codexModel = catalog.instances.find((instance: any) => instance.instanceId === "codex").models.default;
    await configure(true, [{ instanceId: "codex", model: codexModel }]);
    plan("claude", { mode: "auth-error", errorText });
    const bot = await newBot();
    await send(bot, "CROSS_DRIVER_ONCE");
    expect((await wait(bot)).status).toBe("settled");
    const transcript = await messages(bot);
    expect(transcript.messages.filter((message: any) => message.role === "user" && message.text === "CROSS_DRIVER_ONCE")).toHaveLength(1);
    expect(JSON.stringify(transcript)).toContain("done from fake codex");
    const dump = JSON.parse(readFileSync(file("codex", "dump.json"), "utf8"));
    const starts = dump.calls.filter((call: any) => call.method === "turn/start");
    expect(starts).toHaveLength(1);
    expect(JSON.stringify(starts)).toContain("CROSS_DRIVER_ONCE");
    expect(dump.calls.some((call: any) => call.method === "thread/resume")).toBe(false);
    expect(dump.calls.find((call: any) => call.method === "thread/start").params.approvalPolicy).not.toBe("never");
    expect(prompts("claude")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(0);
    expect(terminalEvents(bot.threadId)).toHaveLength(1);
    expect((await state(bot.id)).modelSelection.instanceId).toBe("claude");
    evidence.push({ codexTurnCount: starts.length, resumedClaudeSession: false, terminalEvents: terminalEvents(bot.threadId) });
  }, 40_000);

  it.each(["auth-error", "partial-error"] as const)("uses the same safe failover boundary in a group: %s", async mode => {
    plan("claude", { mode });
    const bot = await newBot();
    const { channel } = await control(["new-channel", "--name", "Failover room", "--members", bot.id]);
    await control(["send-channel", "--channel", channel.id, "--text", "ROOM_FAILOVER_ONCE"]);
    const outcome = await control(["wait", "--channel", channel.id, "--timeout", "20"]);
    // A room settles when its responder queue ends, including a member's
    // failed turn. The per-member terminal and error stay visible below.
    expect(outcome.status).toBe("settled");
    const transcript = await control(["messages", "--channel", channel.id, "--limit", "30"]);
    expect(transcript.messages.filter((message: any) => message.role === "user" && message.text === "ROOM_FAILOVER_ONCE")).toHaveLength(1);
    expect(JSON.stringify(transcript)).toContain(mode === "auth-error" ? `reply from ${fallbackId}` : "already visible");
    expect(prompts("claude")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(mode === "auth-error" ? 1 : 0);
    const terminals = stream.frames.filter(frame => frame.kind === "runtime" && frame.event?.type === "turn.completed");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].event.ok).toBe(mode === "auth-error");
    if (mode === "partial-error") expect(transcript.messages.some((message: any) => message.tool?.ok === false && message.tool.name.includes("Invalid API key"))).toBe(true);
    expect((await state(bot.id)).modelSelection.instanceId).toBe("claude");
  }, 40_000);
});
