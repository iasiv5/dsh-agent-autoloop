// Where the plugin keeps its things. The profile that installed it owns the data, so two profiles never share, and the
// standalone hub under ~/.agent-autoloop is never touched. An explicit override (argument or AGENT_AUTOLOOP_DSH_DATA)
// IS the data dir. Otherwise: walk up from this module for an ancestor package.json that declares dsh.profile (a real
// install lives in the profile's own node_modules), then the Harness home's profiles dir named by --profile in argv,
// or the single profile there is when argv doesn't say. link: installs resolve import.meta.url outside the profile,
// hence the last two steps. The env var is read per call, not at import, so one test process can own several
// instances.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export class DataDirError extends Error {}

const isProfileRoot = (dir: string) => {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return Boolean(manifest.dsh && typeof manifest.dsh === "object" && "profile" in manifest.dsh);
  } catch {
    return false;
  }
};

function profileFromModule(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (isProfileRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function profileNameFromArgv(): string | undefined {
  const argv = process.argv;
  const flag = argv.indexOf("--profile");
  return flag >= 0 ? argv[flag + 1] : undefined;
}

function profileFromHome(): string | undefined {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const profiles = join(home, "profiles");
  if (!existsSync(profiles)) return undefined;
  const name = profileNameFromArgv();
  if (name) return isProfileRoot(join(profiles, name)) ? join(profiles, name) : undefined;
  const known = readdirSync(profiles).filter((entry) => isProfileRoot(join(profiles, entry)));
  return known.length === 1 ? join(profiles, known[0]) : undefined;
}

export function dataDir(override?: string): string {
  const explicit = override ?? process.env.AGENT_AUTOLOOP_DSH_DATA;
  if (explicit) {
    mkdirSync(explicit, { recursive: true, mode: 0o700 });
    chmodSync(explicit, 0o700);
    return explicit;
  }
  const profile = profileFromModule() ?? profileFromHome();
  if (!profile) {
    throw new DataDirError(
      `找不到所属 profile（模块位置、DSH_HOME/profiles 与 --profile 都没找到 dsh.profile 声明；argv=${JSON.stringify(
        process.argv.slice(0, 6),
      )}）。可用 AGENT_AUTOLOOP_DSH_DATA 指定数据目录`,
    );
  }
  const dir = join(profile, "data", "agent-autoloop");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // an existing directory may have drifted; the standalone shell makes the same correction
  return dir;
}

// One writer per data dir: a second plugin instance must never dispatch the same matter twice. The lock holds the
// owner's pid; a lock left by a process that no longer exists is taken over, one that can't be verified is respected.
export function acquireDataLock(dir: string): () => void {
  const file = join(dir, "lock");
  const claim = () => writeFileSync(file, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
  try {
    claim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number(readFileSync(file, "utf8").trim());
    let alive = false;
    if (Number.isInteger(holder) && holder > 0) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch (signal) {
        alive = (signal as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (alive) throw new DataDirError(`另一个实例正在使用这个数据目录（进程 ${holder}）`);
    unlinkSync(file); // take over the stale lock; a lost race here just fails the next claim loudly
    claim();
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {}
  };
}
