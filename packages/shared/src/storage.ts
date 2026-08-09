import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { BoardSchema, ProjectSchema, type Board, type Project } from "./schema.js";

/**
 * Board root. Defaults to ~/.pinnables so nothing lands in the user's git
 * tree; PINNABLES_HOME points it at fixtures during development.
 */
export function pinnablesHome(): string {
  const override = process.env.PINNABLES_HOME;
  return override ? resolve(override) : join(homedir(), ".pinnables");
}

function boardsDir(): string {
  return join(pinnablesHome(), "boards");
}

export function boardDir(boardId: string): string {
  return join(boardsDir(), boardId);
}

/**
 * Screenshot paths are stored relative to the board directory so a board
 * stays portable. Agents need absolute paths to read them.
 */
export function resolveAsset(boardId: string, assetPath: string): string {
  return isAbsolute(assetPath) ? assetPath : resolve(boardDir(boardId), assetPath);
}

export async function listBoardIds(): Promise<string[]> {
  try {
    const entries = await readdir(boardsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function readBoard(boardId: string): Promise<Board | null> {
  try {
    const raw = await readFile(join(boardDir(boardId), "board.json"), "utf8");
    return BoardSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readAllBoards(): Promise<Board[]> {
  const ids = await listBoardIds();
  const boards = await Promise.all(ids.map(readBoard));
  return boards.filter((b): b is Board => b !== null);
}

/** Write via temp file + rename so a crash can't leave a half-written board. */
export async function writeBoard(board: Board): Promise<void> {
  const dir = boardDir(board.id);
  await mkdir(dir, { recursive: true });
  const target = join(dir, "board.json");
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

export async function readProject(projectId: string): Promise<Project | null> {
  try {
    const raw = await readFile(join(pinnablesHome(), "projects", `${projectId}.json`), "utf8");
    return ProjectSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeProject(project: Project): Promise<void> {
  const dir = join(pinnablesHome(), "projects");
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${project.id}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await rename(temp, target);
}
