import Anthropic from '@anthropic-ai/sdk';

export interface SalaryEstimate {
  baseLow: number;
  baseHigh: number;
  oteLow: number;
  oteHigh: number;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
  notes: string;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
  ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL }
    : {}),
});

export async function estimateSalary(jobTitle: string, companyName: string): Promise<SalaryEstimate> {
  const prompt = `Search for salary and OTE compensation data for a ${jobTitle} role at ${companyName}. Search Glassdoor, LinkedIn Salary, Levels.fyi, Indeed Salaries, Builtin.com, and any other relevant sources. Also search for '${companyName} sales rep salary' and '${companyName} account executive OTE'. Return ONLY a JSON object:
{
  "baseLow": number in USD,
  "baseHigh": number in USD,
  "oteLow": number in USD,
  "oteHigh": number in USD,
  "confidence": "high" if multiple sources agree, "medium" if one good source, "low" if estimated,
  "sources": ["list of sources used"],
  "notes": "brief explanation of the estimate and any caveats"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2000,
    system: 'You are a compensation research assistant. After using web search to gather salary data, respond with ONLY a valid JSON object. No conversational text, no markdown — just the raw JSON starting with { and ending with }.',
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
    messages: [{ role: 'user', content: prompt }],
  });

  const textBlocks: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      textBlocks.push(block.text);
    }
  }

  for (let i = textBlocks.length - 1; i >= 0; i--) {
    let text = textBlocks[i].trim();
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    try {
      return JSON.parse(text) as SalaryEstimate;
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*"baseLow"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]) as SalaryEstimate;
        } catch { /* continue */ }
      }
    }
  }

  throw new Error(`Failed to parse salary estimate from Claude response`);
}
