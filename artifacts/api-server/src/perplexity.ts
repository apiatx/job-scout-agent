
export interface PerplexityOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function perplexitySearch(
  prompt: string,
  opts: PerplexityOptions = {}
): Promise<string> {
  const apiKey = process.env.PERPLEXITY_API_KEY?.trim();
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured');

  const model = opts.model ?? 'sonar-pro';
  const messages: { role: string; content: string }[] = [];
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const body: Record<string, any> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;

  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Perplexity ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = (await resp.json()) as any;
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

export function hasPerplexityKey(): boolean {
  return Boolean(process.env.PERPLEXITY_API_KEY?.trim());
}
