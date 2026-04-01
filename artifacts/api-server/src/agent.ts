import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import type { ScrapedJob } from './scraper.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
  ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL }
    : {}),
});

// ─────────────────────────────────────────────────────────────────────────────
// SubScores — 5-component system (v2)
//
// The 5 components sum to a 0-100 matchScore directly:
//   roleFit        0-30   Role title/level match
//   companyQuality 0-25   Company momentum, pre-approval status, AI risk
//   compensationFit 0-20  Salary vs candidate minimum
//   locationFit    0-15   Remote/location preference match
//   territoryFit   0-10   Territory match (7 default when no territory detected)
//
// realVsFake (0-10) is a hard-skip gate only — not counted in matchScore.
//
// Backward compatibility: old stored sub_scores lack `compensationFit`.
// computeTier() detects format via presence of `compensationFit`.
// ─────────────────────────────────────────────────────────────────────────────
export interface SubScores {
  roleFit:          number;   // 0-30
  companyQuality:   number;   // 0-25
  compensationFit:  number;   // 0-20  (new; undefined on legacy stored data)
  locationFit:      number;   // 0-15
  territoryFit:     number;   // 0-10  (new; undefined on legacy stored data)
  realVsFake:       number;   // 0-10  hard-skip gate (not added to matchScore)
  // Legacy fields — present on old stored jobs, ignored in new scoring
  hiringUrgency?:      number;
  tailoringRequired?:  number;
  referralOdds?:       number;
  qualificationFit?:   number;
}

// ─────────────────────────────────────────────────────────────────────────────
// MomentumScore — pre-check run before scoring (Gemini + DB cache, 48 h TTL)
// ─────────────────────────────────────────────────────────────────────────────
export interface MomentumScore {
  companyName:    string;
  score:          number;    // 0-25 — feeds directly into companyQuality component
  signals:        string[];  // positive signals (funding, hiring surge, product launch…)
  warning:        string | null; // single-sentence red flag, if any
  cached:         boolean;
}

// In-process cache — avoids duplicate Gemini calls within a single scout run
const _momentumCache = new Map<string, { data: MomentumScore; expiresAt: number }>();

export type OpportunityTier = 'Top Target' | 'Fast Win' | 'Stretch Role' | 'Probably Skip' | 'unscored';

export interface JobMatch {
  title: string;
  company: string;
  location: string;
  salary?: string;
  applyUrl: string;
  whyGoodFit: string;
  matchScore: number;
  isHardware: boolean;
  aiRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'unknown';
  aiRiskScore: number;
  aiRiskReason: string;
  opportunityTier: OpportunityTier;
  subScores: SubScores;
}

interface CriteriaForAgent {
  targetRoles: string[];
  industries: string[];
  minSalary?: number | null;   // minimum base salary
  minOte?: number | null;      // minimum OTE (total on-target earnings)
  locations: string[];
  allowedWorkModes?: string[];
  mustHave: string[];
  niceToHave: string[];
  avoid: string[];
  preApprovedCompanies?: string[];
  tierSettings?: TierSettings;
  candidateResume?: string;    // raw resume text for qualification matching
  acceptedExperienceLevels?: string[]; // e.g. ['mid','senior'] — from experience_levels DB field
}

// ─────────────────────────────────────────────────────────────────────────────
// getCompanyMomentum — Gemini-powered company health pre-check (48 h in-memory cache)
// Returns 0-25 score feeding directly into companyQuality component.
// ─────────────────────────────────────────────────────────────────────────────
export async function getCompanyMomentum(
  companyName: string,
  isPreApproved: boolean,
): Promise<MomentumScore> {
  const cacheKey = companyName.toLowerCase().trim();

  // Return in-process cached result if fresh (48 h)
  const mem = _momentumCache.get(cacheKey);
  if (mem && Date.now() < mem.expiresAt) {
    return { ...mem.data, cached: true };
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    // No Gemini key — use a sensible default so scoring still works
    const fallback: MomentumScore = {
      companyName,
      score: isPreApproved ? 18 : 10,
      signals: [],
      warning: null,
      cached: false,
    };
    _momentumCache.set(cacheKey, { data: fallback, expiresAt: Date.now() + 48 * 3600 * 1000 });
    return fallback;
  }

  const prompt = `You are a company intelligence analyst. Evaluate the current momentum and health of "${companyName}" as of today.

Search the web for the most recent news (last 6 months preferred). Look for:
- Recent funding rounds, IPO news, or financial results
- Headcount growth or layoffs in the last 12 months
- Product launches or major contract wins
- Leadership stability (CEO/CRO changes are a flag)
- Any legal issues, regulatory action, or public controversy

Return ONLY a valid JSON object (no markdown, no other text):
{
  "score": <integer 0-25>,
  "signals": [<up to 3 short positive signal strings, e.g. "Raised $120M Series C (Jan 2025)">],
  "warning": <null or one-sentence red flag, e.g. "Laid off 20% of workforce in Q1 2025">,
  "reasoning": "<one sentence summary>"
}

SCORING GUIDE:
23-25: Elite momentum — major funding/IPO, strong growth, no red flags
18-22: Healthy — stable growth, some positive signals, no major concerns
13-17: Neutral — no clear signals either way, or pre-approved company without recent news
8-12: Cautious — some negative signals (slowing growth, leadership turnover)
0-7:  Red flag — layoffs, legal/regulatory problems, financial distress`;

  const CANDIDATE_MODELS = ['gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-pro-latest'];

  let result: MomentumScore | null = null;

  for (const modelName of CANDIDATE_MODELS) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] },
      });

      const text = (response.text ?? '').trim().replace(/```json|```/g, '').trim();
      if (!text) continue;

      const parsed = JSON.parse(text) as {
        score?: number;
        signals?: string[];
        warning?: string | null;
      };

      result = {
        companyName,
        score:   Math.min(25, Math.max(0, Math.round(parsed.score ?? (isPreApproved ? 16 : 10)))),
        signals: Array.isArray(parsed.signals) ? parsed.signals.slice(0, 3) : [],
        warning: parsed.warning ?? null,
        cached:  false,
      };
      console.log(`  [Momentum] ${companyName}: ${result.score}/25 via ${modelName}${result.warning ? ' ⚠ ' + result.warning : ''}`);
      break;
    } catch {
      // Try next model
    }
  }

  if (!result) {
    result = {
      companyName,
      score: isPreApproved ? 16 : 10,
      signals: [],
      warning: null,
      cached: false,
    };
  }

  _momentumCache.set(cacheKey, { data: result, expiresAt: Date.now() + 48 * 3600 * 1000 });
  return result;
}

async function scoreOne(
  job: ScrapedJob,
  criteriaText: string,
  preApprovedSection: string,
  preApprovedCompanies: string[],
  tierSettings?: TierSettings,
  minSalary?: number | null,
  candidateResume?: string,
  minOte?: number | null,
  momentumContext?: MomentumScore | null,
): Promise<JobMatch | null> {
  try {
    const isPreApproved = preApprovedCompanies.some(
      (name) => name.toLowerCase() === job.company.toLowerCase()
    );

    // ── Build salary constraint text ─────────────────────────────────────────
    let salaryRule: string;
    if (minSalary || minOte) {
      const lines: string[] = [];
      if (minSalary) lines.push(`  - Min BASE salary: $${minSalary.toLocaleString()}`);
      if (minOte)    lines.push(`  - Min OTE (total on-target earnings): $${minOte.toLocaleString()}`);
      salaryRule = `COMPENSATION MINIMUMS:\n${lines.join('\n')}\n\nCOMPENSATION ANALYSIS RULES (apply in order):\n\n` +
        `STEP 1 — Extract salary figures from the job description. Look for: base salary, base pay, OTE, total compensation, on-target earnings, total package, variable, commission. Salary figures may appear anywhere in the description.\n\n` +
        `STEP 2 — Derive base salary using ROLE-TYPE SPLITS when only OTE is stated:\n` +
        `  • Account Executive (AE), Sales Executive, Account Director: 50% base / 50% variable → implied base = OTE × 0.50\n` +
        `  • Account Manager (AM), Customer Success Manager: 70% base / 30% variable → implied base = OTE × 0.70\n` +
        `  • SDR, BDR, Sales Development Rep: 50% base / 50% variable → implied base = OTE × 0.50\n` +
        `  • Sales Director, VP of Sales: 60% base / 40% variable → implied base = OTE × 0.60\n` +
        `  • Sales Representative (generic, unclear type): conservative 40% base → implied base = OTE × 0.40\n` +
        `  • If role type is ambiguous: use 50% split as the default\n\n` +
        `STEP 3 — Score based on derived or explicit base vs the minimum:\n` +
        `  20: Base clearly meets/exceeds minimum (explicit or derived from OTE split)\n` +
        `  15: Base is within 10% below minimum (close)\n` +
        `  10: No salary info anywhere in the description — cannot penalize, genuinely unknown\n` +
        `  5:  Base derived from OTE split is 10-25% below minimum\n` +
        `  0:  Base explicitly stated OR derived from OTE split is clearly below minimum\n\n` +
        `IMPORTANT: If the JD lists OTE but not base, you MUST derive implied base using the split above. Do NOT default to score 10 just because "base isn't explicitly listed" — the OTE split gives you the answer.`;
    } else {
      salaryRule = 'No salary minimum set. Score compensationFit=10 if no salary listed.';
    }

    // ── Candidate background section ─────────────────────────────────────────
    const resumeSection = candidateResume
      ? `═══════════════════════════════════════════════════
CANDIDATE BACKGROUND (uploaded resume)
═══════════════════════════════════════════════════
Use this to understand who the candidate is — titles, industries sold into, deal sizes, methodologies.

${candidateResume.slice(0, 2500)}
`
      : '';

    // ── Momentum context ─────────────────────────────────────────────────────
    const momentumSection = momentumContext
      ? `COMPANY MOMENTUM (pre-researched):
Score: ${momentumContext.score}/25
${momentumContext.signals.length ? 'Positive signals: ' + momentumContext.signals.join(' | ') : ''}
${momentumContext.warning ? '⚠ Warning: ' + momentumContext.warning : ''}
Use this to inform companyQuality. Pre-approved + high momentum → 22-25. Warning flag → reduce companyQuality.`
      : isPreApproved
        ? `COMPANY MOMENTUM: ${job.company} is pre-approved by the user. Default companyQuality 16 unless you have clear evidence of problems.`
        : '';

    // ── Pre-approved note ────────────────────────────────────────────────────
    const preApprovedNote = isPreApproved
      ? `\nCOMPANY NOTE: ${job.company} is on the user's watchlist. The company quality is confirmed — but STILL score the role segment, territory, and comp fit rigorously. A Commercial or Mid-Market title at a good company is not automatically a Top Target.`
      : '';

    const prompt = `You are a world-class career strategist evaluating job-candidate fit with surgical precision.

${resumeSection}
═══════════════════════════════════════════════════
CANDIDATE PREFERENCES & CRITERIA
═══════════════════════════════════════════════════
${criteriaText}

${preApprovedSection}${preApprovedNote}

${salaryRule}

${momentumSection}

═══════════════════════════════════════════════════
JOB TO EVALUATE
═══════════════════════════════════════════════════
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Description:\n${job.description.slice(0, 1500)}` : '(No description available)'}

═══════════════════════════════════════════════════
SCORING — 5 COMPONENTS (they sum to matchScore 0-100)
═══════════════════════════════════════════════════

COMPONENT 1 — roleFit (0-30 points):
  30: Exact match — correct role title AND seniority level AND segment (e.g., Enterprise AE for an Enterprise-level candidate)
  22: Correct role title and level but different SEGMENT (e.g., "Commercial AE" or "Mid-Market AE" when candidate is Enterprise-level but has Commercial AE in their target seniority settings). Lower segment = slight mismatch but not disqualifying.
  20: Close title match — same level, slightly different wording
  12: Related role (e.g., SDR, CSM, Solutions Engineer) — not exactly what they're targeting
  5:  Wrong seniority level (too junior or too senior)
  0:  Wrong role type entirely (engineering, HR, marketing, etc.)
  NOTE: "Commercial" and "Mid-Market" in a title represent a sales segment, not a title mismatch. If the candidate explicitly includes Commercial/MM in their target seniority settings, these are acceptable — score 22 for segment step-down, not 12.

COMPONENT 2 — companyQuality (0-25 points):
  Use momentum context above if provided.
  25: Pre-approved AND elite momentum (funding/growth/IPO)
  20: Pre-approved, solid established company
  16: Not pre-approved, but safe and respectable
  10: Small unknown company, no signals
  0:  AI disruption risk, layoff signals, or company in decline

COMPONENT 3 — compensationFit (0-20 points):
  ${salaryRule}
  (Scoring summary for quick reference — see full rules above)
  20: Base clearly meets/exceeds minimum (explicit or OTE-derived via split)
  15: Base within 10% below minimum, or close
  10: Genuinely no salary/OTE info anywhere in the description
  5:  OTE-derived base is 10-25% below minimum
  0:  Base explicitly stated or OTE-derived and clearly below minimum

COMPONENT 4 — locationFit (0-15 points):
  15: Remote US or explicitly in candidate's preferred locations
  10: Hybrid with home office in candidate's preferred region
  5:  Requires relocation but Top Target company
  0:  On-site only far from preferences

COMPONENT 5 — territoryFit (0-10 points):
  Read the job TITLE carefully for territory names — they often appear in parentheses or after a dash.
  7:  No territory requirement stated (fully remote/flexible, no region in title or JD)
  10: Territory explicitly matches candidate's preferred region (Southeast, FL, SC, NC, GA, or equivalent)
  3:  Territory mentioned but is adjacent/transferable — candidate could likely cover it
  0:  Hard geographic territory clearly OUTSIDE candidate's preferred region (e.g., title says "Northeast", "Midwest", "Pacific Northwest", "TOLA", "West Coast" and candidate is Southeast-based)
  CRITICAL: If the title contains a specific region name like "(Northeast)", "(Midwest)", "(TOLA)", "(Pacific NW)", "(Southwest)", "(Northwest)" — and the candidate's preferred locations are Southeast US — score territoryFit = 0. Do NOT default to 7 just because the job listing says "Remote".

ADDITIONAL FIELDS:
  realVsFake (0-10): Confidence this is a genuine open role. 10=specific unique JD, 0=generic evergreen template. This is a hard-skip gate and NOT added to matchScore.
  isHardware: true if company sells physical hardware, semiconductors, networking equipment, or industrial machinery.
  aiRiskScore: Rate AI displacement risk to this COMPANY'S PRODUCT on a 0-10 scale.
  This is about whether a large language model (Claude, ChatGPT, Gemini) can replicate the company's core product function for a fraction of the cost — making the company obsolete.
  0-2: Physical hardware, semiconductors, supply chain infrastructure, field sales tools — AI cannot replace the product itself
  3-4: Deep vertical SaaS with proprietary data, regulatory moats, or compliance requirements (EHR, ERP, CAD software, construction management)
  5-6: Established SaaS with meaningful switching costs and integrations, but AI is gradually eroding the value proposition
  7-8: Generic software where AI substantially replicates the function (rules-based automation, basic analytics dashboards, simple content tools)
  9-10: The product's core function can be reproduced by calling Claude/GPT API for ~$10/month. No defensible moat.
  AUTOMATIC 9-10 — these product categories ALWAYS score 9-10:
  - AI security awareness training / phishing simulation / "train employees to spot AI" platforms
  - Document analysis, review, summarization, or Q&A platforms (lawyers, finance, etc.)
  - Workflow automation with if-then-else logic + Slack/email integration
  - Content generation, rewriting, or moderation tools
  - Customer support or sales chatbot/copilot platforms
  - Data extraction from unstructured documents (invoices, contracts, emails)
  - "AI copilot for X" where X is a simple task (writing, scheduling, note-taking)
  - Generic lead scoring, intent data, or email personalization tools
  - Any company whose pitch is literally "we use AI to do [simple task]"

LOCATION NOTE: "Remote" alone = anywhere. "Remote, [City]" = must live near that city.

═══════════════════════════════════════════════════
REQUIRED OUTPUT — JSON ONLY, NO MARKDOWN
═══════════════════════════════════════════════════
{
  "roleFit": <0-30>,
  "companyQuality": <0-25>,
  "compensationFit": <0-20>,
  "locationFit": <0-15>,
  "territoryFit": <0-10>,
  "realVsFake": <0-10>,
  "whyGoodFit": "<2-3 sentences referencing the candidate's background specifically — past titles, industries, experience — and why this role does or does not fit. Not generic.>",
  "isHardware": <true | false>,
  "aiRiskScore": <0-10 integer>,
  "aiRiskReason": "<one sentence on what specifically makes this company's product replaceable or defensible by AI>"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    if (block.type !== 'text') return null;

    const text = block.text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text) as {
      roleFit?: number;
      companyQuality?: number;
      compensationFit?: number;
      locationFit?: number;
      territoryFit?: number;
      realVsFake?: number;
      whyGoodFit?: string;
      isHardware?: boolean;
      aiRiskScore?: number;
      aiRiskReason?: string;
    };

    // Clamp components to their valid ranges
    const roleFit         = Math.min(30, Math.max(0, Math.round(parsed.roleFit ?? 12)));
    const companyQuality  = Math.min(25, Math.max(0, Math.round(parsed.companyQuality ?? 10)));
    const compensationFit = Math.min(20, Math.max(0, Math.round(parsed.compensationFit ?? 10)));
    const locationFit     = Math.min(15, Math.max(0, Math.round(parsed.locationFit ?? 7)));
    const territoryFit    = Math.min(10, Math.max(0, Math.round(parsed.territoryFit ?? 7)));
    const realVsFake      = Math.min(10, Math.max(0, Math.round(parsed.realVsFake ?? 6)));

    // matchScore is the deterministic sum of the 5 components
    const matchScore = roleFit + companyQuality + compensationFit + locationFit + territoryFit;

    const subScores: SubScores = {
      roleFit,
      companyQuality,
      compensationFit,
      locationFit,
      territoryFit,
      realVsFake,
    };

    // Derive numeric aiRiskScore (clamp 0-10) and legacy text label
    const aiRiskScore = Math.min(10, Math.max(0, Math.round(parsed.aiRiskScore ?? 5)));
    const aiRisk: 'LOW' | 'MEDIUM' | 'HIGH' =
      aiRiskScore >= 7 ? 'HIGH' : aiRiskScore >= 4 ? 'MEDIUM' : 'LOW';

    // Hard pre-filter: below stretch threshold or clearly fake
    const isMatch = matchScore >= 35 && realVsFake >= 4;

    if (!isMatch) {
      if (matchScore >= 25) {
        console.log(`  ✗ Rejected (${matchScore}) [AI:${aiRiskScore}/10]: ${job.company} — "${job.title}" — ${parsed.whyGoodFit?.slice(0, 80)}`);
      }
      return null;
    }

    // Tier is ALWAYS computed deterministically — Claude does not assign tier.
    const tier: OpportunityTier = computeTier(
      matchScore, aiRisk, subScores,
      job.title, job.company, job.location, tierSettings
    );

    console.log(`  ✓ Match (${matchScore}) [${tier}] [AI risk:${aiRiskScore}/10]: ${job.company} — "${job.title}"`);

    return {
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      applyUrl: job.applyUrl,
      whyGoodFit: parsed.whyGoodFit ?? '',
      matchScore,
      isHardware: parsed.isHardware ?? false,
      aiRisk,
      aiRiskScore,
      aiRiskReason: parsed.aiRiskReason ?? '',
      opportunityTier: tier,
      subScores,
    };
  } catch {
    return null;
  }
}

// Settings that control tier classification — all user-configurable
export interface TierSettings {
  verticalNiches?: string[];    // Title keywords that signal above-level niche specialization
  topTargetScore?: number;      // Min match score for Top Target (default 80)
  fastWinScore?: number;        // Min match score for Fast Win (default 65)
  stretchScore?: number;        // Min match score for Stretch Role (default 45)
  experienceLevels?: string[];  // Array of: 'junior' | 'mid' | 'senior' | 'strategic'
}

// Level hierarchy rank — 4 tiers matching the user's experience model
// junior=0: SMB / commercial at mid-tier company
// mid=1:    commercial at good-fit company, Corporate, MM
// senior=2: Sr./Senior, Named, Enterprise
// strategic=3: Strategic, Sr.Enterprise, Strategic Enterprise, Account Director
const LEVEL_RANK: Record<string, number> = { junior: 0, mid: 1, senior: 2, strategic: 3 };

const DEFAULT_VERTICAL_NICHES = ['federal', 'government', 'sled', 'fsi', 'dod', 'defense', 'navy', 'army', 'air force', 'marines', 'public sector', 'healthcare', 'health system', 'life sciences', 'pharma', 'pharmaceutical', 'banking', 'financial services', 'insurance', 'education', 'k-12', 'higher ed', 'gsi', 'hyperscaler', 'hyperscale'];

// ─────────────────────────────────────────────────────────────────────────────
// computeTier — deterministic tier assignment
//
// Handles two sub-score formats automatically:
//   v2 (new): sub_scores has `compensationFit` — uses 80/65/45 thresholds
//   v1 (old): no `compensationFit` — uses legacy 65/55/45 thresholds
//
// Location filtering is done EXTERNALLY by checkJobLocation() before this call.
// ─────────────────────────────────────────────────────────────────────────────
export function computeTier(
  matchScore: number,
  aiRisk: string,
  s: SubScores,
  title = '',
  company = '',
  location = '',
  settings?: TierSettings,
): OpportunityTier {
  void company;
  void location;

  const isNewFormat = (s as unknown as Record<string, unknown>).compensationFit !== undefined;

  // ── HARD SKIPS (both formats) ─────────────────────────────────────────────
  if (aiRisk === 'HIGH') return 'Probably Skip';
  if (s.realVsFake < 4) return 'Probably Skip';

  // ── NEW FORMAT (v2 — 5-component scoring, 0-100 is sum of components) ─────
  if (isNewFormat) {
    const topTargetScore = settings?.topTargetScore ?? 80;
    const fastWinScore   = settings?.fastWinScore   ?? 65;
    const stretchScore   = settings?.stretchScore   ?? 45;

    if (matchScore < stretchScore) return 'Probably Skip';

    // Vertical niche / above-level detection (same as v1)
    const nicheList = (settings?.verticalNiches && settings.verticalNiches.length > 0)
      ? settings.verticalNiches.map((n) => n.toLowerCase().trim())
      : DEFAULT_VERTICAL_NICHES;
    const hasVerticalNiche = nicheList.some((niche) => {
      const escaped = niche.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(title.toLowerCase());
    });

    const expLevels = (settings?.experienceLevels && settings.experienceLevels.length > 0)
      ? settings.experienceLevels : ['senior'];
    const maxRank = Math.max(...expLevels.map((l) => LEVEL_RANK[l] ?? 2));

    const isStrategic    = /\b(strategic|major|majors)\b/i.test(title);
    const isDirector     = /\b(director|rvp\b|vice president|vp\b)\b/i.test(title);
    const isPrincipal    = /\bprincipal\b/i.test(title);
    const isNamedAE      = /\bnamed\b/i.test(title);
    const isSenior       = /\b(senior|sr\.?)\b/i.test(title);
    const hasEnterprise  = /\benterprise\b/i.test(title);
    const isSrEnterprise = isSenior && hasEnterprise;

    const namedAbove        = maxRank < 2 ? isNamedAE      : false;
    const enterpriseAbove   = maxRank < 2 ? hasEnterprise   : false;
    const srEnterpriseAbove = maxRank < 3 ? isSrEnterprise  : false;
    const strategicAbove    = maxRank < 3 ? isStrategic     : false;
    const directorAbove     = maxRank < 3 ? isDirector      : false;
    const principalAbove    = isPrincipal;

    // Niche keywords alone do NOT push a role above level — only seniority signals do.
    // hasVerticalNiche is kept as a computed value for future use but excluded from isAboveLevel.
    void hasVerticalNiche;
    const isAboveLevel = namedAbove || enterpriseAbove || srEnterpriseAbove ||
      strategicAbove || directorAbove || principalAbove;

    // STRETCH: above user's level
    if (isAboveLevel && matchScore >= stretchScore) return 'Stretch Role';

    // Component gates for Top Target (v2 specific)
    const strongRole    = s.roleFit >= 20;        // out of 30
    const strongCompany = s.companyQuality >= 15;  // out of 25
    const okComp        = s.compensationFit >= 10; // out of 20 (unknown = 10, so not penalized)

    // TOP TARGET: high score + strong components + not above level
    if (!isAboveLevel && matchScore >= topTargetScore && strongRole && strongCompany && okComp && s.realVsFake >= 5) {
      return 'Top Target';
    }

    // FAST WIN: solid score
    if (matchScore >= fastWinScore && s.realVsFake >= 5) return 'Fast Win';

    // STRETCH fallback
    if (matchScore >= stretchScore && s.realVsFake >= 4) return 'Stretch Role';

    return 'Probably Skip';
  }

  // ── LEGACY FORMAT (v1 — 0-10 sub-score scale) ────────────────────────────
  const topTargetScore = settings?.topTargetScore ?? 65;
  const fastWinScore   = settings?.fastWinScore   ?? 55;
  const stretchScore   = settings?.stretchScore   ?? 55;

  if (s.realVsFake < 5) return 'Probably Skip';
  if (matchScore < 50) return 'Probably Skip';

  const nicheList = (settings?.verticalNiches && settings.verticalNiches.length > 0)
    ? settings.verticalNiches.map((n) => n.toLowerCase().trim())
    : DEFAULT_VERTICAL_NICHES;
  const hasVerticalNiche = nicheList.some((niche) => {
    const escaped = niche.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(title.toLowerCase());
  });

  const expLevels = (settings?.experienceLevels && settings.experienceLevels.length > 0)
    ? settings.experienceLevels : ['senior'];
  const maxRank = Math.max(...expLevels.map((l) => LEVEL_RANK[l] ?? 2));

  const isStrategic    = /\b(strategic|major|majors)\b/i.test(title);
  const isDirector     = /\b(director|rvp\b|vice president|vp\b)\b/i.test(title);
  const isPrincipal    = /\bprincipal\b/i.test(title);
  const isNamedAE      = /\bnamed\b/i.test(title);
  const isSenior       = /\b(senior|sr\.?)\b/i.test(title);
  const hasEnterprise  = /\benterprise\b/i.test(title);
  const isSrEnterprise = isSenior && hasEnterprise;

  const namedAbove        = maxRank < 2 ? isNamedAE      : false;
  const enterpriseAbove   = maxRank < 2 ? hasEnterprise   : false;
  const srEnterpriseAbove = maxRank < 3 ? isSrEnterprise  : false;
  const strategicAbove    = maxRank < 3 ? isStrategic     : false;
  const directorAbove     = maxRank < 3 ? isDirector      : false;
  const principalAbove    = isPrincipal;

  // Niche keywords alone do NOT push a role above level — only seniority signals do.
  void hasVerticalNiche;
  const isAboveLevel = namedAbove || enterpriseAbove || srEnterpriseAbove ||
    strategicAbove || directorAbove || principalAbove;
  const isAccessibleRole = !isAboveLevel;

  const hasCommercial = /\bcommercial\b/i.test(title);
  const hasMidMarket  = /\b(mid[.\s-]?market|midmarket)\b/i.test(title);
  const hasCorporate  = /\bcorporate\b/i.test(title);
  const hasLowerBar   = hasCommercial || hasMidMarket || hasCorporate;

  if (isAboveLevel && matchScore >= stretchScore && s.realVsFake >= 5) return 'Stretch Role';

  const isQualityCompany = s.companyQuality >= 7;
  const goodRoleFit      = s.roleFit >= 6;
  const qualFitRaw       = s.qualificationFit;
  const qualFitKnown     = qualFitRaw !== undefined && qualFitRaw !== null;
  const qualFit          = qualFitRaw ?? 7;
  const strongQualFit    = !qualFitKnown || qualFit >= 7;
  const weakQualFit      = qualFitKnown && qualFit < 4;

  if (weakQualFit && matchScore < topTargetScore) return 'Probably Skip';

  if (isAccessibleRole && matchScore >= topTargetScore && isQualityCompany && goodRoleFit &&
      s.realVsFake >= 6 && (strongQualFit || qualFit >= 6)) return 'Top Target';

  if (isAccessibleRole && hasLowerBar && matchScore >= fastWinScore && s.realVsFake >= 5) return 'Fast Win';
  if (isAccessibleRole && matchScore >= (fastWinScore + 5) && s.realVsFake >= 5) return 'Fast Win';

  if (isAboveLevel && matchScore >= topTargetScore && isQualityCompany && s.realVsFake >= 6) return 'Stretch Role';
  if (matchScore >= stretchScore && s.realVsFake >= 5) return 'Stretch Role';

  return 'Probably Skip';
}

export async function rescoreJobOpportunity(
  job: { id: number; title: string; company: string; location: string; salary?: string; applyUrl: string; description?: string },
  criteriaText: string,
  preApprovedSection: string,
  preApprovedCompanies: string[],
  tierSettings?: TierSettings,
  minSalary?: number | null,
  candidateResume?: string,
  minOte?: number | null,
): Promise<{ opportunityTier: OpportunityTier; subScores: SubScores; aiRisk: string; aiRiskScore: number; aiRiskReason: string; whyGoodFit: string; matchScore: number } | null> {
  try {
    const result = await scoreOne(
      { title: job.title, company: job.company, location: job.location, salary: job.salary, applyUrl: job.applyUrl, description: job.description },
      criteriaText, preApprovedSection, preApprovedCompanies, tierSettings, minSalary, candidateResume, minOte,
    );
    if (!result) return null;
    return {
      opportunityTier: result.opportunityTier,
      subScores: result.subScores,
      aiRisk: result.aiRisk,
      aiRiskScore: result.aiRiskScore,
      aiRiskReason: result.aiRiskReason,
      whyGoodFit: result.whyGoodFit,
      matchScore: result.matchScore,
    };
  } catch {
    return null;
  }
}

// ── Company safety pre-screening for JobSpy results ──
// Filters out pure SaaS / software companies that aren't relevant targets.
// Only called for non-pre-approved companies found via JobSpy.

const companySafetyCache = new Map<string, boolean>();

async function isCompanySafe(companyName: string): Promise<boolean> {
  const cached = companySafetyCache.get(companyName);
  if (cached !== undefined) return cached;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 8,
      messages: [{
        role: 'user',
        content: `Does "${companyName}" sell technology products or services to businesses (B2B)? This includes: SaaS software, cloud platforms, cybersecurity, networking, data/analytics, developer tools, sales/marketing tech, HR tech, fintech, infrastructure software, AI tools, hardware + software, or any enterprise/mid-market software. Answer YES for any legitimate B2B tech or software company. Answer NO only for: hospitals/health systems, insurance agencies, car dealerships, restaurants, retail/consumer brands, non-profits, staffing agencies, real estate brokers, construction firms, utilities, or government entities. Answer only YES or NO.`,
      }],
    });

    const block = message.content[0];
    const answer = block.type === 'text' ? block.text.trim().toUpperCase() : 'NO';
    const safe = answer.startsWith('YES');
    companySafetyCache.set(companyName, safe);
    return safe;
  } catch {
    // On error, allow the company through to avoid false negatives
    companySafetyCache.set(companyName, true);
    return true;
  }
}

/**
 * Pre-screen JobSpy jobs by filtering out companies that aren't in target sectors.
 * Only evaluates companies NOT in the pre-approved list.
 * Runs all unique company checks up front, then filters the job list.
 */
export async function filterUnsafeCompanies(
  jobs: ScrapedJob[],
  preApprovedCompanies: string[]
): Promise<ScrapedJob[]> {
  const preApprovedLower = new Set(preApprovedCompanies.map((n) => n.toLowerCase()));

  // Collect unique non-pre-approved company names
  const uniqueCompanies = new Set<string>();
  for (const job of jobs) {
    if (!preApprovedLower.has(job.company.toLowerCase())) {
      uniqueCompanies.add(job.company);
    }
  }

  if (uniqueCompanies.size === 0) return jobs;

  console.log(`\n──── COMPANY SAFETY CHECK ──────────────────────────────────`);
  console.log(`Evaluating ${uniqueCompanies.size} unique non-pre-approved companies...`);

  // Evaluate all unique companies in batches of 10
  const companyList = Array.from(uniqueCompanies);
  const BATCH_SIZE = 10;
  for (let i = 0; i < companyList.length; i += BATCH_SIZE) {
    const batch = companyList.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((name) => isCompanySafe(name)));
  }

  // Log results
  let safe = 0;
  let unsafe = 0;
  for (const name of companyList) {
    if (companySafetyCache.get(name)) {
      safe++;
    } else {
      unsafe++;
      console.log(`  ✗ Filtered out: ${name}`);
    }
  }
  console.log(`  Safe: ${safe}, Filtered out: ${unsafe}`);
  console.log(`───────────────────────────────────────────────────────────`);

  // Filter jobs
  return jobs.filter((job) => {
    if (preApprovedLower.has(job.company.toLowerCase())) return true;
    return companySafetyCache.get(job.company) ?? true;
  });
}

export async function scoreJobsWithClaude(
  jobs: ScrapedJob[],
  criteria: CriteriaForAgent,
  momentumMap?: Map<string, MomentumScore>,
): Promise<JobMatch[]> {
  if (jobs.length === 0) return [];

  // Derive accepted sales segments from experience_levels
  const expLevels = criteria.acceptedExperienceLevels ?? ['senior'];
  const acceptsMid      = expLevels.includes('mid');
  const acceptsSenior   = expLevels.includes('senior');
  const acceptsStrategic = expLevels.includes('strategic');
  const segmentLines: string[] = [];
  if (acceptsStrategic) segmentLines.push('Strategic / Enterprise Hunter / Global / Named Strategic');
  if (acceptsSenior)    segmentLines.push('Enterprise AE / Senior AE / Named AE');
  if (acceptsMid)       segmentLines.push('Commercial AE / Mid-Market AE / Corporate AE (accepted, but score roleFit 22 not 30)');
  const segmentText = segmentLines.length
    ? `Accepted sales segments (seniority levels): ${segmentLines.join('; ')}`
    : '';

  const criteriaText = [
    criteria.targetRoles.length ? `Target roles: ${criteria.targetRoles.join(', ')}` : '',
    segmentText,
    criteria.industries.length ? `Target industries: ${criteria.industries.join(', ')}` : '',
    criteria.locations.length ? `Preferred locations: ${criteria.locations.join(', ')}` : '',
    (() => {
      const modes: string[] = criteria.allowedWorkModes ?? [];
      const parts: string[] = [];
      if (modes.includes('remote_us')) parts.push('true remote (US-wide, no city restriction)');
      if (modes.includes('remote_in_territory')) parts.push('remote-in-territory (must live near specified city)');
      if (modes.includes('onsite')) parts.push('on-site physical office');
      return parts.length > 0 ? `Accepted work modes: ${parts.join(', ')}` : '';
    })(),
    criteria.mustHave.length ? `Must have: ${criteria.mustHave.join(', ')}` : '',
    criteria.niceToHave.length ? `Nice to have: ${criteria.niceToHave.join(', ')}` : '',
    criteria.avoid.length ? `Avoid (automatic disqualifier): ${criteria.avoid.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  let preApprovedSection = '';
  if (criteria.preApprovedCompanies && criteria.preApprovedCompanies.length > 0) {
    preApprovedSection = `PRE-APPROVED COMPANIES:
The user has manually vetted and approved these employers as targets. If the job is from one of these companies, give the company the benefit of the doubt on fit — only evaluate the role title, responsibilities, and location against the user's criteria.
Pre-approved companies: ${criteria.preApprovedCompanies.join(', ')}`;
  }

  const CONCURRENCY = 10;
  const results: JobMatch[] = [];

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    console.log(`Scoring batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(jobs.length / CONCURRENCY)} (${batch.length} jobs)...`);
    const batchResults = await Promise.all(
      batch.map((j) => {
        const momentum = momentumMap?.get(j.company.toLowerCase().trim()) ?? null;
        return scoreOne(
          j, criteriaText, preApprovedSection,
          criteria.preApprovedCompanies ?? [],
          criteria.tierSettings,
          criteria.minSalary,
          criteria.candidateResume,
          criteria.minOte,
          momentum,
        );
      })
    );
    for (const r of batchResults) {
      if (r !== null) results.push(r);
    }
  }

  console.log(`Claude scoring complete: ${results.length} matches from ${jobs.length} candidates`);
  return results;
}

export async function researchCompanyWithClaude(companyName: string): Promise<Record<string, unknown>> {
  const prompt = `You are a sales intelligence researcher preparing a briefing for an enterprise account executive interviewing at or preparing for a first call with ${companyName}. Research this company thoroughly using web search. Find the most current information available. Return ONLY a valid JSON object with no other text:
{
  "companyName": "string",
  "oneLiner": "one sentence — what they make and who buys it",
  "overview": "2-3 paragraphs on what they do, why it matters, market position",
  "recentNews": ["3-5 most recent notable news items with dates"],
  "keyProducts": ["main products and solutions relevant to enterprise sales"],
  "whatTheySolve": "the specific pain point they uniquely solve",
  "aiStrategy": "how AI factors into their product and go-to-market right now",
  "competitors": ["top 3-5 direct competitors"],
  "competitiveAdvantage": "what makes them win deals vs competitors",
  "salesMotion": "how they sell — direct vs channel, deal sizes, typical buyer titles",
  "keyExecutives": ["CEO name", "CRO or VP Sales name", "other relevant leaders"],
  "fundingValuation": "market cap or most recent funding round and valuation",
  "revenueGrowth": "most recent revenue figures or growth metrics if public",
  "whyApply": "2-3 sentences on why this is a compelling enterprise sales role specifically",
  "talkingPoints": ["5 specific talking points for an interview or discovery call based on recent news — be specific not generic"],
  "generatedAt": "current ISO timestamp"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8000,
    system: 'You are a research assistant. After using web search to gather information, you MUST respond with ONLY a valid JSON object. No conversational text, no explanations, no markdown — just the raw JSON object starting with { and ending with }.',
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
    messages: [{ role: 'user', content: prompt }],
  });

  // Extract text from all text blocks in the response
  const textBlocks: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      textBlocks.push(block.text);
    }
  }

  // Try each text block (last first, as that's most likely the final answer)
  for (let i = textBlocks.length - 1; i >= 0; i--) {
    let text = textBlocks[i].trim();

    // Strip markdown code fences
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    // Try direct parse first
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Try to extract a JSON object from within conversational text
      const jsonMatch = text.match(/\{[\s\S]*"companyName"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        } catch {
          // continue to next block
        }
      }
    }
  }

  // If no valid JSON found in any block, throw descriptive error
  const preview = textBlocks.map(t => t.substring(0, 100)).join(' | ');
  throw new Error(`Failed to parse research JSON from Claude response. Text blocks preview: ${preview}`);
}

export interface TailoringAnalysis {
  targetPageCount: 1 | 2;
  wordTarget: string;
  requiredSkills: string[];
  preferredSkills: string[];
  methodologies: string[];
  keySignals: string[];
  keywordsPlaced: string[];
  pageEstimate: string;
}

export async function tailorResumeWithClaude(
  job: { title: string; company: string; location: string; description?: string; why_good_fit?: string; apply_url?: string },
  baseResume: string,
  options?: { targetPages?: 1 | 2; model?: string }
): Promise<{ resume: string; coverLetter: string; suggestedEdits?: string; analysis?: TailoringAnalysis }> {

  // Measure the original resume's exact character length — this is the hard constraint
  // The user's uploaded resume is assumed to fit perfectly on one page.
  // The tailored output must match it closely so no re-formatting is needed.
  const baseCharCount = baseResume.trim().length;
  const charMin = Math.round(baseCharCount * 0.93);
  const charMax = Math.round(baseCharCount * 1.07);

  // Keep word count only for page-count heuristic
  const baseWordCount = baseResume.trim().split(/\s+/).length;
  const targetPages = options?.targetPages ?? (baseWordCount > 600 ? 2 : 1);

  const systemPrompt = `You are the world's foremost ATS-optimization specialist and executive resume strategist. Your resumes have a 94% interview callback rate because you follow an ironclad process:

PHASE 1 — JD DECONSTRUCTION (before writing a single word):
You read the job description and extract with surgical precision:
- REQUIRED skills: the exact words/phrases the employer will search for in ATS (use VERBATIM terminology from the JD, never synonyms — if they say "Salesforce CRM" don't write "CRM tools")
- PREFERRED skills: nice-to-haves that give the candidate an edge
- METHODOLOGY SIGNALS: any sales/management frameworks mentioned (MEDDPICC, MEDDIC, Challenger, SPIN, Command of the Message, Force Management, etc.)
- VERTICAL SIGNALS: specific industries, customer types, or deal profiles (Enterprise, Mid-Market, SMB, Channel, Federal, SaaS, etc.)
- SENIORITY SIGNALS: IC vs manager, quota size, team size, deal size expectations
- NUANCE SIGNALS: subtle requirements often missed (e.g. "cross-functional alignment" means stakeholder management matters, "new logo acquisition" means hunter mentality, "expansion revenue" means land-and-expand motion)

PHASE 2 — SKILLS SURGERY:
You completely rebuild the candidate's Skills section:
- Lead with the top 6-10 skills that EXACTLY match the JD's required/preferred list (verbatim keywords)
- Every JD keyword must appear at least once in context (bullet points), not just the skills list
- Remove or demote skills that aren't relevant to this specific role

PHASE 3 — BULLET RECONSTRUCTION:
Every experience bullet must:
1. Start with a strong, specific action verb (Orchestrated, Negotiated, Expanded, Converted — not "Responsible for")
2. Include the quantifiable result (ARR, %, headcount, deal size, quota %, timeline)
3. Mirror the JD's language naturally within the bullet

PHASE 4 — LENGTH MATCHING (THE MOST CRITICAL CONSTRAINT):
The original resume is ${baseCharCount} characters. The tailored resume MUST be between ${charMin} and ${charMax} characters (±7% of original length). This is non-negotiable.

WHY this matters: The candidate's original resume fits perfectly on exactly one page. If your output is longer, it overflows to a second page and the candidate has to manually delete words in Word to fix it — potentially cutting content you carefully placed. If it's shorter, there is wasted white space. Either way, the formatting is broken.

HOW to achieve this:
- Every character you ADD (new keyword, new bullet, expanded phrasing) requires you to CUT an equal number of characters elsewhere
- Prioritize: add high-signal JD keywords → cut low-signal filler words and weak phrases
- Trim verbose phrases: "was responsible for managing" → "managed"; "in order to" → "to"; "a wide variety of" → "various"
- Collapse older/less-relevant bullets: 3 bullets → 2 tighter bullets with the same information density
- Never pad to fill space — be dense and purposeful

BEFORE FINALIZING: Count your output characters. If outside ${charMin}–${charMax}, keep editing until you're within range.

PHASE 5 — REASONING LOG (after writing the resume):
Write a clear, honest explanation of every meaningful change you made in the tailored resume — what was changed, what you removed, what you added, and exactly why. Reference the JD signals that drove each decision. Be specific: name the bullet, name the keyword, name the section. This helps the candidate understand and trust the output.
Format it as a readable document with ### headers per section. Include a short "What was NOT changed and why" note at the end.

PHASE 6 — COVER LETTER (the resume's human counterpart):
The cover letter must sound like a real, confident person wrote it — not a robot, not an HR drone.

BANNED PHRASES (use any of these and the letter fails):
- "I am writing to express my interest"
- "I am excited/thrilled/delighted to apply"
- "I believe I would be a great fit"
- "I am a highly motivated/driven/passionate professional"
- "Please find attached my resume"
- "Thank you for your time and consideration"
- "I look forward to hearing from you"
- "Dear Hiring Manager" (use a specific name if in JD, otherwise skip the salutation entirely)
- Any sentence starting with "I am a" followed by an adjective

COVER LETTER RULES:
1. Open with a specific, real hook — reference something concrete about the company or role (a product, a market move, a challenge the team faces). Not a compliment. A real observation.
2. Write like someone who already belongs in the room — confident, direct, no hedging
3. 3 short paragraphs max. Each paragraph does one job.
4. Vary sentence length. Mix short punchy sentences with longer ones. Rhythm matters.
5. Use first person naturally but don't start consecutive sentences with "I"
6. Connect 1-2 real achievements from the resume to what the role actually needs — specific numbers, specific outcomes
7. End with something direct, not groveling. "Happy to talk through it" beats "I look forward to the opportunity to further discuss"
8. Tone: confident peer-to-peer, not applicant-to-gatekeeper

ABSOLUTE RULES:
- Never fabricate data, companies, titles, or achievements not in the base resume
- Only reframe, optimize, and reorder existing information
- Use EXACT keywords from the JD — ATS systems match strings, not concepts`;

  const prompt = `Complete a full 4-phase tailoring analysis and produce the tailored documents.

═══════════════════════════════
JOB DETAILS
═══════════════════════════════
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Job Description:\n${job.description.slice(0, 4000)}` : ''}
${job.why_good_fit ? `\nStrategic fit notes: ${job.why_good_fit}` : ''}

═══════════════════════════════
CANDIDATE BASE RESUME (${baseCharCount} characters)
═══════════════════════════════
${baseResume}

═══════════════════════════════
TARGET — READ THIS BEFORE WRITING
═══════════════════════════════
Page count: ${targetPages} page${targetPages > 1 ? 's' : ''}
HARD LENGTH CONSTRAINT: Your resume output must be ${charMin}–${charMax} characters (original: ${baseCharCount}). Do not go outside this range. The original fits one page — exceeding ${charMax} chars causes page overflow; going under ${charMin} chars leaves wasted space. Tailor the content, not the volume.

Respond ONLY with a valid JSON object — no markdown fences, no text outside the JSON:
{
  "analysis": {
    "targetPageCount": ${targetPages},
    "originalCharCount": ${baseCharCount},
    "charTarget": "${charMin}–${charMax}",
    "requiredSkills": ["exact phrase from JD", "...up to 10"],
    "preferredSkills": ["...", "...up to 6"],
    "methodologies": ["MEDDPICC", "...any found"],
    "keySignals": ["Enterprise hunter", "...3-5 nuance signals you detected"],
    "keywordsPlaced": ["list every JD keyword you successfully wove into the resume"],
    "outputCharEstimate": "~XXXX characters → fits Y page(s)"
  },
  "resume": "# Full Name\\n\\n## Summary\\n[2-3 sentence power summary mirroring JD language]\\n\\n## Experience\\n**Job Title** — **Company Name** | Location | Dates\\n- [Strong verb] + [achievement] + [metric]\\n...\\n\\n## Key Skills\\n[JD-matched skills first, comma-separated]\\n\\n## Education\\n...",
  "coverLetter": "# Cover Letter\\n\\n[First name Last name]\\n[City, State | phone | email]\\n\\n[Opening paragraph: 2-3 sentences. Start with a real, specific observation about the company or role — not a compliment, a real hook. Then make the connection to why you're reaching out. No corporate filler.]\\n\\n[Middle paragraph: 2-3 sentences. Drop 1-2 specific achievements with real numbers. Connect them directly to what the role needs. Be concrete.]\\n\\n[Closing paragraph: 1-2 sentences. Direct and confident. No groveling.]\\n\\n[First name only]",
  "suggestedEdits": "## What Changed & Why\\n\\nHere's the reasoning behind every major move made in the tailored resume:\\n\\n### Summary\\n[1-2 sentences on how the summary was repositioned and what JD signals drove it]\\n\\n### Skills Section\\n- **Added**: [keyword] — [why: required in JD / ATS must-match]\\n- **Moved up**: [skill] — [why: JD lists it as primary requirement]\\n- **Removed**: [skill] — [why: not mentioned in JD, used the space for higher-signal terms]\\n\\n### [Company Name] ([years])\\n- **Bullet X rewritten** — original focused on [X]; new version leads with [stronger verb + JD-matched outcome] because the JD signals [specific requirement]\\n- **New bullet added** — covers [topic] because JD explicitly calls out [signal]\\n\\n### [Next Company / Role]\\n- [reasoning for changes made to that role]\\n\\n### What was NOT changed and why\\n[Brief note on anything deliberately kept as-is and the rationale]"
}`;

  const model = options?.model || 'claude-sonnet-4-5';
  const message = await anthropic.messages.create({
    model,
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    return { resume: 'Error generating resume', coverLetter: 'Error generating cover letter' };
  }

  try {
    const text = block.text.trim().replace(/^```json\s*/,'').replace(/\s*```$/,'').trim();
    const parsed = JSON.parse(text) as { resume: string; coverLetter: string; suggestedEdits?: string; analysis?: TailoringAnalysis };

    // Log character count compliance so we can monitor how well Claude is hitting the target
    const outputChars = (parsed.resume ?? '').length;
    const drift = outputChars - baseCharCount;
    const driftPct = Math.round((drift / baseCharCount) * 100);
    const inRange = outputChars >= charMin && outputChars <= charMax;
    console.log(`[Tailor] Length check: original=${baseCharCount} chars | output=${outputChars} chars | drift=${drift > 0 ? '+' : ''}${drift} (${driftPct > 0 ? '+' : ''}${driftPct}%) | ${inRange ? '✅ within ±7% tolerance' : '⚠️ OUTSIDE tolerance (' + charMin + '–' + charMax + ')'}`);

    return {
      resume: parsed.resume ?? '',
      coverLetter: parsed.coverLetter ?? '',
      suggestedEdits: parsed.suggestedEdits,
      analysis: parsed.analysis,
    };
  } catch {
    return { resume: block.text, coverLetter: '' };
  }
}

// ── Cover Letter Generator ────────────────────────────────────────────────────
// Two-step: (1) web-search research for specific company facts,
//           (2) cover letter generation grounded in those facts.

export interface CoverLetterResearch {
  specificFacts: string[];
  companyMoment: string;
  productContext: string;
  roleContext: string;
}

export interface CoverLetterResult {
  coverLetter: string;
  research: CoverLetterResearch | null;
  researchFailed: boolean;
}

// ── Territory Intelligence ─────────────────────────────────────────────────

export interface TerritoryContext {
  territoryDetected: string;
  whyThisTerritory: string;
  keyIndustries: string[];
  majorProspects: string[];
  recentWins: string[];
  competitiveLandscape: string;
  marketMoment: string;
  candidateAdvantage: string;
}

const TERRITORY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bsoutheast\b/i, label: 'Southeast' },
  { re: /\bnortheast\b/i, label: 'Northeast' },
  { re: /\bmid-?atlantic\b/i, label: 'Mid-Atlantic' },
  { re: /\bpacific\s+northwest\b/i, label: 'Pacific Northwest' },
  { re: /\bcentral\s+region\b|\bcentral\s+us\b|\bcentral\s+territory\b/i, label: 'Central' },
  { re: /\bmountain\s+west\b/i, label: 'Mountain West' },
  { re: /\bsouthwest\b/i, label: 'Southwest' },
  { re: /\bnorthwest\b/i, label: 'Northwest' },
  { re: /\bmidwest\b/i, label: 'Midwest' },
  { re: /\bsled\b/i, label: 'SLED' },
  { re: /\bfederal\b|\bfed\s+civ\b|\bfedciv\b|\bdod\b|\bdefense\b/i, label: 'Federal' },
  { re: /\bnew\s+england\b/i, label: 'New England' },
  { re: /\bgulf\s+coast\b/i, label: 'Gulf Coast' },
  { re: /\bgreat\s+lakes\b/i, label: 'Great Lakes' },
  { re: /\bappalachia\b/i, label: 'Appalachia' },
  // US states
  { re: /\bcalifornia\b|\bca\s+territory\b/i, label: 'California' },
  { re: /\btexas\b|\btx\s+territory\b/i, label: 'Texas' },
  { re: /\bnew\s+york\b|\bny\s+territory\b/i, label: 'New York' },
  { re: /\bflorida\b|\bfl\s+territory\b/i, label: 'Florida' },
  { re: /\billino[i]s\b/i, label: 'Illinois' },
  { re: /\bgeorgia\b/i, label: 'Georgia' },
  { re: /\bnorth\s+carolina\b/i, label: 'North Carolina' },
  { re: /\bvirginia\b/i, label: 'Virginia' },
  { re: /\bwashington\s+dc\b|\bwashington,?\s*d\.c\b/i, label: 'Washington DC' },
  { re: /\bchicago\b/i, label: 'Chicago' },
  { re: /\bbay\s+area\b|\bsilicon\s+valley\b/i, label: 'Bay Area' },
  { re: /\bnew\s+england\b/i, label: 'New England' },
  // Vertical territories
  { re: /\bhealthcare\s+(southeast|northeast|midwest|southwest|northwest|west|east|south|north|central)\b/i, label: 'Healthcare territory' },
  { re: /\bfinancial\s+services?\s+(ny|new\s+york|northeast)\b/i, label: 'Financial Services Northeast' },
  { re: /\bpublic\s+sector\s+(dc|washington)\b/i, label: 'Public Sector DC' },
];

export function detectTerritory(jobTitle: string, jobDescription: string): string | null {
  const combined = `${jobTitle} ${jobDescription.slice(0, 800)}`;
  for (const { re, label } of TERRITORY_PATTERNS) {
    if (re.test(combined)) return label;
  }
  return null;
}

export async function analyzeTerritoryContext(
  jobTitle: string,
  companyName: string,
  territory: string,
  resumeText: string,
): Promise<TerritoryContext | null> {
  try {
    console.log(`[Territory] Analyzing territory context: ${territory} for ${jobTitle} @ ${companyName}`);
    const prompt = `A company called ${companyName} is hiring a ${jobTitle} specifically for the ${territory} territory. I need to understand why they are investing in this territory right now and what opportunity they are chasing.

Search for:
- "${companyName} ${territory} expansion customers"
- "${companyName} ${territory} office hiring growth"
- "${companyName} ${territory} major wins deals customers 2025 2026"
- "industry growth ${territory} 2025 2026"
- Major enterprises headquartered in ${territory} that would be ideal prospects for ${companyName}'s products

CANDIDATE RESUME (for candidateAdvantage field):
${resumeText.slice(0, 1500)}

Return ONLY a JSON object:
{
  "territoryDetected": "${territory}",
  "whyThisTerritory": "why is this company investing in this specific territory right now — market conditions, customer concentration, competitive dynamics, or growth signals",
  "keyIndustries": ["top 3-4 industries concentrated in this territory that are ideal buyers for this company"],
  "majorProspects": ["5-8 specific well-known companies headquartered or with major operations in this territory that would be ideal customers — be specific with real company names"],
  "recentWins": ["any publicly known customer wins this company has had in this territory or with companies based there"],
  "competitiveLandscape": "who are the main competitors active in this territory and what is the dynamic",
  "marketMoment": "one sentence on the single biggest opportunity in this territory for this company right now",
  "candidateAdvantage": "based on the candidate resume provided above, what specific experience makes them uniquely suited for THIS territory — look for: companies they sold to in the region, industries they know that are concentrated here, geographic familiarity, relevant logos"
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1200,
      system: 'You are a territory market research specialist. After using web search, respond with ONLY a valid JSON object. No conversational text, no markdown — just raw JSON starting with { and ending with }.',
      tools: [{ type: 'web_search_20250305', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlocks = msg.content.filter(b => b.type === 'text').map(b => (b as any).text as string);
    for (let i = textBlocks.length - 1; i >= 0; i--) {
      const raw = textBlocks[i].trim().replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.territoryDetected && parsed.whyThisTerritory) {
          console.log(`[Territory] Analysis complete for ${territory}`);
          return parsed as TerritoryContext;
        }
      } catch {
        const m = raw.match(/\{[\s\S]*"territoryDetected"[\s\S]*\}/);
        if (m) {
          try { const p = JSON.parse(m[0]); if (p.territoryDetected) return p as TerritoryContext; } catch { /* skip */ }
        }
      }
    }
    console.warn('[Territory] Could not parse territory context response');
    return null;
  } catch (e) {
    console.error('[Territory] analyzeTerritoryContext failed (non-fatal):', e instanceof Error ? e.message : e);
    return null;
  }
}

// Default cover letter style instructions stored in DB under key 'cover_letter_instructions'.
// These can be overridden per-generation by passing customInstructions.
export const DEFAULT_COVER_LETTER_INSTRUCTIONS = `You write cover letters structured exactly like great B2B sales cold emails. Your letters do NOT recap the resume — the hiring manager will read that anyway. You lead with the company's situation, position the candidate as the solution to a specific problem, and close with a low-commitment ask.

STRUCTURE (follow this exactly):

1. OPENING (1-2 sentences): Lead with what is happening at the company RIGHT NOW that makes this role urgent or strategic. Ground it in real research — a product launch, an expansion, a funding event, a market shift. Do NOT start with "I" or "I am applying for." Start with THEM, their moment, their problem.

2. PIVOT (1 sentence): A tight transition that bridges from their situation to the candidate. Something like "That is exactly the problem I have spent the last [X] years solving." Natural, confident, not sycophantic.

3. THREE PROOF BULLETS (3 lines, no more): Each bullet = one metric, one outcome, one line. These are the candidate's most relevant accomplishments for this specific role. Use plain dashes (-). Make them tight and scannable — a hiring manager spending 15 seconds gets the full picture from just these three.

4. POSITIONING SENTENCE (1 sentence): Connect their specific problem to the candidate's specific track record. Not generic. Name the problem, name the solution.

5. CLOSE (2 sentences max): Ask for a specific next step with low commitment. Example: "Would 20 minutes next week make sense?" or "Happy to share a few relevant case studies if useful." Never "I would welcome the opportunity." Never "I look forward to hearing from you." Just signal and a clear ask.

CRITICAL RULES:
- No em dashes (—) or en dashes (–) anywhere
- No "leverage" or "leveraging"
- No "passionate" or "passionate about"
- No "I am excited to" or "I am thrilled to"
- No "synergy" or any corporate buzzwords
- No "utilize" — use "use" instead
- No dense paragraphs — the structure above is the structure
- Total length: under 200 words — shorter is better
- The letter must never mention Claude, AI, or that it was generated`;

export async function generateCoverLetterWithClaude(params: {
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  resumeText: string;
  userName: string;
  existingResearch?: string | null;
  temperature?: number;
  model?: string;
  territoryContext?: TerritoryContext | null;
  customInstructions?: string | null;
  systemPrompt?: string | null;
  tailoredResumeText?: string | null;
}): Promise<CoverLetterResult> {
  const { jobTitle, companyName, jobDescription, resumeText, userName, existingResearch, territoryContext, customInstructions, tailoredResumeText } = params;
  const temperature = params.temperature ?? 1;
  const MODEL_CL = params.model || 'claude-opus-4-6';

  // ── STEP 1: Web-search research for specific, impressive company facts ──────
  let research: CoverLetterResearch | null = null;
  let researchFailed = false;

  try {
    const researchPrompt = `I am writing a cover letter for a ${jobTitle} position at ${companyName}. Before I write it, find 3-5 highly specific, recent, concrete facts about this company that would impress a hiring manager if referenced in a cover letter. These should be things a casual applicant would not know — specific product launches, recent partnerships, funding details, strategic pivots, leadership quotes about company direction, customer wins, expansion plans, or competitive moves.

Do NOT include generic facts like "they are a technology company" or "they value innovation."

${existingResearch ? `EXISTING RESEARCH (use as context, supplement with current web search for anything more recent):\n${existingResearch.slice(0, 1500)}\n\n` : ''}JOB DESCRIPTION (for context on the role and what to research):\n${jobDescription.slice(0, 800)}

Respond with ONLY this JSON structure — no other text:
{
  "specificFacts": ["fact 1 with source or date", "fact 2", "fact 3", "fact 4", "fact 5"],
  "companyMoment": "one sentence describing the most compelling thing happening at this company right now that a candidate should reference",
  "productContext": "what their core product does and why it matters to their customers right now",
  "roleContext": "based on the job description, what specific problem is this person being hired to solve"
}`;

    const researchMsg = await anthropic.messages.create({
      model: MODEL_CL,
      max_tokens: 1000,
      system: 'You are a research assistant. After using web search to gather information, respond with ONLY a valid JSON object. No conversational text, no markdown — just raw JSON starting with { and ending with }.',
      tools: [{ type: 'web_search_20250305', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
      messages: [{ role: 'user', content: researchPrompt }],
    });

    const textBlocks = researchMsg.content.filter(b => b.type === 'text').map(b => (b as any).text as string);
    for (let i = textBlocks.length - 1; i >= 0; i--) {
      const raw = textBlocks[i].trim().replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.specificFacts && parsed.companyMoment) {
          research = parsed as CoverLetterResearch;
          break;
        }
      } catch {
        const m = raw.match(/\{[\s\S]*"specificFacts"[\s\S]*\}/);
        if (m) {
          try { research = JSON.parse(m[0]) as CoverLetterResearch; break; } catch { /* continue */ }
        }
      }
    }
    if (!research) researchFailed = true;
  } catch (e) {
    console.error('[CoverLetter] Research step failed (non-fatal):', e instanceof Error ? e.message : e);
    researchFailed = true;
  }

  // ── STEP 2: Cover letter generation grounded in research ──────────────────
  const factsBlock = research
    ? `COMPANY RESEARCH (use the most relevant facts to ground the opening and positioning):\n${research.specificFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nCOMPANY MOMENT: ${research.companyMoment}\n\nROLE CONTEXT (the specific problem they are hiring this person to solve): ${research.roleContext}`
    : `Note: Live research was unavailable. Use the job description to ground the opening in what is happening at the company.`;

  // Priority: DB-loaded systemPrompt > customInstructions > DEFAULT_COVER_LETTER_INSTRUCTIONS
  const resolvedSystemPrompt = params.systemPrompt?.trim()
    || customInstructions?.trim()
    || DEFAULT_COVER_LETTER_INSTRUCTIONS;

  // Build territory block if context exists
  const territoryBlock = territoryContext
    ? `\nTERRITORY CONTEXT: This is a ${territoryContext.territoryDetected} territory role.\nWhy this territory matters to the company: ${territoryContext.whyThisTerritory}\nKey prospect industries in territory: ${territoryContext.keyIndustries.join(', ')}\nMajor prospect accounts: ${territoryContext.majorProspects.join(', ')}\nMarket moment: ${territoryContext.marketMoment}\nWhy the candidate fits this territory: ${territoryContext.candidateAdvantage}\n\nFor territory roles: work the geography into the opening or proof points — show you understand the specific business opportunity in ${territoryContext.territoryDetected}, not just that you live there.`
    : '';

  // Include tailored resume if available — this is the ATS-matched version the cover letter should pull proof points from
  const tailoredResumeBlock = tailoredResumeText?.trim()
    ? `\nTAILORED RESUME (pull the 3 most relevant proof points from here — this has already been matched to this specific role):\n${tailoredResumeText.slice(0, 2500)}`
    : `\nMASTER RESUME (pull the 3 most relevant proof points from here — metrics, outcomes, company names):\n${resumeText.slice(0, 2000)}`;

  const userPrompt = `Write a cover letter for this application. Follow the structure and rules in the system prompt exactly.

APPLICANT NAME: ${userName || 'The Candidate'}
ROLE: ${jobTitle} at ${companyName}

JOB DESCRIPTION:
${jobDescription.slice(0, 1500)}
${tailoredResumeBlock}

${factsBlock}${territoryBlock}

Return ONLY the cover letter text. No subject line. No preamble. No explanation.`;

  const genMsg = await anthropic.messages.create({
    model: MODEL_CL,
    max_tokens: 2000,
    temperature,
    system: resolvedSystemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const letterText = genMsg.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text as string)
    .join('\n')
    .trim();

  return { coverLetter: letterText, research, researchFailed };
}

// ── Resume Tailoring V2 (3-step: ATS research → Gap analysis → Generation) ──

export interface AtsKeywordResearch {
  mustHaveKeywords: string[];
  niceToHaveKeywords: string[];
  companySpecificTerms: string[];
  titleVariants: string[];
  avoidTerms: string[];
  buyerPersona: string;
  topRequirements: string[];
}

export interface GapAnalysis {
  keywordsPresent: string[];
  keywordsMissing: string[];
  experienceToHighlight: string[];
  experienceToDownplay: string[];
  summaryAngle: string;
  atsScore: number;
  projectedScore: number;
}

export interface TailoredResumeV2Result {
  resumeText: string;
  atsResearch: AtsKeywordResearch;
  gapAnalysis: GapAnalysis;
  researchFailed: boolean;
}

export async function tailorResumeV2WithClaude(params: {
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  resumeText: string;
  companyResearchContext?: string | null;
  model?: string;
  territoryContext?: TerritoryContext | null;
  resumeSystemPrompt?: string | null;
}): Promise<TailoredResumeV2Result> {
  const { jobTitle, companyName, jobDescription, resumeText, companyResearchContext, territoryContext, resumeSystemPrompt } = params;
  const MODEL = params.model || 'claude-opus-4-6';

  console.log(`[TailorV2] Starting 3-step tailoring for ${jobTitle} @ ${companyName}`);

  // ── STEP 1: ATS keyword research (Claude with web search) ─────────────────
  let atsResearch: AtsKeywordResearch = {
    mustHaveKeywords: [], niceToHaveKeywords: [], companySpecificTerms: [],
    titleVariants: [], avoidTerms: [], buyerPersona: '', topRequirements: [],
  };
  let researchFailed = false;

  try {
    const step1Prompt = `I need to tailor a resume for a ${jobTitle} role at ${companyName}. Research what ATS systems and recruiters at this type of company scan for.

Search for:
- "${companyName} ${jobTitle} job requirements"
- "${companyName} sales culture what they look for"
- "ATS keywords ${jobTitle} resume 2025 2026"
- "${companyName} tech stack products" to understand what terminology to use

Also read this job description carefully:
${jobDescription.slice(0, 2000)}

Return ONLY a JSON object with no other text:
{
  "mustHaveKeywords": ["keywords that MUST appear in the resume to pass ATS — these are in the job description verbatim or are standard for this role type"],
  "niceToHaveKeywords": ["keywords that boost score but are not required"],
  "companySpecificTerms": ["product names, technologies, methodologies specific to this company that show insider knowledge"],
  "titleVariants": ["all variations of this job title that should appear naturally in the resume"],
  "avoidTerms": ["terms that signal wrong industry fit for this specific role"],
  "buyerPersona": "who this person will be selling to or working with — titles, industries, company sizes",
  "topRequirements": ["top 5 things this company is actually hiring for based on job description and company research"]
}`;

    const step1Msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: 'You are an ATS and recruiting research specialist. After using web search, respond with ONLY a valid JSON object. No conversational text, no markdown — just raw JSON starting with { and ending with }.',
      tools: [{ type: 'web_search_20250305', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
      messages: [{ role: 'user', content: step1Prompt }],
    });

    const textBlocks1 = step1Msg.content.filter(b => b.type === 'text').map(b => (b as any).text as string);
    for (let i = textBlocks1.length - 1; i >= 0; i--) {
      const raw = textBlocks1[i].trim().replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.mustHaveKeywords && Array.isArray(parsed.mustHaveKeywords)) {
          atsResearch = parsed as AtsKeywordResearch;
          break;
        }
      } catch {
        const m = raw.match(/\{[\s\S]*"mustHaveKeywords"[\s\S]*\}/);
        if (m) { try { atsResearch = JSON.parse(m[0]) as AtsKeywordResearch; break; } catch { /* skip */ } }
      }
    }
    console.log(`[TailorV2] Step 1 complete — ${atsResearch.mustHaveKeywords.length} must-have keywords, ${atsResearch.topRequirements.length} top requirements`);
  } catch (e) {
    console.error('[TailorV2] Step 1 (ATS research) failed:', e instanceof Error ? e.message : e);
    researchFailed = true;
  }

  // ── STEP 2: Gap analysis (Claude, no web search) ──────────────────────────
  let gapAnalysis: GapAnalysis = {
    keywordsPresent: [], keywordsMissing: [], experienceToHighlight: [],
    experienceToDownplay: [], summaryAngle: '', atsScore: 0, projectedScore: 0,
  };

  try {
    const step2Prompt = `Compare this resume against the job requirements and identify gaps and opportunities.

RESUME:
${resumeText.slice(0, 3000)}

JOB REQUIREMENTS:
${atsResearch.topRequirements.join('\n')}

MUST-HAVE KEYWORDS:
${atsResearch.mustHaveKeywords.join(', ')}

COMPANY-SPECIFIC TERMS:
${atsResearch.companySpecificTerms.join(', ')}

Return ONLY a JSON object:
{
  "keywordsPresent": ["keywords from mustHaveKeywords already in resume"],
  "keywordsMissing": ["keywords from mustHaveKeywords NOT in resume that need to be added"],
  "experienceToHighlight": ["specific experiences from the resume that map directly to the top requirements — reference exact bullet points"],
  "experienceToDownplay": ["experiences that signal wrong industry fit for this specific role"],
  "summaryAngle": "the specific narrative angle the summary should take for this role and company",
  "atsScore": 0,
  "projectedScore": 0
}`;

    const step2Msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: 'You are a resume gap analyst. Respond with ONLY a valid JSON object. No markdown, no explanation.',
      messages: [{ role: 'user', content: step2Prompt }],
    });

    const textBlocks2 = step2Msg.content.filter(b => b.type === 'text').map(b => (b as any).text as string);
    for (let i = textBlocks2.length - 1; i >= 0; i--) {
      const raw = textBlocks2[i].trim().replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.summaryAngle !== undefined) { gapAnalysis = parsed as GapAnalysis; break; }
      } catch {
        const m = raw.match(/\{[\s\S]*"summaryAngle"[\s\S]*\}/);
        if (m) { try { gapAnalysis = JSON.parse(m[0]) as GapAnalysis; break; } catch { /* skip */ } }
      }
    }
    console.log(`[TailorV2] Step 2 complete — ATS before: ${gapAnalysis.atsScore}%, projected: ${gapAnalysis.projectedScore}%, missing: ${gapAnalysis.keywordsMissing.length} keywords`);
  } catch (e) {
    console.error('[TailorV2] Step 2 (gap analysis) failed:', e instanceof Error ? e.message : e);
  }

  // ── STEP 3: Resume generation ─────────────────────────────────────────────
  const companyMoment = companyResearchContext ? `\n\nCOMPANY RESEARCH CONTEXT (use to make the summary feel specific to this company):\n${companyResearchContext.slice(0, 1000)}` : '';

  const territoryResumeBlock = territoryContext
    ? `\n\nTERRITORY CONTEXT FOR THIS ROLE:\nTerritory: ${territoryContext.territoryDetected}\nKey industries in territory: ${territoryContext.keyIndustries.join(', ')}\nLikely target accounts: ${territoryContext.majorProspects.join(', ')}\nWhy candidate fits this territory: ${territoryContext.candidateAdvantage}\n\nADDITIONAL RESUME TAILORING INSTRUCTIONS FOR TERRITORY ROLES:\n- In the professional summary, if the candidate has relevant geographic or industry experience for this territory, surface it explicitly\n- If the candidate has sold to companies headquartered or operating heavily in this territory, reframe those bullets to make the geographic relevance clear\n- If the candidate's past accounts include companies that are in the same industry as the major prospects in this territory, highlight that industry expertise\n- Add the territory name naturally in the summary if the candidate has genuine relevant experience there — do not fabricate geographic experience`
    : '';

  // Use DB-loaded system prompt if provided, otherwise fall back to hardcoded default
  const systemPrompt = resumeSystemPrompt?.trim() || `You are an expert resume writer who specializes in helping enterprise technology sales professionals land roles at hardware, semiconductor, AI infrastructure, networking, and industrial technology companies. You write resumes that pass ATS screening and impress human recruiters.

CRITICAL RULES:
- Never fabricate experience, metrics, companies, or achievements — only use what is in the source resume
- You MAY reframe, reorder, and reword existing experience to better match the target role
- You MAY add industry-specific keywords naturally into existing bullet points where they accurately describe what the person did
- You MAY restructure bullet points to lead with the most relevant achievement for this specific role
- You MAY add a professional summary tailored to this specific role and company
- Keep all dates, titles, and company names exactly as they appear in the source resume
- Every metric and number must come directly from the source resume — do not invent or inflate
- The resume must read as written by the candidate, not a robot — vary sentence structure, avoid buzzwords
- Never use em dashes
- Never use the word "leverage" or "leveraging"
- Never use "utilize" — use "use"
- Never use "passionate" or "passionate about"
- Never use "results-driven" or "dynamic" or "seasoned"
- Bullet points should start with strong action verbs
- Each bullet should lead with the outcome or achievement, not the activity
- Maximum 5 bullets per role — quality over quantity
- Total resume length should not exceed 1 page if possible, 2 pages maximum`;

  const userPrompt = `Tailor this resume for the specific role and company below. Make it pass ATS screening and impress a human recruiter at this company.

TARGET ROLE: ${jobTitle} at ${companyName}

JOB DESCRIPTION:
${jobDescription.slice(0, 1500)}

SOURCE RESUME:
${resumeText}

ATS KEYWORDS TO INCORPORATE (weave these in naturally — do not keyword stuff):
Must-have: ${atsResearch.mustHaveKeywords.join(', ')}
Company-specific: ${atsResearch.companySpecificTerms.join(', ')}

GAPS TO CLOSE:
${gapAnalysis.keywordsMissing.join(', ')}

EXPERIENCES TO HIGHLIGHT:
${gapAnalysis.experienceToHighlight.join('\n')}

EXPERIENCES TO DOWNPLAY:
${gapAnalysis.experienceToDownplay.join('\n')}

SUMMARY ANGLE:
${gapAnalysis.summaryAngle}${companyMoment}${territoryResumeBlock}

BUYER PERSONA FOR THIS ROLE:
${atsResearch.buyerPersona}

INSTRUCTIONS:

1. PROFESSIONAL SUMMARY (add at the top — 3 sentences max):
Write a tight summary that speaks directly to this role. Reference the company's specific market position or what they are building right now. Connect the candidate's most relevant experience to what this company needs. Do not be generic. Do not open with "Results-driven" or any cliche.

2. EXPERIENCE SECTION:
Reorder and reframe bullets to lead with achievements most relevant to this role. Incorporate missing ATS keywords naturally where they accurately describe what the candidate did. Downplay irrelevant experience without removing it entirely. Keep all titles, companies, dates, and metrics exactly as in the source.

3. SKILLS SECTION:
Reorder skills to put the most relevant ones first. Add any missing must-have keywords as skills where they accurately represent the candidate's abilities.

4. KEYWORD CHECK:
After writing the resume, verify every keyword from the must-have list appears at least once. If any are missing, find a natural place to add them.

Return the complete tailored resume as plain text, formatted cleanly with clear section headers. Return ONLY the resume text, nothing else.`;

  const step3Msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const resumeText2 = step3Msg.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text as string)
    .join('\n')
    .trim();

  console.log(`[TailorV2] Step 3 complete — resume ${resumeText2.length} chars`);

  return { resumeText: resumeText2, atsResearch, gapAnalysis, researchFailed };
}
