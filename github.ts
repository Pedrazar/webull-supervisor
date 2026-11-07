/**
 * GitHub reads: workflow runs and trade logs of the agents' public repos.
 * Uses the Actions-provided GITHUB_TOKEN (read access to public repos is
 * enough; it only raises the rate limit from 60 to 1,000 requests/hour).
 */

const API = "https://api.github.com";

function headers(accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "webull-supervisor",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export interface WorkflowRun {
  id: number;
  html_url: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | timed_out | ...
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  event: string;
}

/** Runs of one workflow created on or after `sinceIso` (UTC), newest first. */
export async function listRuns(owner: string, repo: string, workflow: string, sinceIso: string): Promise<WorkflowRun[]> {
  const url = `${API}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=100&created=${encodeURIComponent(">=" + sinceIso)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub runs ${owner}/${repo}/${workflow}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
  return body.workflow_runs ?? [];
}

/** Raw file content from the default branch, or null if it doesn't exist. */
export async function getFile(owner: string, repo: string, path: string): Promise<string | null> {
  const url = `${API}/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetch(url, { headers: headers("application/vnd.github.raw+json") });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub file ${owner}/${repo}/${path}: ${res.status} ${await res.text()}`);
  return res.text();
}
