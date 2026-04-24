import type { BrowserSession, SessionId } from "../shared/types.js";
import { browserSessionSchema, parseBoundary } from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  entityDir,
  entityPath,
  listJsonFiles,
  NotFoundError,
  readJsonFile,
} from "./atomic.js";

const KIND = "sessions";

function sessionFilePath(root: string, id: SessionId): string {
  return entityPath(root, KIND, id);
}

export async function saveSession(root: string, session: BrowserSession): Promise<void> {
  await atomicWriteJson(sessionFilePath(root, session.id), session);
}

export async function loadSession(root: string, sessionId: SessionId): Promise<BrowserSession> {
  const path = sessionFilePath(root, sessionId);

  const raw = await readJsonFile(path);
  if (raw === undefined) {
    throw new NotFoundError(KIND, sessionId);
  }

  try {
    return parseBoundary<BrowserSession>(browserSessionSchema, raw, "browser-session");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function listSessions(root: string): Promise<BrowserSession[]> {
  const dir = entityDir(root, KIND);
  const files = await listJsonFiles(dir);

  const sessions: BrowserSession[] = [];

  for (const name of files) {
    const id = name.replace(/\.json$/u, "") as SessionId;
    const path = entityPath(root, KIND, id);

    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch {
      continue;
    }

    try {
      sessions.push(parseBoundary<BrowserSession>(browserSessionSchema, raw, "browser-session"));
    } catch {
      continue;
    }
  }

  return sessions;
}
