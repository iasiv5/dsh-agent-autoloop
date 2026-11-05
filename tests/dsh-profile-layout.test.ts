// Failure cases this file guards: the plugin resolving its data dir from the real profile layout the host installs
// (node_modules walk-up, no env override), and the installed artifact being plain JS — Node refuses to strip types
// inside node_modules, so the entry must be the built bundle, never the .ts source.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

test("the entry resolves the data dir from an installed profile layout and releases the lock on teardown", async () => {
  const profile = mkdtempSync(join(tmpdir(), "autoloop-profile-"));
  writeFileSync(join(profile, "package.json"), JSON.stringify({ dsh: { profile: {} } }));
  const plugin = join(profile, "node_modules", "@iasiv5", "dsh-agent-autoloop");
  const { cpSync, mkdirSync } = await import("node:fs");
  mkdirSync(plugin, { recursive: true });
  cpSync(join(import.meta.dirname, "..", "dsh"), plugin, { recursive: true });
  const previous = process.env.AGENT_AUTOLOOP_DSH_DATA;
  delete process.env.AGENT_AUTOLOOP_DSH_DATA;
  try {
    const host = await import(pathToFileURL(join(plugin, "lib", "host.js")).href);
    assert.equal(host.name, "agent-autoloop");
    const disposers: (() => void)[] = [];
    // Stage C activation requires trusted rules; the fixture keeps the shape honest.
    const data = join(profile, "data", "agent-autoloop");
    mkdirSync(data, { recursive: true });
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({
        worker: "dsh",
        rules: JSON.parse(readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8")),
      }),
    );
    host.apply({
      on: () => () => {},
      effect: (run: () => (() => void) | void) => {
        const teardown = run();
        disposers.push(() => teardown?.());
        return {};
      },
    });
    const dir = join(profile, "data", "agent-autoloop");
    assert.ok(existsSync(join(dir, "lock")));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const teardown of disposers.reverse()) teardown();
    assert.ok(!existsSync(join(dir, "lock")));
  } finally {
    if (previous === undefined) delete process.env.AGENT_AUTOLOOP_DSH_DATA;
    else process.env.AGENT_AUTOLOOP_DSH_DATA = previous;
    rmSync(profile, { recursive: true, force: true });
  }
});
