import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const versionsHref = new URL("../packages/service/src/versions.ts", import.meta.url).href;
const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pinnables-root-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  await mkdir(join(root, "packages", "service"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "card.css"), "body { background: white; }\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root });
  return realpathSync(root);
}

function runModule(gitCwd: string, env: NodeJS.ProcessEnv, source: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...env, PINNABLES_TEST_GIT_CWD: gitCwd },
  });
}

test("projectRoot uses git toplevel when cwd is a subfolder and PINNABLES_PROJECT_DIR is unset", async () => {
  const root = await makeRepo();
  const env = { ...process.env };
  delete env.PINNABLES_PROJECT_DIR;
  const out = runModule(
    join(root, "packages", "service"),
    env,
    `
      process.chdir(process.env.PINNABLES_TEST_GIT_CWD);
      delete process.env.PINNABLES_PROJECT_DIR;
      const { projectRoot, resetProjectRootCache } = await import(${JSON.stringify(versionsHref)});
      resetProjectRootCache();
      process.stdout.write(projectRoot());
    `,
  );
  assert.equal(out.trim(), root);
});

test("projectRoot prefers PINNABLES_PROJECT_DIR over git toplevel", async () => {
  const root = await makeRepo();
  const override = await mkdtemp(join(tmpdir(), "pinnables-override-"));
  const env = { ...process.env, PINNABLES_PROJECT_DIR: override };
  const out = runModule(
    join(root, "packages", "service"),
    env,
    `
      process.chdir(process.env.PINNABLES_TEST_GIT_CWD);
      const { projectRoot, resetProjectRootCache } = await import(${JSON.stringify(versionsHref)});
      resetProjectRootCache();
      process.stdout.write(projectRoot());
    `,
  );
  assert.equal(out.trim(), override);
});

test("restore/apply uses repo-root paths when the service cwd is a package folder", async () => {
  const root = await makeRepo();
  const home = await mkdtemp(join(tmpdir(), "pinnables-home-"));
  const env = { ...process.env, PINNABLES_HOME: home };
  delete env.PINNABLES_PROJECT_DIR;
  const out = runModule(
    join(root, "packages", "service"),
    env,
    `
      import { readFile, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      process.chdir(process.env.PINNABLES_TEST_GIT_CWD);
      delete process.env.PINNABLES_PROJECT_DIR;
      const { projectRoot, resetProjectRootCache, restore, snapshot } = await import(${JSON.stringify(versionsHref)});
      resetProjectRootCache();
      const root = ${JSON.stringify(root)};
      if (projectRoot() !== root) {
        throw new Error("projectRoot is " + projectRoot() + " expected " + root);
      }
      const file = join(root, "src", "card.css");
      await snapshot({ boardId: "b1", messageId: "baseline", pinIds: [], baseline: true });
      await writeFile(file, "body { background: green; }\\n");
      const green = await snapshot({ boardId: "b1", messageId: "msg-green", pinIds: [] });
      if (!green.files.some((rel) => rel === "src/card.css" || rel.endsWith("src/card.css"))) {
        throw new Error("expected src/card.css in " + JSON.stringify(green.files));
      }
      await writeFile(file, "body { background: rose; }\\n");
      const result = await restore({ boardId: "b1", messageId: "msg-green", fromMessageId: null });
      if (!result.ok) throw new Error("restore not ok");
      const afterGreen = await readFile(file, "utf8");
      if (!afterGreen.includes("green")) {
        throw new Error("restore did not apply repo-root patch, got: " + afterGreen);
      }
      await restore({ boardId: "b1", messageId: "baseline", fromMessageId: "msg-green" });
      const original = await readFile(file, "utf8");
      if (!original.includes("white")) {
        throw new Error("baseline restore failed, got: " + original);
      }
      process.stdout.write("ok " + green.files.join(","));
    `,
  );
  assert.match(out, /^ok /);
  assert.match(out, /src\/card\.css/);
});
