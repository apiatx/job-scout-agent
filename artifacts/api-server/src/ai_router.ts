/**
 * AI Router — unified provider abstraction for all AI calls.
 *
 * Returns an Anthropic-compatible { content: [{ type, text }] } response
 * regardless of which provider is active, so all existing callers work
 * unchanged when the mode is switched.
 *
 * Providers & models:
 *   claude  → claude-haiku-4-5                   (Anthropic)
 *   chatgpt → gpt-4o-mini                        (OpenAI)
 *   gemini  → gemini-2.5-flash-preview-05-20     (Google)
 *   grok    → grok-3-mini-fast                   (xAI, OpenAI-compatible)
 *
 * NOTE: `tools` (e.g. web_search) are only forwarded when mode === 'claude'.
 * Other providers silently drop the tools param and use text-only generation.
 */

import type { Pool } from 'pg';

export type AIMode = 'claude' | 'chatgpt' | 'gemini' | 'grok';

export const AI_CONFIG: Record<AIMode, { label: string; model: string; badge: string }> = {
  claude:  { label: 'Claude',  model: 'claude-haiku-4-5',        badge: '🟠' },
  chatgpt: { label: 'ChatGPT', model: 'gpt-5-mini',              badge: '🟢' },
  gemini:  { label: 'Gemini',  model: 'gemini-3-flash-preview',  badge: '🔵' },
  grok:    { label: 'Grok',    model: 'grok-4-fast',             badge: '🟣' },
};

let _pool: Pool | null = null;

export function initAIRouter(pool: Pool): void {
  _pool = pool;
}

export async function getAIMode(): Promise<AIMode> {
  if (!_pool) return 'claude';
  try {
    const { rows } = await _pool.query("SELECT value FROM settings WHERE key='ai_mode' LIMIT 1");
    const v = rows[0]?.value as string | undefined;
    if (v === 'chatgpt' || v === 'gemini' || v === 'grok') return v;
    return 'claude';
  } catch {
    return 'claude';
  }
}

export async function setAIMode(mode: AIMode): Promise<void> {
  if (!_pool) return;
  await _pool.query(
    "INSERT INTO settings (key,value) VALUES ('ai_mode',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
    [mode]
  );
}

export interface RouterTextBlock { type: 'text'; text: string }
export interface RouterResponse   { content: RouterTextBlock[] }

interface RouterParams {
  model?:       string;
  max_tokens?:  number;
  system?:      string;
  messages:     Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?:       any[];
  tool_choice?: any;
}

async function routeClaude(params: RouterParams): Promise<RouterResponse> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('Claude mode requires ANTHROPIC_API_KEY to be configured.');
  const opts: any = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL }
    : {};
  const client = new Anthropic({ apiKey, ...opts });
  const p: any = {
    model:      params.model || AI_CONFIG.claude.model,
    max_tokens: params.max_tokens || 1024,
    messages:   params.messages,
  };
  if (params.system)     p.system     = params.system;
  if (params.tools)      p.tools      = params.tools;
  if (params.tool_choice) p.tool_choice = params.tool_choice;
  const res = await client.messages.create(p);
  return {
    content: res.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => ({ type: 'text' as const, text: b.text as string })),
  };
}

async function routeChatGPT(params: RouterParams): Promise<RouterResponse> {
  const { default: OpenAI } = await import('openai');
  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('ChatGPT mode requires OPENAI_API_KEY to be configured in Settings.');
  const client = new OpenAI({ apiKey });
  const msgs: any[] = [];
  if (params.system) msgs.push({ role: 'system', content: params.system });
  msgs.push(...params.messages.map(m => ({ role: m.role, content: m.content })));
  const res = await client.chat.completions.create({
    model:                    AI_CONFIG.chatgpt.model,
    max_completion_tokens:    params.max_tokens || 1024,
    messages:                 msgs,
  } as any);
  return { content: [{ type: 'text', text: res.choices[0]?.message?.content || '' }] };
}

async function routeGemini(params: RouterParams): Promise<RouterResponse> {
  const { GoogleGenAI } = await import('@google/genai');
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Gemini mode requires GEMINI_API_KEY to be configured in Settings.');
  const client = new GoogleGenAI({ apiKey });
  const contents = params.messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const config: any = { maxOutputTokens: params.max_tokens || 1024 };
  if (params.system) config.systemInstruction = params.system;
  const res = await client.models.generateContent({
    model:    AI_CONFIG.gemini.model,
    contents,
    config,
  });
  return { content: [{ type: 'text', text: res.text || '' }] };
}

async function routeGrok(params: RouterParams): Promise<RouterResponse> {
  const { default: OpenAI } = await import('openai');
  const apiKey = (process.env.XAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('Grok mode requires XAI_API_KEY to be configured in Settings.');
  const client = new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1' });
  const msgs: any[] = [];
  if (params.system) msgs.push({ role: 'system', content: params.system });
  msgs.push(...params.messages.map(m => ({ role: m.role, content: m.content })));
  const res = await client.chat.completions.create({
    model:      AI_CONFIG.grok.model,
    max_tokens: params.max_tokens || 1024,
    messages:   msgs,
  });
  return { content: [{ type: 'text', text: res.choices[0]?.message?.content || '' }] };
}

export const aiRouter = {
  messages: {
    async create(params: RouterParams): Promise<RouterResponse> {
      const mode = await getAIMode();
      switch (mode) {
        case 'chatgpt': return routeChatGPT(params);
        case 'gemini':  return routeGemini(params);
        case 'grok':    return routeGrok(params);
        default:        return routeClaude(params);
      }
    },
  },
};
