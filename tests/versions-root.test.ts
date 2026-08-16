import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  projectRoot,
  restore,
  setProjectRootCwd,
  snapshot,
} from "../packages/service/src/versions.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), "pinnables-root-")));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "test@pinnables.dev"]);
  await git(repo, ["config", "user.name", "Pinnables Test"]);
  await mkdir(join(repo, "fixtures", "film-set"), { recursive: true });
  await mkdir(join(repo, "packages", "service"), { recursive: true });
  await writeFile(join(repo, "fixtures", "film-set", "card.css"), "background: yellow;\n", "utf8");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "film-set card"]);
  return repo;
}

test("projectRoot uses git toplevel when PINNABLES_PROJECT_DIR is unset and cwd is a subfolder", async () => {
  const repo = await makeRepo();
  const prevDir = process.env.PINNABLES_PROJECT_DIR;
  const nested = join(repo, "packages", "service");
  try {
    delete process.env.PINNABLES_PROJECT_DIR;
    setProjectRootCwd(nested);
    assert.equal(projectRoot(), repo);
  } finally {
    setProjectRootCwd(null);
    if (prevDir === undefined) delete process.env.PINNABLES_PROJECT_DIR;
    else process.env.PINNABLES_PROJECT_DIR = prevDir;
    await rm(repo, { recursive: true, force: true });
  }
});

test("restore applies a repo-root-relative patch when the service cwd is a package subdirectory", async () => {
  const repo = await makeRepo();
  const home = await mkdtemp(join(tmpdir(), "pinnables-home-"));
  const prevHome = process.env.PINNABLES_HOME;
  const prevDir = process.env.PINNABLES_PROJECT_DIR;
  const nested = join(repo, "packages", "service");
  const card = join(repo, "fixtures", "film-set", "card.css");
  try {
    process.env.PINNABLES_HOME = home;
    delete process.env.PINNABLES_PROJECT_DIR;
    setProjectRootCwd(nested);
    assert.equal(projectRoot(), repo, "git apply must run at the repo root, not packages/service");

    await snapshot({
      boardId: "board-root",
      messageId: "baseline",
      pinIds: ["pin-card"],
      baseline: true,
    });

    await writeFile(card, "background: rose;\n", "utf8");
    await snapshot({
      boardId: "board-root",
      messageId: "take-rose",
      pinIds: ["pin-card"],
    });
    assert.equal(await readFile(card, "utf8"), "background: rose;\n");

    const result = await restore({
      boardId: "board-root",
      messageId: "baseline",
      fromMessageId: "take-rose",
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(card, "utf8"), "background: yellow;\n");
  } finally {
    setProjectRootCwd(null);
    if (prevDir === undefined) delete process.env.PINNABLES_PROJECT_DIR;
    else process.env.PINNABLES_PROJECT_DIR = prevDir;
    if (prevHome === undefined) delete process.env.PINNABLES_HOME;
    else process.env.PINNABLES_HOME = prevHome;
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
