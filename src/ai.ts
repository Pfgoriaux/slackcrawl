// AI clients — plain fetch, no SDKs. Same pattern as SlackClient.

export class ClaudeClient {
  private lastCallMs = 0;
  private readonly minIntervalMs = 500;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(prompt: string, system?: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    await this.rateLimit();

    const messages: { role: string; content: string }[] = [
      { role: "user", content: prompt },
    ];

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages,
    };
    if (system) body.system = system;

    const data = await this.post<{
      content: { type: string; text: string }[];
      usage: { input_tokens: number; output_tokens: number };
    }>(body);

    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    return {
      text,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    return withRetry(async () => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "30");
        throw new RateLimitError(retryAfter * 1000);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Claude HTTP ${res.status}: ${text}`);
      }

      return (await res.json()) as T;
    });
  }

  private async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastCallMs;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastCallMs = Date.now();
  }
}

export class EmbeddingClient {
  private lastCallMs = 0;
  private readonly minIntervalMs = 200;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  /** Embed multiple texts in one call. Returns array of Float32Array embeddings. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.rateLimit();

    const data = await this.post<{
      data: { embedding: number[]; index: number }[];
      usage: { prompt_tokens: number; total_tokens: number };
    }>({
      model: this.model,
      input: texts,
    });

    // Sort by index to match input order
    const sorted = data.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }

  /** Embed a single text. Returns one Float32Array. */
  async embedOne(text: string): Promise<Float32Array> {
    const results = await this.embed([text]);
    return results[0];
  }

  private async post<T>(body: Record<string, unknown>): Promise<T> {
    return withRetry(async () => {
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") ?? "30");
        throw new RateLimitError(retryAfter * 1000);
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI HTTP ${res.status}: ${text}`);
      }

      return (await res.json()) as T;
    });
  }

  private async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastCallMs;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastCallMs = Date.now();
  }
}

// ---- Shared helpers ----

class RateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limited, retry after ${retryAfterMs}ms`);
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RateLimitError) {
        const wait = err.retryAfterMs + Math.random() * 5000;
        console.log(`[ai] rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${maxAttempts})`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`AI: exceeded max retries (${maxAttempts})`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
