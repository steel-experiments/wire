import type { Task, TaskId } from "../shared/types.js";
import { taskSchema } from "../shared/schemas.js";
import { parseBoundary } from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  entityDir,
  entityPath,
  listJsonFiles,
  NotFoundError,
  readJsonFile,
} from "./atomic.js";

const KIND = "tasks";

function taskFilePath(root: string, id: TaskId): string {
  return entityPath(root, KIND, id);
}

export async function saveTask(root: string, task: Task): Promise<void> {
  const path = taskFilePath(root, task.id);
  await atomicWriteJson(path, task);
}

export async function loadTask(root: string, taskId: TaskId): Promise<Task> {
  const path = taskFilePath(root, taskId);

  const raw = await readJsonFile(path);
  if (raw === undefined) {
    throw new NotFoundError(KIND, taskId);
  }

  try {
    return parseBoundary<Task>(taskSchema, raw, "task");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function listTasks(root: string): Promise<Task[]> {
  const dir = entityDir(root, KIND);
  const files = await listJsonFiles(dir);

  const tasks: Task[] = [];

  for (const name of files) {
    const id = name.replace(/\.json$/u, "") as TaskId;
    const path = entityPath(root, KIND, id);

    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch {
      continue; // skip unreadable files during listing
    }

    try {
      tasks.push(parseBoundary<Task>(taskSchema, raw, "task"));
    } catch {
      continue; // skip corrupt files during listing
    }
  }

  return tasks;
}
