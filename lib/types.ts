// Client-safe types (no server-only imports). Mirrors the shape returned by
// GET /api/state.

export type Stage = "local" | "develop" | "production";
export type Status = "todo" | "in_progress" | "blocked" | "done";

export interface QuestionView {
  id: number;
  task_id: number;
  text: string;
  answer: string | null;
  answered: boolean;
  created_at: string;
  answered_at: string | null;
}

export interface AttachmentView {
  id: number;
  filename: string;
  mime: string;
}

export interface FollowupView {
  id: number;
  task_id: number;
  text: string;
  response: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface TaskView {
  id: number;
  document_id: number;
  title: string;
  body: string;
  status: Status;
  tested: boolean;
  stage: Stage;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_heartbeat: string | null;
  heartbeat_note: string | null;
  summary: string | null;
  commit_requested: boolean;
  commit_hash: string | null;
  committed_at: string | null;
  archived: boolean;
  questions: QuestionView[];
  attachments: AttachmentView[];
  followups: FollowupView[];
}

export interface DocumentView {
  id: number;
  project_id: number;
  name: string;
  created_at: string;
  tasks: TaskView[];
}

export interface ProjectView {
  id: number;
  name: string;
  path: string | null;
  target_branch: string;
  push_requested: boolean;
  last_push_at: string | null;
  push_status: string | null;
  last_seen: string | null;
  push_stage: string;
  powered_off_at: string | null;
  auto_worker: boolean;
  worker_running: boolean;
  worker_started_at: string | null;
  worker_model: string | null;
  created_at: string;
  documents: DocumentView[];
}

export function openQuestionCount(p: ProjectView): number {
  let n = 0;
  for (const doc of p.documents)
    for (const t of doc.tasks)
      for (const q of t.questions) if (!q.answered) n++;
  return n;
}
