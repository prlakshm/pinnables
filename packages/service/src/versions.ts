import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pinnablesHome } from "@pinnables/shared/storage";

const run = promisify(execFile);

/**
 * Version snapshots.
 *
 * A run changes source files and the state before it is gone. A version is what
 * lets you get back: the working tree's diff from HEAD at the moment a run
 * finished, stored as a patch.
 *
 * Git is used read-only and only as a diff engine. Nothing here stashes,
 * commits, checks out or otherwise touches the user's git state — the working
 * tree is the only thing written, and only by applying a patch.
 *
 * Restoring re-applies the run's own hunks and leaves everything else alone,
 * which is the whole reason patches are stored rather than whole files: an edit
 * made by hand elsewhere in the same file survives a restore. Only an edit that
 * overlaps a hunk is overwritten, and then only that hunk.
 *
 * Snapshots are project state, not board state — a component's conversation
 * outlives the board it started on, and its keys have to reach their patches
 * from whatever board holds the pin now. So they live in one flat namespace
 * per home; message ids are unique, and the HEAD stamp keeps a patch from one
 * project (or one chapter) from ever being applied against another.
 */

export function projectRoot(): string {
  return process.env.PINNABLES_PROJECT_DIR ?? process.cwd();
}

function versionsDir(): string {
  return join(pinnablesHome(), "versions");
}

function versionDir(messageId: string): string {
  return join(versionsDir(), messageId);
}

/**
 * The commit the working tree is standing on — the chapter. Everything a
 * conversation produces is stamped with it, and everything stamped with an
 * older one has been absorbed by a commit and stops being a way back.
 */
export async function currentHead(): Promise<string | null> {
  try {
    return (await git(["rev-parse", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

/** The chapter's own baseline id. Each HEAD gets one original. */
function baselineId(head: string | null): string {
  return `baseline-${(head ?? "detached").slice(0, 12)}`;
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd: projectRoot(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Versions need a diff engine, and git is it. Without a repo there is no cheap
 * way to know what a run changed, so the feature turns itself off rather than
 * guessing — and says so, so the extension can hide the rail instead of
 * offering keys that would not work.
 */
export async function versionsAvailable(): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"]);
    if (out.trim() !== "true") {
      return { ok: false, detail: `${projectRoot()} is not a git working tree` };
    }
    return { ok: true, detail: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: /ENOENT/.test(message)
        ? "git is not installed, so versions are unavailable"
        : `${projectRoot()} is not a git repository, so versions are unavailable`,
    };
  }
}

export interface VersionMeta {
  messageId: string;
  boardId: string;
  pinIds: string[];
  at: string;
  files: string[];
  /** True for the baseline taken before a chapter's first run. */
  baseline: boolean;
  /**
   * The commit this snapshot was diffed against. A restore only makes sense
   * inside its own chapter; when HEAD has moved the patch describes a tree
   * that no longer exists, and applying it would be a merge wearing a
   * restore's clothes. Null only in a detached/broken repo.
   */
  head: string | null;
  /**
   * Untracked files that already existed when the baseline was taken —
   * recordings, scratch notes, whatever lives in the tree without being of
   * it. Runs are diffed around them: they are not state, and a version that
   * embedded them would carry megabytes of someone's videos in every patch.
   * Recorded on the baseline only.
   */
  ambientUntracked?: string[];
}

async function listUntracked(): Promise<string[]> {
  return (await git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
}

/**
 * The working tree as it stands, relative to HEAD.
 *
 * `--binary` so an image the agent touched survives the round trip. Untracked
 * files need `--intent-to-add` to appear in the diff at all — a run that
 * creates a new component would otherwise snapshot as nothing — but only the
 * files the *runs* created are added: `ambient` is what was already lying
 * untracked before the first run (recordings, scratch, downloads), which is
 * not project state and must not balloon every patch. And the add is undone
 * before returning, whatever happens — the user's index is not this module's
 * to keep changed.
 */
async function currentPatch(ambient: string[]): Promise<{ patch: string; files: string[] }> {
  const skip = new Set(ambient);
  let added: string[] = [];
  try {
    added = (await listUntracked()).filter((path) => !skip.has(path));
    if (added.length) await git(["add", "--intent-to-add", "--", ...added]);
  } catch {
    /* Nothing to add, or the repo refuses; the tracked diff is still worth having. */
  }
  try {
    const patch = await git(["diff", "HEAD", "--binary"]);
    const names = (await git(["diff", "HEAD", "--name-only", "-z"]))
      .split("\0")
      .filter(Boolean);
    return { patch, files: names };
  } finally {
    if (added.length) await git(["reset", "-q", "--", ...added]).catch(() => {});
  }
}

export async function snapshot(input: {
  boardId: string;
  messageId: string;
  pinIds: string[];
  baseline?: boolean;
}): Promise<VersionMeta> {
  /*
   * Everything is chaptered by HEAD. "baseline" resolves to this chapter's
   * own original — each commit gets a fresh one, because the original of a
   * chapter is the tree that chapter started from.
   */
  const head = await currentHead();
  const messageId =
    input.messageId === "baseline" ? baselineId(head) : input.messageId;
  /*
   * The ambient set comes from the chapter's baseline: whatever was untracked
   * before the chapter's first run is scenery, not state, for every snapshot
   * after it. The baseline itself treats everything currently untracked as
   * ambient — its patch records tracked changes only.
   */
  const ambient = input.baseline
    ? await listUntracked()
    : ((await readMeta(baselineId(head)))?.ambientUntracked ?? []);
  const { patch, files } = await currentPatch(ambient);
  const dir = versionDir(messageId);
  await mkdir(dir, { recursive: true });

  const meta: VersionMeta = {
    messageId,
    boardId: input.boardId,
    pinIds: input.pinIds,
    at: new Date().toISOString(),
    files,
    baseline: input.baseline ?? false,
    head,
    ...(input.baseline ? { ambientUntracked: ambient } : {}),
  };
  await writeFile(join(dir, "patch.diff"), patch, "utf8");
  await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  /*
   * The patch alone cannot resolve an overlap. Keeping each changed file's
   * content as well gives the merge below a "theirs" side to work from, which
   * is what lets the version win a hunk without discarding the rest of the file.
   */
  const filesDir = join(dir, "files");
  await mkdir(filesDir, { recursive: true });
  await Promise.all(
    files.map(async (rel) => {
      try {
        const body = await readFile(join(projectRoot(), rel));
        await writeFile(join(filesDir, encodeURIComponent(rel)), body);
      } catch {
        /* Deleted by the run; the patch already records the deletion. */
      }
    }),
  );
  return meta;
}

export async function readMeta(messageId: string): Promise<VersionMeta | null> {
  try {
    const raw = await readFile(join(versionDir(messageId), "meta.json"), "utf8");
    return JSON.parse(raw) as VersionMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * This chapter's baseline, if it has been taken. The plain name "baseline"
 * is the caller-facing alias; which chapter it means is always the current
 * HEAD's, because a stale chapter's baseline is refused like any stale key.
 */
export async function readChapterBaseline(): Promise<VersionMeta | null> {
  return readMeta(baselineId(await currentHead()));
}

export async function listVersions(): Promise<VersionMeta[]> {
  try {
    const entries = await readdir(versionsDir(), { withFileTypes: true });
    const metas = await Promise.all(
      entries.filter((e) => e.isDirectory()).map((e) => readMeta(e.name)),
    );
    return metas
      .filter((m): m is VersionMeta => m !== null)
      .sort((a, b) => a.at.localeCompare(b.at));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Apply a stored patch, forward or in reverse.
 *
 * `--3way` is what makes a restore surgical: it applies the run's own hunks and
 * merges around edits made elsewhere in the same file, so unrelated work
 * survives. It needs the blobs the patch was built against, which is why the
 * patch is stored with `--binary` and taken against HEAD.
 *
 * Escalation is deliberate and bounded. A plain apply is tried next for the
 * case where three-way has nothing to merge against; only if both fail does the
 * file lose its local edits, and the caller is told which ones.
 */
async function applyPatch(patchPath: string, reverse: boolean): Promise<string[]> {
  const base = ["apply", ...(reverse ? ["-R"] : []), "--whitespace=nowarn"];
  try {
    await git([...base, "--3way", patchPath]);
    return [];
  } catch {
    /* fall through */
  }
  try {
    await git([...base, patchPath]);
    return [];
  } catch (err) {
    /*
     * Neither could place the hunks, which means something local overlaps them.
     * The version wins, but only for the files it actually names.
     */
    const message = err instanceof Error ? err.message : String(err);
    const conflicts = [...message.matchAll(/error: patch failed: ([^:]+):/g)].map((m) => m[1]);
    return conflicts.length ? [...new Set(conflicts)] : ["unknown"];
  }
}

/**
 * Put the working tree into the state a given version recorded.
 *
 * Two steps, because versions are siblings rather than a stack: undo whatever
 * version is currently applied, then apply the target. Both are diffs from
 * HEAD, so the tree passes through HEAD in between and never through some
 * third state that never existed.
 */
/*
 * The overlap case, resolved properly.
 *
 * Three-way merge with the version as "theirs": edits made elsewhere in the
 * file are kept, and where a hand edit sits on top of the very code the run
 * changed, the version wins. That is the whole of the rule — revert the
 * component's code, leave the rest of the file alone.
 */
async function mergeFile(messageId: string, rel: string): Promise<boolean> {
  const stored = join(versionDir(messageId), "files", encodeURIComponent(rel));
  let theirs: Buffer;
  try {
    theirs = await readFile(stored);
  } catch {
    return false;
  }

  const target = join(projectRoot(), rel);
  const scratch = join(tmpdir(), `pinnables-${process.pid}-${Date.now()}`);
  await mkdir(scratch, { recursive: true });
  const basePath = join(scratch, "base");
  const theirsPath = join(scratch, "theirs");

  try {
    /* The common ancestor both sides diverged from. */
    let base = "";
    try {
      base = await git(["show", `HEAD:${rel}`]);
    } catch {
      /* The run created this file, so there is no ancestor. */
    }
    await writeFile(basePath, base, "utf8");
    await writeFile(theirsPath, theirs);

    /* -p prints instead of writing in place; --theirs resolves conflicts to
       the version rather than leaving markers in someone's source. */
    const merged = await git(["merge-file", "-p", "--theirs", target, basePath, theirsPath]);
    await writeFile(target, merged, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function restore(input: {
  boardId: string;
  messageId: string;
  fromMessageId?: string | null;
}): Promise<{ ok: boolean; conflicts: string[]; files: string[] }> {
  const head = await currentHead();
  const resolve = (id: string) => (id === "baseline" ? baselineId(head) : id);
  const messageId = resolve(input.messageId);
  const fromMessageId = input.fromMessageId ? resolve(input.fromMessageId) : null;

  const target = await readMeta(messageId);
  if (!target) throw new Error(`No version recorded for ${messageId}`);

  /*
   * The chapter gate. A patch is only a restore against the tree it was
   * diffed from; once HEAD has moved — a commit, a pull, a branch switch —
   * applying it would merge two chapters and call the wreck a version. The
   * UI goes quiet on stale keys before this can be reached; this is the
   * backstop that makes the promise hold even for a stale client.
   */
  const stale = (meta: VersionMeta | null) =>
    meta !== null && meta.head !== undefined && meta.head !== head;
  if (stale(target)) {
    throw new Error(
      `Version ${messageId} belongs to an earlier chapter (HEAD has moved since); it is no longer restorable`,
    );
  }

  const conflicts: string[] = [];

  if (fromMessageId && fromMessageId !== messageId) {
    const from = await readMeta(fromMessageId);
    /* A stale "from" cannot be reversed either — but its edits are already
       absorbed by the commit that moved HEAD, so there is nothing to undo. */
    if (from && !stale(from)) {
      const path = join(versionDir(fromMessageId), "patch.diff");
      const raw = await readFile(path, "utf8").catch(() => "");
      if (raw.trim()) conflicts.push(...(await applyPatch(path, true)));
    }
  }

  const targetPath = join(versionDir(messageId), "patch.diff");
  const targetRaw = await readFile(targetPath, "utf8").catch(() => "");
  /* An empty patch is a real state: the tree as HEAD has it. */
  if (targetRaw.trim()) conflicts.push(...(await applyPatch(targetPath, false)));

  /*
   * Anything the patch could not place is merged file by file, with the version
   * winning the hunks it owns. Only a file that genuinely conflicted goes down
   * this path, and it still keeps its unrelated edits.
   */
  const unresolved: string[] = [];
  for (const rel of new Set(conflicts)) {
    const candidates = rel === "unknown" ? target.files : [rel];
    for (const file of candidates) {
      if (!(await mergeFile(messageId, file))) unresolved.push(file);
    }
  }

  return { ok: true, conflicts: unresolved, files: target.files };
}

export async function forget(messageId: string): Promise<void> {
  await rm(versionDir(messageId), { recursive: true, force: true });
}
