// Lee las ramas REALES del remoto de un proyecto, para que el humano elija el
// destino de push de una lista en vez de tipearlo a mano. Se conecta al remoto
// con `git ls-remote` (no necesita un fetch previo ni refs locales frescas).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface RemoteBranches {
  branches: string[]; // nombres de rama (refs/heads/<x> → <x>), ordenados
  remote: string | null; // URL del remoto origin, para mostrar en la UI
  error: string | null; // null = ok; si no, mensaje corto para la UI
}

// GIT_TERMINAL_PROMPT=0 evita que git se cuelgue pidiendo credenciales por
// stdin cuando el remoto es privado y no hay auth configurada.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

function short(msg: string): string {
  const line = msg.split("\n").find((l) => l.trim()) ?? msg;
  return line.trim().slice(0, 200);
}

export async function listRemoteBranches(
  projectPath: string | null
): Promise<RemoteBranches> {
  if (!projectPath) {
    return {
      branches: [],
      remote: null,
      error: "el proyecto no tiene path configurado en TaskApp",
    };
  }

  // ¿Tiene remoto 'origin'? Si no, no hay nada que listar.
  let remote: string | null = null;
  try {
    const { stdout } = await pexec(
      "git",
      ["-C", projectPath, "remote", "get-url", "origin"],
      { timeout: 5000, env: GIT_ENV }
    );
    remote = stdout.trim() || null;
  } catch {
    remote = null;
  }
  if (!remote) {
    return {
      branches: [],
      remote: null,
      error: "el repo no tiene un remoto 'origin' configurado",
    };
  }

  try {
    const { stdout } = await pexec(
      "git",
      ["-C", projectPath, "ls-remote", "--heads", "origin"],
      { timeout: 20000, env: GIT_ENV, maxBuffer: 4 * 1024 * 1024 }
    );
    const branches = stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[1] ?? "")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length))
      .sort((a, b) => a.localeCompare(b));
    return { branches, remote, error: null };
  } catch (e) {
    return {
      branches: [],
      remote,
      error: short(e instanceof Error ? e.message : String(e)),
    };
  }
}
