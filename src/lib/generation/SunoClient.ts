// Minimal client for Suno v5.5's HTTP API.
//
// This file deliberately doesn't ship in the React Native bundle — it's
// imported only from server-side scripts and Edge functions, where a real
// API key + service-role auth lives. Keeping the surface area tight makes it
// easy to swap to a different generator (Udio, custom pipeline) later.
//
// Endpoints used:
//   POST /api/v5/generate          → kicks off a generation task
//   GET  /api/v5/tasks/:task_id    → polls for status + asset URLs
//
// All values returned by Suno (titles, urls, etc.) are treated as untrusted
// input — never `eval` them, never feed them into a SQL string. The DB layer
// uses parameterised inserts, so we're fine on that front.

export interface SunoCredentials {
  apiKey: string;
  baseUrl?: string; // defaults to https://api.suno.ai
}

export interface SunoGenerateRequest {
  prompt: string;
  /** Style/genre hint. Optional but improves consistency. */
  style?: string;
  /** "male" | "female" | "instrumental" — Suno respects this most of the time. */
  vocal_gender?: 'male' | 'female' | 'instrumental';
  /** Title hint. Suno may still rename. */
  title?: string;
  /** Duration target in seconds (60..240 typical). */
  target_duration_seconds?: number;
  /** "v5.5" by default. */
  model?: string;
}

export interface SunoGenerateResponse {
  task_id: string;
  status: 'pending' | 'generating';
}

export interface SunoTaskResult {
  task_id: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  audio_url: string | null;
  cover_url: string | null;
  duration_seconds: number | null;
  title: string | null;
  /**
   * Suno's self-reported confidence metrics. We treat these as priors and
   * still run our own QualityFilter on top.
   */
  metrics?: {
    coherence?: number;     // 0..1
    audio_quality?: number; // 0..1
    vocal_clarity?: number; // 0..1
  };
  error_message?: string;
}

const DEFAULT_BASE = 'https://api.suno.ai';

export class SunoClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(creds: SunoCredentials) {
    if (!creds.apiKey) throw new Error('SunoClient: apiKey is required');
    this.apiKey = creds.apiKey;
    this.baseUrl = creds.baseUrl ?? DEFAULT_BASE;
  }

  /** Kick off a generation. Resolves once Suno acknowledges the task. */
  async generate(req: SunoGenerateRequest): Promise<SunoGenerateResponse> {
    const res = await fetch(`${this.baseUrl}/api/v5/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: req.prompt,
        style: req.style,
        vocal_gender: req.vocal_gender,
        title: req.title,
        target_duration_seconds: req.target_duration_seconds ?? 180,
        model: req.model ?? 'v5.5',
      }),
    });
    if (!res.ok) throw new Error(`suno generate failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as SunoGenerateResponse;
  }

  /** Single-shot poll. Use `waitForCompletion` for the common case. */
  async getTask(task_id: string): Promise<SunoTaskResult> {
    const res = await fetch(`${this.baseUrl}/api/v5/tasks/${encodeURIComponent(task_id)}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`suno get task failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as SunoTaskResult;
  }

  /**
   * Poll until a task is completed/failed, or timeout. Suno tasks usually
   * complete in 30-120s; we cap at 6 minutes by default.
   */
  async waitForCompletion(task_id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<SunoTaskResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 6 * 60 * 1000);
    const poll = opts.pollMs ?? 5000;
    while (true) {
      const t = await this.getTask(task_id);
      if (t.status === 'completed' || t.status === 'failed') return t;
      if (Date.now() > deadline) {
        return { ...t, status: 'failed', error_message: 'timeout waiting for completion' };
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}
