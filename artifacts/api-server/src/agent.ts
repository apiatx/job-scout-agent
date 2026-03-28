import Anthropic from '@anthropic-ai/sdk';
import type { ScrapedJob } from './scraper.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
  ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL }
    : {}),
});

export interface SubScores {
  roleFit: number;          // 0-10: role title/level vs target roles
  companyQuality: number;   // 0-10: company reputation, growth, prestige
  locationFit: number;      // 0-10: remote/hybrid/location match
  hiringUrgency: number;    // 0-10: active hiring signals vs stale evergreen
  tailoringRequired: number;// 0-10: 10=minimal tailoring, 0=major overhaul needed
  referralOdds: number;     // 0-10: likelihood of finding a warm referral
  realVsFake: number;       // 0-10: confidence this is a genuine open role
}

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
  aiRiskReason: string;
  opportunityTier: OpportunityTier;
  subScores: SubScores;
}

interface CriteriaForAgent {
  targetRoles: string[];
  industries: string[];
  minSalary?: number | null;
  locations: string[];
  allowedWorkModes?: string[];
  mustHave: string[];
  niceToHave: string[];
  avoid: string[];
  preApprovedCompanies?: string[];
  tierSettings?: TierSettings;
}

async function scoreOne(
  job: ScrapedJob,
  criteriaText: string,
  preApprovedSection: string,
  preApprovedCompanies: string[],
  tierSettings?: TierSettings,
  minSalary?: number | null,
): Promise<JobMatch | null> {
  try {
    const isPreApproved = preApprovedCompanies.some(
      (name) => name.toLowerCase() === job.company.toLowerCase()
    );
    let companySpecificSection = preApprovedSection;
    if (isPreApproved) {
      companySpecificSection += `\n\nNOTE: ${job.company} is on the user's pre-approved companies list. The user has already decided this company is a target employer. Score at least 65 if the role title meaningfully matches any of the user's target roles. Only score below 65 if the role type is completely wrong (e.g. engineering, marketing, HR, finance, legal) or the location is outside the user's preferences.`;
    }

    // Build salary constraint text for the prompt
    const salaryRule = minSalary
      ? `SALARY REQUIREMENT (hard gate):
The candidate requires a minimum of $${minSalary.toLocaleString()} base salary.
- If the job listing shows a salary AND the highest figure is below $${minSalary.toLocaleString()}: set matchScore=0 and isMatch=false.
- If no salary is listed: do not penalize — mention the unknown salary in whyGoodFit.`
      : '';

    const prompt = `You are an expert career strategist evaluating job opportunities for a sales professional. Your job is to score how well each job matches the candidate's stated criteria. Do not add opinions beyond what's in the criteria.

═══════════════════════════════════════════════════
CANDIDATE CRITERIA
═══════════════════════════════════════════════════
${criteriaText}

${salaryRule}

═══════════════════════════════════════════════════
JOB TO EVALUATE
═══════════════════════════════════════════════════
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Description: ${job.description.slice(0, 1200)}` : '(No description available)'}

${companySpecificSection}

═══════════════════════════════════════════════════
SCORING INSTRUCTIONS
═══════════════════════════════════════════════════
1. matchScore (0-100): How well does this job match ALL of the candidate's criteria above?
   - Start at 50, then adjust up/down based on each criterion.
   - Role title match to target roles: +/-30 (biggest factor — role type must match)
   - Location/remote match: +/-20
   - Salary compliance: hard gate (see above)
   - Must-have requirements met: +/-10 each
   - Avoid keywords present: -20 each
   - Company quality/reputation: +/-10
   - AI displacement risk (how easily could AI agents replace this company's core product?): LOW=no penalty, MEDIUM=-5, HIGH=-20

2. isMatch: true if matchScore >= 60, otherwise false.

3. isHardware: true if the company sells physical hardware, semiconductors, networking equipment, industrial machinery, or data center infrastructure products.

4. aiRisk — how easily could AI replace this company's core product?
   - LOW: Physical hardware, semiconductors, networking gear, storage, servers, industrial/defense tech, robotics — physical supply chains AI cannot replicate.
   - MEDIUM: Complex vertical SaaS with deep integrations, proprietary data moats, specialized industry software, ERP.
   - HIGH: Generic horizontal SaaS — workflow tools, basic project management, email productivity, simple analytics, form builders.

5. subScores (each 0-10, strictly objective based on criteria match):
   - roleFit: Does the title/responsibilities precisely match the candidate's target roles? 10=exact match, 5=partial, 0=wrong role type entirely.
   - companyQuality: Company reputation, financial health, growth trajectory. 10=elite/unicorn, 5=solid mid-market, 2=unknown startup.
   - locationFit: How well does the job location/remote match the candidate's location preferences? 10=perfect match, 5=partial/territory, 0=wrong region with no remote.
   - hiringUrgency: Signs of real active hiring. 10=specific unique JD with clear team context, 0=generic template copy-pasted across many cities.
   - tailoringRequired: 10=minimal tailoring needed, 0=major overhaul required.
   - referralOdds: Likelihood of finding a warm referral. 10=large well-known company, 0=tiny obscure startup.
   - realVsFake: Confidence this is a genuine currently-open role. 10=specific unique JD, 0=generic evergreen pipeline template.

LOCATION NOTE: "Remote" alone = work from anywhere. "Remote, [City]" or "Remote ([City] area)" = must live near that city. If the candidate's locations do not include that city, score locationFit 2-4 and reduce matchScore accordingly.

═══════════════════════════════════════════════════
REQUIRED OUTPUT — JSON ONLY, NO MARKDOWN
═══════════════════════════════════════════════════
{
  "matchScore": <0-100 integer>,
  "whyGoodFit": "<2-3 sentences explaining the match or mismatch against the candidate's specific criteria>",
  "isMatch": <true if matchScore >= 60, else false>,
  "isHardware": <true | false>,
  "aiRisk": <"LOW" | "MEDIUM" | "HIGH">,
  "aiRiskReason": "<one sentence on AI displacement risk>",
  "subScores": {
    "roleFit": <0-10>,
    "companyQuality": <0-10>,
    "locationFit": <0-10>,
    "hiringUrgency": <0-10>,
    "tailoringRequired": <0-10>,
    "referralOdds": <0-10>,
    "realVsFake": <0-10>
  }
}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 900,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    if (block.type !== 'text') return null;

    const text = block.text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text) as {
      matchScore: number;
      whyGoodFit: string;
      isMatch: boolean;
      isHardware?: boolean;
      aiRisk?: 'LOW' | 'MEDIUM' | 'HIGH';
      aiRiskReason?: string;
      subScores?: {
        roleFit?: number;
        companyQuality?: number;
        locationFit?: number;
        hiringUrgency?: number;
        tailoringRequired?: number;
        referralOdds?: number;
        realVsFake?: number;
      };
    };

    if (!parsed.isMatch) {
      if (parsed.matchScore >= 30) {
        const riskTag = parsed.aiRisk ? ` [${parsed.aiRisk} risk]` : '';
        console.log(`  ✗ Rejected (${parsed.matchScore})${riskTag}: ${job.company} — "${job.title}" — ${parsed.whyGoodFit?.slice(0, 80)}`);
      }
      return null;
    }

    const subScores: SubScores = {
      roleFit:           Math.min(10, Math.max(0, parsed.subScores?.roleFit ?? 5)),
      companyQuality:    Math.min(10, Math.max(0, parsed.subScores?.companyQuality ?? 5)),
      locationFit:       Math.min(10, Math.max(0, parsed.subScores?.locationFit ?? 5)),
      hiringUrgency:     Math.min(10, Math.max(0, parsed.subScores?.hiringUrgency ?? 5)),
      tailoringRequired: Math.min(10, Math.max(0, parsed.subScores?.tailoringRequired ?? 5)),
      referralOdds:      Math.min(10, Math.max(0, parsed.subScores?.referralOdds ?? 5)),
      realVsFake:        Math.min(10, Math.max(0, parsed.subScores?.realVsFake ?? 5)),
    };

    // Tier is ALWAYS computed from user settings — Claude does not assign tier.
    const tier: OpportunityTier = computeTier(
      parsed.matchScore, parsed.aiRisk ?? 'unknown', subScores,
      job.title, job.company, job.location, tierSettings
    );

    console.log(`  ✓ Match (${parsed.matchScore}) [${tier}] [AI:${parsed.aiRisk ?? '?'}]: ${job.company} — "${job.title}"`);

    return {
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      applyUrl: job.applyUrl,
      whyGoodFit: parsed.whyGoodFit,
      matchScore: parsed.matchScore,
      isHardware: parsed.isHardware ?? false,
      aiRisk: parsed.aiRisk ?? 'unknown',
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
  topTargetScore?: number;      // Min match score for Top Target (default 65)
  fastWinScore?: number;        // Min match score for Fast Win (default 55)
  stretchScore?: number;        // Min match score for Stretch Role (default 55)
  experienceLevels?: string[];  // Array of: 'junior' | 'mid' | 'senior' | 'strategic'
}

// Level hierarchy rank — 4 tiers matching the user's experience model
// junior=0: SMB / commercial at mid-tier company
// mid=1:    commercial at good-fit company, Corporate, MM
// senior=2: Sr./Senior, Named, Enterprise
// strategic=3: Strategic, Sr.Enterprise, Strategic Enterprise, Account Director
const LEVEL_RANK: Record<string, number> = { junior: 0, mid: 1, senior: 2, strategic: 3 };


const DEFAULT_VERTICAL_NICHES   = ['federal', 'government', 'sled', 'fsi', 'dod', 'defense', 'navy', 'army', 'air force', 'marines', 'public sector', 'healthcare', 'health system', 'life sciences', 'pharma', 'pharmaceutical', 'banking', 'financial services', 'insurance', 'education', 'k-12', 'higher ed', 'gsi', 'hyperscaler', 'hyperscale'];

export function computeTier(
  matchScore: number,
  aiRisk: string,
  s: SubScores,
  title = '',
  company = '',
  location = '',
  settings?: TierSettings,
): OpportunityTier {
  // === HARD SKIPS ===
  if (aiRisk === 'HIGH') return 'Probably Skip';
  if (s.realVsFake < 5) return 'Probably Skip';
  if (matchScore < 50) return 'Probably Skip';

  // NOTE: Location filtering is handled EXTERNALLY by checkJobLocation() before this function is called.
  // computeTier() should never block based on isRemote — that is the location filter's job.

  // === USER-CONFIGURABLE THRESHOLDS ===
  const topTargetScore = settings?.topTargetScore ?? 65;
  const fastWinScore   = settings?.fastWinScore   ?? 55;
  const stretchScore   = settings?.stretchScore   ?? 55;

  // === VERTICAL NICHE CHECK (user-configurable) ===
  const nicheList = (settings?.verticalNiches && settings.verticalNiches.length > 0)
    ? settings.verticalNiches.map((n) => n.toLowerCase().trim())
    : DEFAULT_VERTICAL_NICHES;
  const titleLower = title.toLowerCase();
  const hasVerticalNiche = nicheList.some((niche) => {
    const escaped = niche.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(titleLower);
  });

  // === EXPERIENCE LEVEL CONFIGURATION ===
  // Determine the highest selected level — that sets the ceiling for what's "accessible"
  const expLevels = (settings?.experienceLevels && settings.experienceLevels.length > 0)
    ? settings.experienceLevels
    : ['senior'];
  const maxRank = Math.max(...expLevels.map((l) => LEVEL_RANK[l] ?? 2)); // default to senior (2)

  // === ROLE TITLE ANALYSIS ===
  // Strategic-level titles include "Major" / "Majors" accounts roles in addition to Strategic/Sr.Enterprise/Account Director
  const isStrategic    = /\b(strategic|major|majors)\b/i.test(title);
  const isDirector     = /\b(director|rvp\b|vice president|vp\b)\b/i.test(title);
  const isPrincipal    = /\bprincipal\b/i.test(title);
  const isNamedAE      = /\bnamed\b/i.test(title);
  const isSenior       = /\b(senior|sr\.?)\b/i.test(title);
  const hasEnterprise  = /\benterprise\b/i.test(title);
  const isSrEnterprise = isSenior && hasEnterprise;

  // Signals that a role is ABOVE the user's current experience level — 4-tier model:
  //   junior (0):   SMB / commercial at mid-tier; Enterprise, Named, Sr.Enterprise, Strategic, Director all above
  //   mid (1):      Commercial-good, Corporate, MM accessible; Enterprise, Named, Sr.Enterprise, Strategic, Director above
  //   senior (2):   Sr./Senior, Named, Enterprise accessible; Sr.Enterprise, Strategic, Director above
  //   strategic (3): Strategic, Sr.Enterprise, Account Director accessible; very little above
  const namedAbove        = maxRank < 2 ? isNamedAE    : false; // Named: above for junior/mid; accessible at senior+
  const enterpriseAbove   = maxRank < 2 ? hasEnterprise : false; // Enterprise: above for junior/mid; accessible at senior+
  const srEnterpriseAbove = maxRank < 3 ? isSrEnterprise : false; // Sr.Enterprise: above below strategic; accessible at strategic
  const strategicAbove    = maxRank < 3 ? isStrategic  : false; // Strategic: above below strategic level; accessible at strategic
  const directorAbove     = maxRank < 3 ? isDirector   : false; // Acct Director / RVP: above below strategic; accessible at strategic
  const principalAbove    = isPrincipal;                          // always above (IC track, not AE path)

  // Signals that a role is ABOVE the user's current experience level
  const isAboveLevel = namedAbove || enterpriseAbove || srEnterpriseAbove ||
    strategicAbove || directorAbove || principalAbove || hasVerticalNiche;

  // Role type modifiers — used to distinguish Top Target vs Fast Win, not for access gating
  // Any role not above level is considered accessible (catch-all — we rely on title filter upstream)
  const isAccessibleRole = !isAboveLevel;

  // Role types that typically have lower applicant competition → easier wins
  const hasCommercial  = /\bcommercial\b/i.test(title);
  const hasMidMarket   = /\b(mid[.\s-]?market|midmarket)\b/i.test(title);
  const hasCorporate   = /\bcorporate\b/i.test(title);
  const hasLowerBar    = hasCommercial || hasMidMarket || hasCorporate;

  // === TIER ASSIGNMENT ===

  // STRETCH: Title signals above user's configured experience level
  if (isAboveLevel && matchScore >= stretchScore && s.realVsFake >= 5) {
    return 'Stretch Role';
  }

  const isQualityCompany = s.companyQuality >= 7;
  const goodRoleFit      = s.roleFit >= 6;

  // TOP TARGET: Accessible role + high score + quality company + strong role fit
  if (isAccessibleRole && matchScore >= topTargetScore && isQualityCompany && goodRoleFit &&
      s.realVsFake >= 6) {
    return 'Top Target';
  }

  // FAST WIN: Lower-competition role type OR strong accessible role with solid score
  if (isAccessibleRole && hasLowerBar && matchScore >= fastWinScore && s.realVsFake >= 5) {
    return 'Fast Win';
  }
  if (isAccessibleRole && matchScore >= (fastWinScore + 5) && s.realVsFake >= 5) {
    return 'Fast Win';
  }

  // TOP TARGET fallback: above-level role but strong enough to be worth it
  if (isAboveLevel && matchScore >= topTargetScore && isQualityCompany && s.realVsFake >= 6) {
    return 'Stretch Role';
  }

  // STRETCH fallback: decent score, not disqualified
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
): Promise<{ opportunityTier: OpportunityTier; subScores: SubScores; aiRisk: string; aiRiskReason: string; whyGoodFit: string; matchScore: number } | null> {
  try {
    const result = await scoreOne(
      { title: job.title, company: job.company, location: job.location, salary: job.salary, applyUrl: job.applyUrl, description: job.description },
      criteriaText, preApprovedSection, preApprovedCompanies, tierSettings, minSalary
    );
    if (!result) return null;
    return {
      opportunityTier: result.opportunityTier,
      subScores: result.subScores,
      aiRisk: result.aiRisk,
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
        content: `Is "${companyName}" a hardware company, cloud infrastructure provider, top AI company, irreplaceable data/database platform, or industrial/energy technology software company? Answer only YES or NO.`,
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

export async function scoreJobsWithClaude(jobs: ScrapedJob[], criteria: CriteriaForAgent): Promise<JobMatch[]> {
  if (jobs.length === 0) return [];

  const criteriaText = [
    criteria.targetRoles.length ? `Target roles: ${criteria.targetRoles.join(', ')}` : '',
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
      batch.map((j) => scoreOne(j, criteriaText, preApprovedSection, criteria.preApprovedCompanies ?? [], criteria.tierSettings, criteria.minSalary))
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

export async function tailorResumeWithClaude(
  job: { title: string; company: string; location: string; description?: string; why_good_fit?: string; apply_url?: string },
  baseResume: string
): Promise<{ resume: string; coverLetter: string }> {
  const systemPrompt = `You are an elite executive resume writer and career strategist who has helped thousands of senior sales professionals land roles at top-tier technology companies. You specialize in crafting ATS-optimized resumes and compelling cover letters that highlight quantifiable achievements and strategic impact.

Your approach:
- Lead every bullet point with a strong action verb and quantifiable result (revenue generated, deals closed, % quota attainment, team size, territory growth)
- Mirror the exact language, keywords, and qualifications from the job description throughout the resume
- Position the candidate as a strategic revenue driver, not just a salesperson
- Highlight enterprise/strategic selling methodology experience (MEDDPICC, Challenger, Solution Selling, etc.) when relevant
- Emphasize relationships with C-suite buyers and complex deal cycles
- For the cover letter: open with a compelling hook, connect the candidate's track record directly to the company's mission and the role's requirements, and close with confidence and a clear call to action
- Keep the resume to 2 pages max, well-structured with clear sections: Summary, Experience, Key Skills, Education
- Never fabricate information — only reframe and optimize what's in the base resume`;

  const prompt = `Tailor this candidate's resume and write a cover letter for the following role.

JOB DETAILS:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Description:\n${job.description.slice(0, 3000)}` : ''}
${job.why_good_fit ? `Why it's a good fit: ${job.why_good_fit}` : ''}

CANDIDATE'S BASE RESUME:
${baseResume}

Respond ONLY with a JSON object (no extra text outside the JSON):
{
  "resume": "<the full tailored resume in Markdown format — use # for name, ## for section headers (Summary, Experience, Skills, Education), **bold** for job titles and company names, and - bullet points for achievements>",
  "coverLetter": "<the full cover letter in Markdown format — use ## for greeting/opening/closing headers, paragraphs separated by blank lines>"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    return { resume: 'Error generating resume', coverLetter: 'Error generating cover letter' };
  }

  try {
    const text = block.text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text) as { resume: string; coverLetter: string };
    return parsed;
  } catch {
    // If JSON parsing fails, try to extract the text content
    return { resume: block.text, coverLetter: '' };
  }
}
