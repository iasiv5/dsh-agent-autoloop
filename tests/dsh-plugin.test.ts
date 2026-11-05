// Failure cases this file guards: the skeleton loading twice into one data dir, a stale lock taken over, a config
// typo silently doing nothing, the status route serving cross-site callers, and the skeleton reaching outside its own
// directory (old shell, harness packages) before the bridge exists.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "../dsh/src/config.ts";
import * as paths from "../dsh/src/paths.ts";
import * as host from "../dsh/src/host.ts";

const RULES = JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8"));
const CONFIG = JSON.stringify({ capacity: 2, worker: "dsh", rules: RULES });

type Teardown = (() => void) | void;
type Route = { path: string; handler: (req: any, res: any) => void };
type FakeCtx = {
  effects: { label?: string; run: () => Teardown }[];
  webServer: { routes: Route[]; register(route: Route): () => void };
  effect: (run: () => Teardown, label?: string) => unknown;
  on(name: string, handler: (...args: any[]) => unknown): () => void;
};

const fakeCtx = (): FakeCtx => {
  const effects: FakeCtx["effects"] = [];
  const webServer: FakeCtx["webServer"] = {
    routes: [],
    register(route) {
      this.routes.push(route);
      return () => {
        const at = this.routes.indexOf(route);
        if (at >= 0) this.routes.splice(at, 1);
      };
    },
  };
  return {
    effects,
    webServer,
    effect(run, label) {
      effects.push({ label, run });
      return {};
    },
    on() {
      return () => {};
    },
  };
};
/** cordis runs each effect body as it registers; the returned disposers unwind in reverse on teardown. */
const begin = (ctx: FakeCtx = fakeCtx()) => {
  host.apply(ctx);
  const teardowns = ctx.effects.map((effect) => effect.run());
  const stop = () => [...teardowns].reverse().forEach((teardown) => teardown?.());
  return { stop, ctx };
};

const scratch = () => {
  const dirs: string[] = [];
  const make = () => {
    const dir = mkdtempSync(join(tmpdir(), "autoloop-dsh-"));
    dirs.push(dir);
    return dir;
  };
  return { make, clean: () => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })) };
};

test("the entry declares a name, the service injections and an apply function", () => {
  assert.equal(host.name, "agent-autoloop");
  assert.deepEqual(host.inject, [
    "webServer",
    "commands",
    "agents",
    "sessionPersistence",
    "workingDirectory",
    "agentDefaultModel",
    "timer",
    "approval",
  ]);
  assert.equal(typeof host.apply, "function");
});

test("the bridge takes the configured provider, so runs never fall back to the host default model", () => {
  assert.deepEqual(host.bridgeOptions({ worker: "dsh", capacity: 2, provider: "zai-coding-cn" }), {
    worker: "dsh",
    capacity: 2,
    provider: "zai-coding-cn",
  });
});

test("apply owns a private data dir and the lock, refuses a second live instance and releases on teardown", () => {
  const { make, clean } = scratch();
  try {
    const dir = make();
    process.env.AGENT_AUTOLOOP_DSH_DATA = dir;
    writeFileSync(join(dir, "config.json"), CONFIG);
    const { stop } = begin();
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(Number(readFileSync(join(dir, "lock"), "utf8")), process.pid);
    assert.throws(() => begin(), /另一个实例/);
    stop();
    assert.ok(!existsSync(join(dir, "lock")));
    begin().stop();
  } finally {
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    clean();
  }
});

test("a lock left by a process that no longer exists is taken over", () => {
  const { make, clean } = scratch();
  try {
    const dir = make();
    process.env.AGENT_AUTOLOOP_DSH_DATA = dir;
    writeFileSync(join(dir, "config.json"), CONFIG);
    const gone = spawnSync(process.execPath, ["-e", ""]);
    writeFileSync(join(dir, "lock"), `${gone.pid}\n`);
    begin().stop();
  } finally {
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    clean();
  }
});

test("the dashboard routes serve status/overview, apply writes and keep the same-origin fence", async () => {
  const { make, clean } = scratch();
  let stop: (() => void) | undefined;
  let routes: Route[] = [];
  let dir = "";
  try {
    dir = make();
    process.env.AGENT_AUTOLOOP_DSH_DATA = dir;
    writeFileSync(join(dir, "config.json"), CONFIG);
    const begun = begin();
    stop = begun.stop;
    routes = begun.ctx.webServer.routes;
    assert.equal(routes.length, 10);
    const call = async (
      route: Route,
      method: string,
      body?: unknown,
      headers: Record<string, string> = {},
      url?: string,
    ) => {
      const res = {
        status: 0,
        body: "",
        writeHead(status: number) {
          this.status = status;
        },
        end(body?: string) {
          this.body = body ?? "";
        },
      };
      await route.handler(
        {
          method,
          headers,
          url: url ?? route.path,
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        res,
      );
      return res;
    };
    const byPath = (path: string) => routes.find((route) => route.path === path)!;
    const status = await call(byPath("/api/agent-autoloop/status"), "GET");
    assert.equal(status.status, 200);
    const payload = JSON.parse(status.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.kernel.worker, "dsh");
    assert.equal(payload.kernel.paused, false);
    assert.equal((await call(byPath("/api/agent-autoloop/status"), "POST")).status, 405);
    assert.equal(
      (
        await call(byPath("/api/agent-autoloop/status"), "GET", undefined, {
          origin: "https://evil.example",
          host: "h",
        })
      ).status,
      403,
    );
    const overview = await call(byPath("/api/agent-autoloop/overview"), "GET");
    const state = JSON.parse(overview.body);
    assert.equal(state.ok, true);
    assert.ok(Array.isArray(state.cards));
    const emit = await call(byPath("/api/agent-autoloop/emit"), "POST", {
      id: "手动1",
      type: "feedback.new",
      subject: "manual-1",
    });
    const emitBody = JSON.parse(emit.body);
    assert.equal(emitBody.ok, true);
    assert.equal(emitBody.duplicate, false);
    assert.equal(emitBody.routed.length, 1);
    const again = JSON.parse(
      (
        await call(byPath("/api/agent-autoloop/emit"), "POST", {
          id: "手动1",
          type: "feedback.new",
          subject: "manual-1",
        })
      ).body,
    );
    assert.equal(again.duplicate, true);
    const paused = JSON.parse((await call(byPath("/api/agent-autoloop/pause"), "POST", {})).body);
    assert.equal(paused.paused, true);
    const resumed = JSON.parse((await call(byPath("/api/agent-autoloop/resume"), "POST", {})).body);
    assert.equal(resumed.paused, false);
    const rules = await call(byPath("/api/agent-autoloop/rules"), "GET");
    assert.equal(JSON.parse(rules.body).ok, true);
    const badRules = await call(byPath("/api/agent-autoloop/rules"), "PUT", { broken: 1 });
    assert.equal(badRules.status, 400);
    const fileBefore = readFileSync(join(dir, "config.json"), "utf8");
    const putRules = await call(byPath("/api/agent-autoloop/rules"), "PUT", {
      timezone: "UTC",
      askFirst: [],
      sources: { local: { name: "本地" } },
      agents: { dsh: { name: "DSH", worker: "dsh", use: "dsh", access: "read" } },
      channels: {},
      rules: [{ name: "新规则", when: { source: "local", types: ["x.*"] }, to: "dsh", cwd: "/tmp", prompt: "做。" }],
      elsewhere: [],
    });
    assert.equal(JSON.parse(putRules.body).ok, true);
    const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(saved.rules.rules[0].name, "新规则");
    assert.equal(saved.capacity, 2, "non-rule fields preserved");
    assert.equal(
      JSON.parse((await call(byPath("/api/agent-autoloop/rules"), "GET")).body).rules.rules[0].name,
      "新规则",
    );
    const why = await call(byPath("/api/agent-autoloop/why"), "GET");
    assert.equal(JSON.parse(why.body).ok, false, "no run id given");
    const whyFacts = JSON.parse(
      (await call(byPath("/api/agent-autoloop/why"), "GET", undefined, {}, "/api/agent-autoloop/why/1")).body,
    );
    assert.equal(whyFacts.ok, true, "the claimed run explains itself");
    assert.ok(Array.isArray(whyFacts.facts) && whyFacts.facts.length > 0);
    assert.equal(
      (await call(byPath("/api/agent-autoloop/answer"), "POST", { card: 1 })).status,
      400,
      "answer without choice/text",
    );
  } finally {
    stop?.();
    if (routes.length) assert.equal(routes.length, 0, "routes unregistered on teardown");
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    clean();
  }
});

test("without the override, the data dir follows the profile named in argv under DSH_HOME", () => {
  const { make, clean } = scratch();
  const savedHome = process.env.DSH_HOME;
  const savedArgv = process.argv;
  try {
    const home = make();
    const profile = join(home, "profiles", "web");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
    process.env.DSH_HOME = home;
    process.argv = ["dsh", "--profile", "web", "--no-open"];
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    const dir = paths.dataDir();
    assert.equal(dir, join(profile, "data", "agent-autoloop"));
    assert.ok(existsSync(join(profile, "data")));
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    process.argv = savedArgv;
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    clean();
  }
});

test("two profiles and no --profile is refused instead of guessed", () => {
  const { make, clean } = scratch();
  const savedHome = process.env.DSH_HOME;
  const savedArgv = process.argv;
  try {
    const home = make();
    for (const name of ["web", "tui"]) {
      const profile = join(home, "profiles", name);
      mkdirSync(profile, { recursive: true });
      writeFileSync(join(profile, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
    }
    process.env.DSH_HOME = home;
    process.argv = ["dsh", "web"];
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    assert.throws(() => paths.dataDir(), /找不到所属 profile/);
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    process.argv = savedArgv;
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    clean();
  }
});

test("config defaults to two concurrent matters under worker dsh, validates rules and rejects unknown fields", () => {
  const { make, clean } = scratch();
  try {
    const dir = make();
    assert.deepEqual(readConfig(dir), {
      capacity: 2,
      worker: "dsh",
      provider: undefined,
      rules: undefined,
      publicUrl: undefined,
      approvalPolicy: undefined,
    });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ capacity: 7, worker: "dsh-a", rules: RULES, publicUrl: "https://x.example" }),
    );
    const config = readConfig(dir);
    assert.equal(config.capacity, 7);
    assert.equal(config.worker, "dsh-a");
    assert.equal(config.publicUrl, "https://x.example");
    assert.equal(config.rules!.agents.a1.name, "甲");
    writeFileSync(join(dir, "config.json"), `{"bogus":true}`);
    assert.throws(() => readConfig(dir), /不认识的字段/);
    writeFileSync(join(dir, "config.json"), `{"capacity":0}`);
    assert.throws(() => readConfig(dir), /capacity/);
    writeFileSync(join(dir, "config.json"), `{"worker":"9x"}`);
    assert.throws(() => readConfig(dir), /worker/);
    writeFileSync(join(dir, "config.json"), `{"rules":{"broken":1}}`);
    assert.throws(() => readConfig(dir), /不合格/);
  } finally {
    clean();
  }
});

test("a symlink-style install resolves to the profile that links this package", () => {
  const { make, clean } = scratch();
  const savedHome = process.env.DSH_HOME;
  const savedArgv = process.argv;
  try {
    const home = make();
    // 两个 profile 共存：linkA 指向本插件（实体目录在别处），linkB 指向无关目录——精确 link 匹配应选中 linkA。
    for (const name of ["web", "other"]) {
      const profile = join(home, "profiles", name);
      mkdirSync(join(profile, "node_modules", "@iasiv5"), { recursive: true });
      writeFileSync(join(profile, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));
    }
    symlinkSync(
      join(import.meta.dirname, "..", "dsh"),
      join(home, "profiles", "web", "node_modules", "@iasiv5", "dsh-agent-autoloop"),
    );
    symlinkSync(
      join(home, "elsewhere"),
      join(home, "profiles", "other", "node_modules", "@iasiv5", "dsh-agent-autoloop"),
    );
    process.env.DSH_HOME = home;
    process.argv = ["dsh", "web"];
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    const dir = paths.dataDir();
    assert.equal(dir, join(home, "profiles", "web", "data", "agent-autoloop"));
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    process.argv = savedArgv;
    delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    clean();
  }
});

test("the stage modules import nothing outside node: builtins, their own directory and the shared repo layers", () => {
  const root = join(import.meta.dirname, "..");
  for (const file of ["host.ts", "paths.ts", "config.ts", "web.ts", "client.ts", "bridge.ts", "commands.ts"]) {
    const text = readFileSync(join(root, "dsh", "src", file), "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import) "([^"]+)"/g)) {
      assert.ok(spec.startsWith("node:") || spec.startsWith("."), `${file} imports ${spec}`);
    }
  }
});
