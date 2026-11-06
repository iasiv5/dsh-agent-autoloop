// The launchd plist names an absolute node. A Homebrew version lives under `Cellar`, and that directory is deleted at
// the next upgrade, so a service started from it dies then; the `opt` link beside it follows the upgrade. What is
// checked here is the plist for the node actually running these tests: on a Homebrew node it must name the `opt` path,
// and on any other node the path it really has.
// Failure modes: the Cellar path is written as it is; an `opt` link that points somewhere else is taken as this node;
// the PATH keeps the Cellar directory while the program uses `opt`, so a plugin finds a different node.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { plist } from "../host/service.ts";

const homebrew = /^(\/opt\/homebrew|\/usr\/local)\/Cellar\/([^/]+)\/[^/]+\/bin\/([^/]+)$/.exec(process.execPath);
const stable = homebrew ? `${homebrew[1]}/opt/${homebrew[2]}/bin/${homebrew[3]}` : null;

test("the plist names this node's stable path, not its version path", () => {
  const value = plist();
  const named = /<key>ProgramArguments<\/key><array><string>([^<]+)<\/string>/.exec(value)![1];
  const searchPath = /<key>PATH<\/key><string>([^<]+)<\/string>/.exec(value)![1];
  if (stable) {
    assert.equal(named, stable, "a version path would break at the next upgrade");
    assert.equal(
      searchPath.split(":")[0],
      dirname(stable),
      "the PATH starts where the program is, or a plugin finds another node",
    );
    assert.equal(realpathSync(named!), process.execPath);
  } else {
    assert.equal(named, process.execPath, "a node outside Homebrew is named as it is");
  }
});
