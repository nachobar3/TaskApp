// Claude Code models offered per project for workers. We use aliases (not
// pinned ids) so "opus" always means the latest Opus — the default tracks the
// newest model without code changes. `claude --model <alias>` accepts these.

export interface WorkerModel {
  alias: string;
  label: string;
  hint: string;
}

export const WORKER_MODELS: WorkerModel[] = [
  { alias: "opus", label: "Opus", hint: "máxima capacidad (último)" },
  { alias: "sonnet", label: "Sonnet", hint: "rápido y muy capaz" },
  { alias: "haiku", label: "Haiku", hint: "el más rápido/barato" },
];

// NULL/unset in the DB → the latest model. Today that alias is "opus".
export const DEFAULT_WORKER_MODEL = "opus";

export function resolveWorkerModel(stored: string | null | undefined): string {
  if (stored && WORKER_MODELS.some((m) => m.alias === stored)) return stored;
  return process.env.TASKAPP_WORKER_MODEL || DEFAULT_WORKER_MODEL;
}

export function isValidWorkerModel(alias: unknown): alias is string {
  return (
    typeof alias === "string" && WORKER_MODELS.some((m) => m.alias === alias)
  );
}
