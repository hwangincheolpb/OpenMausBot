import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

// The control fixture owns every process and temporary record. Goal mode uses
// the existing endpoint exercised by the documented group-goal-run recipe;
// the CLI currently exposes chat mode only. Account setup is fixture-only.
describe("goal model failover in an isolated fixture", () => {
  let fixture: VerificationServer;
  let stream: SseRecorder;
  let fallbackId: string;
  let evidence: unknown[];
  const file = (id: string, ext: string) => join(fixture.info.dataDir, `${id}.${ext}`);
  const plan = (id: string, value: object) => writeFileSync(file(id, "plan.json"), JSON.stringify(value));
  const prompts = (id: string) => existsSync(file(id, "prompts.jsonl"))
    ? readFileSync(file(id, "prompts.jsonl"), "utf8").trim().split("\n").filter(Boolean) : [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, result });
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const install = async (id: string) => {
    plan(id, { fail: false });
    const wrapper = file(id, "mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const plan = JSON.parse(readFileSync(${JSON.stringify(file(id, "plan.json"))}, "utf8"));`,
      'if (process.argv[2] === "auth") {',
      '  if (plan.probeMarker) writeFileSync(plan.probeMarker, "probe started");',
      '  while (plan.probeGate && !existsSync(plan.probeGate)) await new Promise(resolve => setTimeout(resolve, 10));',
      '  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0);',
      '}', 
      `process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(file(id, "dump.json"))};`,
      `process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(file(id, "prompts.jsonl"))};`,
      'process.env.FAKE_CLAUDE_TOOL_CALLS = "[]";',
      `process.env.FAKE_CLAUDE_REPLIES = ${JSON.stringify(JSON.stringify(['Verified answer.\n<openmaus-goal>{"status":"completed","detail":"Fallback goal complete."}</openmaus-goal>']))};`,
      'process.env.FAKE_CLAUDE_MODE = plan.fail ? "hang" : "happy";',
      'if (process.argv.includes("--input-format") && plan.fail) {',
      '  let input = ""; let started = false;',
      '  process.stdin.on("data", chunk => { input += chunk; if (started || !input.includes("\\n")) return; started = true;',
      '    setTimeout(() => {',
      '      const text = "API Error: 401 Invalid API key";',
      '      console.log(JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] }, error: "authentication_failed", is_api_error_message: true }));',
      '      console.log(JSON.stringify({ type: "result", is_error: true, terminal_reason: "api_error", result: text, total_cost_usd: 0.007, usage: { input_tokens: 3, output_tokens: 0 } }));',
      '    }, 20);',
      '  });',
      '}',
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", `/api/instances/${id}`, { cli: wrapper });
  };
  beforeEach(async () => {
    fixture = await launchVerificationServer();
    evidence = [{ fixture: fixture.info }];
    await install("claude");
    fallbackId = (await api("POST", "/api/instances/claude-accounts", { displayName: "Goal fallback" }, 201)).instanceId;
    await install(fallbackId);
    plan("claude", { fail: true });
    const catalog = await control(["models"]);
    const model = catalog.instances.find((instance: any) => instance.instanceId === "claude").models.default;
    await api("PATCH", "/api/config", { modelFailover: { enabled: true, maxAttempts: 2, candidates: [{ instanceId: fallbackId, model }] } });
    stream = await openSse(`${fixture.info.url}/api/events`);
  }, 30_000);
  afterEach(async () => {
    stream?.close();
    if (!fixture) return;
    const evidencePath = `${fixture.info.logPath}.goal-failover.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await fixture.close();
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath, fixtureRemoved: !existsSync(fixture.info.dataDir) }));
  });

  it.each([false, true])("keeps the coordinator envelope private and bounds retries (exhausted=%s)", async exhausted => {
    if (exhausted) plan(fallbackId, { fail: true });
    const { bot } = await control(["new-bot", "--name", "Goal lead"]);
    const { channel } = await control(["new-channel", "--name", "Goal recovery", "--members", bot.id]);
    await api("POST", `/api/groups/${channel.id}/messages`, {
      text: "GOAL_FAILOVER_ONCE", mode: "goal", sendId: `goal_failover_${exhausted ? "exhausted" : "success"}`,
    }, 202);
    const room = async () => (await api("GET", "/api/bots?messages=40")).groups.find((group: any) => group.id === channel.id);
    await expect.poll(async () => (await room()).messages.find((message: any) => message.kind === "goal.run")?.goalRun,
      { timeout: 20_000 }).toMatchObject({ status: exhausted ? "failed" : "completed", turnCount: 2 });
    const current = await room();
    const transcript = await control(["messages", "--channel", channel.id, "--limit", "40"]);
    expect(current.working).toBe(false);
    expect(prompts("claude")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(1);
    expect(transcript.messages.filter((message: any) => message.role === "user" && message.text === "GOAL_FAILOVER_ONCE")).toHaveLength(1);
    expect(JSON.stringify(transcript)).not.toContain("<openmaus-goal>");
    const runtime = stream.frames.filter(frame => frame.kind === "runtime" && frame.event?.threadId === channel.activeTaskId);
    expect(JSON.stringify(runtime)).not.toContain("<openmaus-goal>");
    expect(runtime.filter(frame => frame.event.type === "turn.completed")).toHaveLength(1);
    const after = (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(after.modelSelection).toEqual(bot.modelSelection);
    if (!exhausted) {
      expect(JSON.stringify(transcript)).toContain("Verified answer.");
      const argv = JSON.parse(readFileSync(file(fallbackId, "dump.json"), "utf8")).argv;
      expect(argv).not.toContain("bypassPermissions");
    }
    const ledger = join(fixture.info.dataDir, "usage", `${new Date().toISOString().slice(0, 7)}.jsonl`);
    const rows = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const charges = rows.filter(row => row.threadId === channel.activeTaskId);
    expect(charges).toHaveLength(2);
    expect(charges[0]).toMatchObject({ instanceId: "claude", input: 3, output: 0, costUsd: 0.007 });
    expect(charges[1]).toMatchObject({ instanceId: fallbackId, costUsd: exhausted ? 0.007 : 0.01 });
    evidence.push({ current, transcript, runtime, charges });
  }, 40_000);
  it("stops a goal during the fallback readiness probe without dispatching the alternative", async () => {
    const marker = file("probe", "started");
    const gate = file("probe", "gate");
    const { bot } = await control(["new-bot", "--name", "Cancelled goal lead"]);
    const { channel } = await control(["new-channel", "--name", "Cancelled goal", "--members", bot.id]);
    plan(fallbackId, { fail: false, probeMarker: marker, probeGate: gate });
    await api("POST", `/api/groups/${channel.id}/messages`, {
      text: "STOP_GOAL_FAILOVER", mode: "goal", sendId: "stop_goal_failover_once",
    }, 202);
    await expect.poll(() => prompts("claude").length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => existsSync(marker), { timeout: 10_000 }).toBe(true);
    await control(["interrupt", "--channel", channel.id, "--task", channel.activeTaskId]);
    writeFileSync(gate, "release the fixture readiness probe");
    await control(["wait", "--channel", channel.id, "--task", channel.activeTaskId, "--timeout", "20"]);
    const current = (await api("GET", "/api/bots?messages=40")).groups.find((group: any) => group.id === channel.id);
    expect(current.messages.find((message: any) => message.kind === "goal.run")?.goalRun).toMatchObject({ status: "stopped", turnCount: 1 });
    expect(current.working).toBe(false);
    expect(prompts("claude")).toHaveLength(1);
    expect(prompts(fallbackId)).toHaveLength(0);
    const runtime = stream.frames.filter(frame => frame.kind === "runtime" && frame.event?.threadId === channel.activeTaskId);
    expect(runtime.filter(frame => frame.event.type === "turn.completed")).toHaveLength(1);
    evidence.push({ current, runtime });
  }, 40_000);

});
