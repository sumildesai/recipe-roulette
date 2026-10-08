export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_JEV_MODEL = "typesafe/jev-1.13";

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion;
export type JevQuestions = Record<string, JevQuestion>;

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;
export type JevAnswers = Record<string, JevAnswer>;

export interface JevRequest {
  state: unknown;
  questions: JevQuestions;
}

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Sends one decision request to Jev through OpenRouter. Returns validated answers,
 * or null when the request fails after retries or the response does not answer
 * every question with the expected type.
 */
export async function decideWithJev(request: JevRequest, options: JevClientOptions): Promise<JevAnswers | null> {
  const doFetch = options.fetch ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const body = JSON.stringify({ model: options.model ?? DEFAULT_JEV_MODEL, state: request.state, questions: request.questions });

  for (let attempt = 0; ; attempt++) {
    let retryable = false;
    let failure: string;
    try {
      const response = await doFetch(JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
      });
      if (response.ok) {
        const answers = validateJevAnswers(await response.json(), request.questions);
        if (answers) return answers;
        failure = "response did not answer every question with the expected type";
      } else {
        retryable = RETRYABLE_STATUS.has(response.status);
        failure = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
      }
    } catch (error) {
      retryable = true;
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!retryable || attempt >= maxRetries) {
      console.warn(`Jev decision request failed: ${failure}`);
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
  }
}

export function validateJevAnswers(body: unknown, questions: JevQuestions): JevAnswers | null {
  if (!isRecord(body) || !isRecord(body.answers)) return null;
  const answers: JevAnswers = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = body.answers[name];
    if (!isRecord(answer) || answer.type !== question.type) return null;
    if (question.type === "noul") {
      if (!isProbability(answer.noul)) return null;
      answers[name] = { type: "noul", noul: answer.noul };
    } else {
      if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice)) return null;
      if (!isProbability(answer.confidence)) return null;
      const probabilities: Record<string, number> = {};
      if (isRecord(answer.probabilities)) {
        for (const [option, probability] of Object.entries(answer.probabilities)) {
          if (Object.hasOwn(question.criteria, option) && isProbability(probability)) probabilities[option] = probability;
        }
      }
      answers[name] = { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities };
    }
  }
  return answers;
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
