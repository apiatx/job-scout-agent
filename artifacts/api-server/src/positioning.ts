/**
 * Career Positioning Engine
 *
 * Step 1: Guided intake form (profile)
 * Step 2: Story bank (CAR format with theme tags)
 * Step 3: Claude-generated outputs from one source of truth
 * Step 4: Objection handling (Claude-generated)
 * Step 5: Core narrative approval and storage
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PositioningProfile {
  target_role: string;
  target_industry: string;
  past_roles: string;
  top_wins: string;
  strengths: string;
  want_next: string;
  dont_want: string;
  pivot_concerns: string;
  why_now: string;
  biggest_objection: string;
}

export interface Story {
  id?: number;
  title: string;
  context: string;
  action: string;
  result: string;
  themes: string[];
  metrics: string;
  confidence: number;
  created_at?: string;
}

export interface PositioningOutputs {
  professional_summary: string;
  linkedin_headline: string;
  linkedin_about: string;
  elevator_pitch: string;
  recruiter_intro: string;
  tell_me_about_yourself: string;
  cover_letter_themes: string;
  networking_bio: string;
  generated_at: string;
  model_used: string;
}

export interface ObjectionItem {
  objection: string;
  why_it_arises: string;
  how_to_address: string;
  best_proof_points: string;
}

export interface ObjectionHandling {
  objections: ObjectionItem[];
  generated_at: string;
}

export interface CoreNarrative {
  target_narrative: string;
  why_me: string;
  why_now: string;
  category_positioning: string;
  ideal_role_thesis: string;
  approved: boolean;
  approved_at: string | null;
}

// ── DB Migrations ─────────────────────────────────────────────────────────────

export async function initPositioningDB(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS positioning_profile (
      id SERIAL PRIMARY KEY,
      target_role TEXT NOT NULL DEFAULT '',
      target_industry TEXT NOT NULL DEFAULT '',
      past_roles TEXT NOT NULL DEFAULT '',
      top_wins TEXT NOT NULL DEFAULT '',
      strengths TEXT NOT NULL DEFAULT '',
      want_next TEXT NOT NULL DEFAULT '',
      dont_want TEXT NOT NULL DEFAULT '',
      pivot_concerns TEXT NOT NULL DEFAULT '',
      why_now TEXT NOT NULL DEFAULT '',
      biggest_objection TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS story_bank (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      themes TEXT[] NOT NULL DEFAULT '{}',
      metrics TEXT NOT NULL DEFAULT '',
      confidence INT NOT NULL DEFAULT 3,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS positioning_outputs (
      id SERIAL PRIMARY KEY,
      professional_summary TEXT NOT NULL DEFAULT '',
      linkedin_headline TEXT NOT NULL DEFAULT '',
      linkedin_about TEXT NOT NULL DEFAULT '',
      elevator_pitch TEXT NOT NULL DEFAULT '',
      recruiter_intro TEXT NOT NULL DEFAULT '',
      tell_me_about_yourself TEXT NOT NULL DEFAULT '',
      cover_letter_themes TEXT NOT NULL DEFAULT '',
      networking_bio TEXT NOT NULL DEFAULT '',
      model_used TEXT NOT NULL DEFAULT '',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS objection_handling (
      id SERIAL PRIMARY KEY,
      objections JSONB NOT NULL DEFAULT '[]',
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS core_narrative (
      id SERIAL PRIMARY KEY,
      target_narrative TEXT NOT NULL DEFAULT '',
      why_me TEXT NOT NULL DEFAULT '',
      why_now TEXT NOT NULL DEFAULT '',
      category_positioning TEXT NOT NULL DEFAULT '',
      ideal_role_thesis TEXT NOT NULL DEFAULT '',
      approved BOOLEAN NOT NULL DEFAULT false,
      approved_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Profile CRUD ──────────────────────────────────────────────────────────────

export async function getProfile(pool: Pool): Promise<PositioningProfile | null> {
  const { rows } = await pool.query('SELECT * FROM positioning_profile ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

export async function saveProfile(pool: Pool, profile: PositioningProfile): Promise<void> {
  const existing = await pool.query('SELECT id FROM positioning_profile LIMIT 1');
  if (existing.rows.length > 0) {
    await pool.query(`
      UPDATE positioning_profile SET
        target_role=$1, target_industry=$2, past_roles=$3, top_wins=$4,
        strengths=$5, want_next=$6, dont_want=$7, pivot_concerns=$8,
        why_now=$9, biggest_objection=$10, updated_at=NOW()
      WHERE id=$11
    `, [
      profile.target_role, profile.target_industry, profile.past_roles, profile.top_wins,
      profile.strengths, profile.want_next, profile.dont_want, profile.pivot_concerns,
      profile.why_now, profile.biggest_objection, existing.rows[0].id
    ]);
  } else {
    await pool.query(`
      INSERT INTO positioning_profile
        (target_role, target_industry, past_roles, top_wins, strengths, want_next, dont_want, pivot_concerns, why_now, biggest_objection)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      profile.target_role, profile.target_industry, profile.past_roles, profile.top_wins,
      profile.strengths, profile.want_next, profile.dont_want, profile.pivot_concerns,
      profile.why_now, profile.biggest_objection
    ]);
  }
}

// ── Story Bank CRUD ───────────────────────────────────────────────────────────

export async function getStories(pool: Pool): Promise<Story[]> {
  const { rows } = await pool.query('SELECT * FROM story_bank ORDER BY created_at DESC');
  return rows;
}

export async function saveStory(pool: Pool, story: Story): Promise<Story> {
  if (story.id) {
    await pool.query(`
      UPDATE story_bank SET title=$1, context=$2, action=$3, result=$4, themes=$5, metrics=$6, confidence=$7 WHERE id=$8
    `, [story.title, story.context, story.action, story.result, story.themes, story.metrics, story.confidence, story.id]);
    const { rows } = await pool.query('SELECT * FROM story_bank WHERE id=$1', [story.id]);
    return rows[0];
  } else {
    const { rows } = await pool.query(`
      INSERT INTO story_bank (title, context, action, result, themes, metrics, confidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [story.title, story.context, story.action, story.result, story.themes, story.metrics, story.confidence]);
    return rows[0];
  }
}

export async function deleteStory(pool: Pool, id: number): Promise<void> {
  await pool.query('DELETE FROM story_bank WHERE id=$1', [id]);
}

// ── Claude Generation ─────────────────────────────────────────────────────────

function buildProfileContext(profile: PositioningProfile, stories: Story[]): string {
  const storyText = stories.map(s =>
    `STORY: ${s.title}\n  Context: ${s.context}\n  Action: ${s.action}\n  Result: ${s.result}\n  Metrics: ${s.metrics}\n  Themes: ${s.themes.join(', ')}`
  ).join('\n\n');

  return `
TARGET ROLE: ${profile.target_role}
TARGET INDUSTRY: ${profile.target_industry}
PAST ROLES: ${profile.past_roles}
TOP 5 WINS: ${profile.top_wins}
STRENGTHS: ${profile.strengths}
WHAT THEY WANT NEXT: ${profile.want_next}
WHAT THEY DON'T WANT: ${profile.dont_want}
CAREER PIVOT CONCERNS: ${profile.pivot_concerns}
WHY NOW: ${profile.why_now}
BIGGEST EXPECTED OBJECTION: ${profile.biggest_objection}

STORY BANK:
${storyText || '(No stories added yet)'}
`.trim();
}

export async function generateOutputs(pool: Pool, profile: PositioningProfile, stories: Story[]): Promise<PositioningOutputs> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
  const context = buildProfileContext(profile, stories);

  const prompt = `You are an elite executive career coach. Based on the candidate profile below, generate all 8 positioning outputs. These must all be consistent — same voice, same positioning, same story — because they come from one source of truth.

${context}

Return ONLY a valid JSON object with exactly these keys:
{
  "professional_summary": "3-4 sentence resume summary, first person, metric-rich",
  "linkedin_headline": "Under 220 chars, role | value prop | differentiator",
  "linkedin_about": "400-600 word LinkedIn About section, first person, storytelling arc, ends with what you're looking for",
  "elevator_pitch": "60-second spoken pitch, conversational, hooks with a result, ends with a question",
  "recruiter_intro": "2-3 sentences to use when a recruiter reaches out cold, professional, specific about what you want",
  "tell_me_about_yourself": "90-second structured answer: past, pivot reason, present strengths, future target",
  "cover_letter_themes": "3-4 bullet themes to use across cover letters, each with a supporting proof point from the story bank",
  "networking_bio": "150-word third-person bio for introductions and networking contexts"
}

Be specific, metric-rich, and consistent. Do not use placeholder text. Use the actual stories and wins from the profile.`;

  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = (message.content[0] as { type: string; text: string }).text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for positioning outputs');
  const outputs = JSON.parse(jsonMatch[0]);

  const { rows: existing } = await pool.query('SELECT id FROM positioning_outputs LIMIT 1');
  if (existing.length > 0) {
    await pool.query(`
      UPDATE positioning_outputs SET
        professional_summary=$1, linkedin_headline=$2, linkedin_about=$3,
        elevator_pitch=$4, recruiter_intro=$5, tell_me_about_yourself=$6,
        cover_letter_themes=$7, networking_bio=$8, model_used=$9, generated_at=NOW()
      WHERE id=$10
    `, [outputs.professional_summary, outputs.linkedin_headline, outputs.linkedin_about,
        outputs.elevator_pitch, outputs.recruiter_intro, outputs.tell_me_about_yourself,
        outputs.cover_letter_themes, outputs.networking_bio, model, existing[0].id]);
  } else {
    await pool.query(`
      INSERT INTO positioning_outputs
        (professional_summary, linkedin_headline, linkedin_about, elevator_pitch,
         recruiter_intro, tell_me_about_yourself, cover_letter_themes, networking_bio, model_used)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [outputs.professional_summary, outputs.linkedin_headline, outputs.linkedin_about,
        outputs.elevator_pitch, outputs.recruiter_intro, outputs.tell_me_about_yourself,
        outputs.cover_letter_themes, outputs.networking_bio, model]);
  }

  return { ...outputs, generated_at: new Date().toISOString(), model_used: model };
}

export async function getOutputs(pool: Pool): Promise<PositioningOutputs | null> {
  const { rows } = await pool.query('SELECT * FROM positioning_outputs ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

export async function generateObjections(pool: Pool, profile: PositioningProfile, stories: Story[]): Promise<ObjectionHandling> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
  const context = buildProfileContext(profile, stories);

  const prompt = `You are an elite executive career coach preparing a candidate for real recruiter and hiring manager objections. Based on the profile below, generate a comprehensive objection handling guide.

${context}

Analyze the profile and identify the most likely concerns a recruiter or hiring manager would raise. Include objections from these categories where relevant:
- Title mismatch (title doesn't match the level they're targeting)
- Industry switch (moving to a new vertical)
- No direct management experience
- Too enterprise / too SMB
- Job-hopper risk (short tenures)
- Underqualified / overqualified
- Geography / remote concerns
- Compensation expectations
- Any others specific to this candidate's profile

Return ONLY a valid JSON object:
{
  "objections": [
    {
      "objection": "The specific objection a recruiter/HM would raise",
      "why_it_arises": "Why this concern comes up given the candidate's background",
      "how_to_address": "Honest, direct way to address it in conversation",
      "best_proof_points": "Specific stories or metrics from the profile that rebut this concern"
    }
  ]
}

Generate 5-8 objections most relevant to this specific candidate. Be honest — if there's a real weakness, say so and give a real answer.`;

  const message = await client.messages.create({
    model,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = (message.content[0] as { type: string; text: string }).text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for objection handling');
  const parsed = JSON.parse(jsonMatch[0]);

  const { rows: existing } = await pool.query('SELECT id FROM objection_handling LIMIT 1');
  if (existing.length > 0) {
    await pool.query('UPDATE objection_handling SET objections=$1, generated_at=NOW() WHERE id=$2',
      [JSON.stringify(parsed.objections), existing[0].id]);
  } else {
    await pool.query('INSERT INTO objection_handling (objections) VALUES ($1)', [JSON.stringify(parsed.objections)]);
  }

  return { objections: parsed.objections, generated_at: new Date().toISOString() };
}

export async function getObjections(pool: Pool): Promise<ObjectionHandling | null> {
  const { rows } = await pool.query('SELECT * FROM objection_handling ORDER BY id DESC LIMIT 1');
  if (!rows[0]) return null;
  return { objections: rows[0].objections, generated_at: rows[0].generated_at };
}

// ── Core Narrative ────────────────────────────────────────────────────────────

export async function getNarrative(pool: Pool): Promise<CoreNarrative | null> {
  const { rows } = await pool.query('SELECT * FROM core_narrative ORDER BY id DESC LIMIT 1');
  return rows[0] || null;
}

export async function saveNarrative(pool: Pool, narrative: CoreNarrative): Promise<void> {
  const existing = await pool.query('SELECT id FROM core_narrative LIMIT 1');
  if (existing.rows.length > 0) {
    await pool.query(`
      UPDATE core_narrative SET
        target_narrative=$1, why_me=$2, why_now=$3,
        category_positioning=$4, ideal_role_thesis=$5,
        approved=$6, approved_at=$7, updated_at=NOW()
      WHERE id=$8
    `, [
      narrative.target_narrative, narrative.why_me, narrative.why_now,
      narrative.category_positioning, narrative.ideal_role_thesis,
      narrative.approved, narrative.approved ? new Date().toISOString() : null,
      existing.rows[0].id
    ]);
  } else {
    await pool.query(`
      INSERT INTO core_narrative (target_narrative, why_me, why_now, category_positioning, ideal_role_thesis, approved)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [narrative.target_narrative, narrative.why_me, narrative.why_now,
        narrative.category_positioning, narrative.ideal_role_thesis, narrative.approved]);
  }
}

export async function draftNarrative(pool: Pool, profile: PositioningProfile, stories: Story[]): Promise<CoreNarrative> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
  const context = buildProfileContext(profile, stories);

  const prompt = `You are an elite executive career coach. Based on the candidate profile, draft their core narrative — the single source of truth that drives all their career messaging.

${context}

Return ONLY a valid JSON object:
{
  "target_narrative": "2-3 sentences: who they are, what they do best, where they're going and why. This is their north star statement.",
  "why_me": "3-4 sentences explaining their unique differentiator — what they bring that few others can. Be specific to their actual background.",
  "why_now": "2-3 sentences explaining why this is the right moment for their move — market timing, career arc, personal readiness.",
  "category_positioning": "1-2 sentences on how to categorize them in a recruiter's mind. What bucket do they own?",
  "ideal_role_thesis": "2-3 sentences on exactly what role they should be targeting and why — specific enough to guide both resume tailoring and outreach."
}`;

  const message = await client.messages.create({
    model,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = (message.content[0] as { type: string; text: string }).text;
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return valid JSON for narrative draft');
  const draft = JSON.parse(jsonMatch[0]);
  return { ...draft, approved: false, approved_at: null };
}
