export function parseJSON<T>(text: string, fallback: T): T {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "");
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

export function splitTopics(text: string): [string, string] {
  const idx = text.lastIndexOf("TOPICS:");
  if (idx === -1) return [text, ""];
  return [text.slice(0, idx).trim(), text.slice(idx + 7).trim()];
}
