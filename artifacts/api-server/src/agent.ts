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
}

async function scoreOne(job: ScrapedJob, criteriaText: string, preApprovedSection: string, preApprovedCompanies: string[]): Promise<JobMatch | null> {
  try {
    // Check if this job is from a pre-approved company
    const isPreApproved = preApprovedCompanies.some(
      (name) => name.toLowerCase() === job.company.toLowerCase()
    );
    let companySpecificSection = preApprovedSection;
    if (isPreApproved) {
      companySpecificSection += `\n\nIMPORTANT: This job is from ${job.company} which is on the user's pre-approved companies list. The user has already vetted and approved this company as a target employer. You MUST score this job at least 65 if the role title matches any of the user's target roles, regardless of whether the company sells hardware or software. The only valid reasons to score below 65 for a pre-approved company are: (1) the role title is completely wrong — e.g. engineering, product, marketing, HR, finance, legal — or (2) the job location is outside the user's location preferences.`;
    }

    const prompt = `You are an expert career strategist and job matching assistant. Deeply evaluate this job opportunity for a senior enterprise sales professional.

═══════════════════════════════════════════════════
EVALUATION FRAMEWORK
═══════════════════════════════════════════════════

ROLE ELIGIBILITY (hard gates — score 0 if violated):
- Only quota-carrying AE/AM/Partner roles qualify. Immediately reject: Solutions Architect, Sales Engineer, Engagement Manager, Channel Manager, Customer Success Manager, Marketing, Recruiting, HR, Finance, Legal — UNLESS the description explicitly states direct quota responsibility.
- Location: If candidate lists specific US regions, reject jobs outside those areas with matchScore=0 and locationFit=0.
- REMOTE vs REMOTE-IN-TERRITORY: "Remote" alone = fully flexible, work from anywhere. "Remote, Chicago" or "Remote (Austin area)" = must live near that city — this is a territory role. If candidate has not listed that city in their preferred locations, treat it as a location mismatch and score locationFit accordingly (2-4 if territory city is distant, 0 if strict location filtering is required).

ROLE TYPE SCORING GUIDANCE:
- Enterprise AE = primary target → score 75-95 at strong companies
- Commercial/Mid-Market/Corporate AE at hardware/infra companies → score 70-85 (strong pathway in)
- Partner Manager with revenue quota at tech/hardware company → score 65-80
- Account Manager with expansion quota at hardware/tech company → score 65-78
- Director of Sales with individual quota → score 65-80
- Generic AE at horizontal SaaS → score 40-60 maximum (AI displacement risk)

AI DISPLACEMENT RISK — DEATH BY CLAUDE:
Assess how easily this company's core product could be replaced by AI agents:
- LOW (no penalty): Physical hardware, semiconductors, networking gear, storage, servers, industrial machinery, defense hardware, photonics, robotics, power systems, sensors, data center infrastructure — physical supply chains AI cannot replicate.
- MEDIUM (-5 to matchScore): Complex vertical SaaS with deep operational integrations, specialized industry software, proprietary data moats, ERP, industrial control systems.
- HIGH (-20 to matchScore): Horizontal SaaS easily replicable by Claude — generic workflow tools, basic project management, email productivity, simple analytics, CRM plugins, form builders, scheduling tools.

GOVERNMENT/SLED NUANCE:
- Tier 1 SLED (score normally 70+): Palantir, Anduril, Shield AI, L3Harris, Leidos, Booz Allen Hamilton, CACI, ManTech, SAIC, Raytheon, MITRE, Peraton — defense tech/AI, mission-critical.
- Tier 2 SLED (score 40-55): Generic government IT VAR, basic hardware refresh, IT support shops.

${companySpecificSection}

═══════════════════════════════════════════════════
JOB TO EVALUATE
═══════════════════════════════════════════════════
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Description: ${job.description.slice(0, 1200)}` : '(No description available)'}

═══════════════════════════════════════════════════
CANDIDATE CRITERIA
═══════════════════════════════════════════════════
${criteriaText}

═══════════════════════════════════════════════════
REQUIRED OUTPUT — JSON ONLY, NO MARKDOWN
═══════════════════════════════════════════════════
Return this exact JSON structure:
{
  "matchScore": <0-100 integer — include AI displacement penalty before returning>,
  "whyGoodFit": "<2-3 sentences: what makes this a fit or miss, and what the candidate's key selling point would be>",
  "isMatch": <true if matchScore >= 60, else false>,
  "isHardware": <true if company sells physical hardware/infrastructure/semiconductor products>,
  "aiRisk": <"LOW" | "MEDIUM" | "HIGH">,
  "aiRiskReason": "<one sentence explaining AI displacement risk level>",
  "opportunityTier": <"Top Target" | "Fast Win" | "Stretch Role" | "Probably Skip">,
  "subScores": {
    "roleFit": <0-10: how precisely the role title/level matches the candidate's target roles>,
    "companyQuality": <0-10: company reputation, growth trajectory, prestige, financial health. 10=top-tier public/unicorn, 5=solid mid-market, 2=unknown startup>,
    "locationFit": <0-10: how well location/remote matches candidate preferences. 10=perfect match, 0=wrong region no remote>,
    "hiringUrgency": <0-10: signs of active urgent hiring. 10=specific requirements+clear growth need. 0=generic copy-paste template, likely stale pipeline req>,
    "tailoringRequired": <0-10: 10=almost no tailoring needed (generic requirements match well). 0=major overhaul needed (very specific different stack/industry)>,
    "referralOdds": <0-10: likelihood candidate could find a warm referral. 10=large well-known company with many LinkedIn connections. 0=tiny obscure startup>,
    "realVsFake": <0-10: confidence this is a genuine currently-open role. 10=specific unique JD with clear team context. 0=generic template, same JD across many cities, likely evergreen pipeline>
  },
  "tierReasoning": "<one sentence explaining why this tier was assigned>"
}

OPPORTUNITY TIER DECISION RULES — assign based on ROLE TYPE + COMPANY INDUSTRY + LOCATION, not just score:

"Top Target":
  WHO: Commercial AE, Mid-Market AE, Corporate AE, Account Executive (general enterprise with NO additional stretch qualifier), Account Manager, Named Account Executive, Major Account Executive — at a TARGET INDUSTRY company (hardware, cloud infrastructure, networking, storage, semiconductors, AI infrastructure, data center, industrial tech, defense tech). "Sr. Account Executive" (generic, no Enterprise in title) also belongs here at target-industry companies.
  LOCATION: Job must be remote OR remote-in-territory matching candidate's target locations.
  SCORE: matchScore≥65, aiRisk≠HIGH, realVsFake≥6.
  INTENT: Sweet-spot roles at the right companies — realistic wins AND great career moves.

"Fast Win":
  WHO: Commercial AE, Mid-Market AE, Corporate AE, SMB AE, Inside Sales AE, Account Manager, Named AE, or Sr. Account Executive at ANY solid tech company (not required to be target industry). These roles have lower competition — you're not competing against 500 applicants.
  LOCATION: Job must be remote OR remote-in-territory matching candidate's target locations.
  SCORE: matchScore≥55, aiRisk≠HIGH, realVsFake≥5.
  INTENT: Realistic wins you can move on quickly. Apply fast, less tailoring, good shot at getting through.

"Stretch Role":
  WHO: The COMBINATION of words in the title matters — do not flag individual words alone:
  - "Strategic" anywhere → always Stretch (it signals a senior, competitive enterprise motion regardless of other words)
  - "Sr." or "Senior" + "Enterprise" in the same title → Stretch (e.g. "Sr. Enterprise AE", "Senior Enterprise Account Executive")
  - "Sr." or "Senior" + a specific competitive niche → Stretch (e.g. "Sr. Account Executive - AI HPC", "Senior AE, Financial Services")
  - "Principal" level → Stretch (above standard Enterprise AE in seniority)
  - Vertical niche specialty anywhere in title → Stretch regardless of level: Financial Services, Banking, Healthcare, Life Sciences, DoD, Government, SLED, Federal, Education
  - Any Enterprise AE role at a hyper-competitive prestige company → Stretch: Databricks, Snowflake, Salesforce, Workday, ServiceNow, Veeva, Palantir, Stripe — even if title is "Enterprise AE"
  NOT Stretch by themselves: "Sr. Account Executive" (generic no enterprise/niche), "Named Account Executive", "Major Account Executive", "Enterprise AE" at non-hyper-competitive company — these are Top Target or Fast Win.
  SCORE: matchScore≥55.
  INTENT: Aspirational — real opportunities but tougher competition, longer cycle, higher bar.

"Probably Skip":
  ANY of: Job is NOT remote and NOT in candidate's target territory (location mismatch → ALWAYS Probably Skip even if company is great); aiRisk=HIGH; realVsFake<5 (ghost/evergreen posting); matchScore<50; wrong role type (SDR, BDR, Solutions Architect, SE, CSM, Customer Success, Marketing, HR, Finance, Legal, Engineering); non-quota-carrying role. Time is better spent elsewhere.`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1200,
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
      opportunityTier?: OpportunityTier;
      tierReasoning?: string;
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
        const tier = parsed.opportunityTier ? ` [${parsed.opportunityTier}]` : '';
        console.log(`  ✗ Rejected (${parsed.matchScore})${riskTag}${tier}: ${job.company} — "${job.title}" — ${parsed.whyGoodFit?.slice(0, 80)}`);
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

    const validTiers: OpportunityTier[] = ['Top Target', 'Fast Win', 'Stretch Role', 'Probably Skip'];
    const tier: OpportunityTier = validTiers.includes(parsed.opportunityTier as OpportunityTier)
      ? (parsed.opportunityTier as OpportunityTier)
      : computeTier(parsed.matchScore, parsed.aiRisk ?? 'unknown', subScores, job.title, job.company, job.location);

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

  // Accessible role types — realistic laterals or one step up for AE background
  const hasCommercial         = /\bcommercial\b/i.test(title);
  const hasMidMarket          = /\b(mid[.\s-]?market|midmarket)\b/i.test(title);
  const hasCorporate          = /\bcorporate\b/i.test(title);
  const hasRegional           = /\b(regional|territory)\b/i.test(title);
  const hasPartner            = /\bpartner\b/i.test(title);
  const hasStandardEnterprise = hasEnterprise && !isAboveLevel;
  const isSeniorOnlyAE        = isSenior && !hasEnterprise;

  const isGenericAE = !isAboveLevel &&
    /\b(account executive|account manager|sales executive|sales manager|sales representative|specialist seller|client executive)\b/i.test(title);

  const isAccessibleRole = hasStandardEnterprise || hasCommercial || hasMidMarket || hasCorporate ||
    hasRegional || hasPartner || isSeniorOnlyAE || isGenericAE;

  // === TIER ASSIGNMENT ===

  // STRETCH: Above the user's experience level (Major/Strategic/Sr.Enterprise/Director counted above unless user is Strategic level)
  if (isAboveLevel && matchScore >= stretchScore && s.realVsFake >= 5) {
    return 'Stretch Role';
  }

  const isQualityCompany = s.companyQuality >= 7;
  const goodRoleFit      = s.roleFit >= 6;

  // TOP TARGET: Right role level + quality AI-safe company + strong fit + strong score
  if (isAccessibleRole && matchScore >= topTargetScore && isQualityCompany && goodRoleFit &&
      aiRisk !== 'HIGH' && s.realVsFake >= 6) {
    return 'Top Target';
  }

  // FAST WIN: More accessible role type with a decent score (lower company quality bar)
  if ((hasCommercial || hasMidMarket || hasCorporate) &&
      matchScore >= fastWinScore && s.realVsFake >= 5 && aiRisk !== 'HIGH') {
    return 'Fast Win';
  }

  // FAST WIN fallback: any accessible role with a solid score
  if (isAccessibleRole && matchScore >= (fastWinScore + 5) && s.realVsFake >= 5 && aiRisk !== 'HIGH') {
    return 'Fast Win';
  }

  // STRETCH fallback: decent score but doesn't hit Top Target / Fast Win criteria
  if (matchScore >= stretchScore && s.realVsFake >= 5) return 'Stretch Role';

  return 'Probably Skip';
}

export async function rescoreJobOpportunity(
  job: { id: number; title: string; company: string; location: string; salary?: string; applyUrl: string; description?: string },
  criteriaText: string,
  preApprovedSection: string,
  preApprovedCompanies: string[]
): Promise<{ opportunityTier: OpportunityTier; subScores: SubScores; aiRisk: string; aiRiskReason: string; whyGoodFit: string; matchScore: number } | null> {
  try {
    const result = await scoreOne(
      { title: job.title, company: job.company, location: job.location, salary: job.salary, applyUrl: job.applyUrl, description: job.description },
      criteriaText, preApprovedSection, preApprovedCompanies
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
    criteria.industries.length ? `Industries: ${criteria.industries.join(', ')}` : '',
    criteria.minSalary ? `Minimum salary: $${criteria.minSalary.toLocaleString()} base` : '',
    criteria.locations.length ? `Locations: ${criteria.locations.join(', ')}` : '',
    (() => {
      const modes: string[] = criteria.allowedWorkModes ?? [];
      const parts: string[] = [];
      if (modes.includes('remote_us')) parts.push('true remote (US-wide, no city restriction)');
      if (modes.includes('remote_in_territory')) parts.push('remote-in-territory (must live near specified city)');
      if (modes.includes('onsite')) parts.push('on-site physical office');
      return parts.length > 0 ? `Accepted work modes: ${parts.join(', ')}` : 'Work modes: any';
    })(),
    criteria.mustHave.length ? `Must have: ${criteria.mustHave.join(', ')}` : '',
    criteria.niceToHave.length ? `Nice to have: ${criteria.niceToHave.join(', ')}` : '',
    criteria.avoid.length ? `Avoid: ${criteria.avoid.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  // Build pre-approved companies section for the prompt
  let preApprovedSection = '';
  if (criteria.preApprovedCompanies && criteria.preApprovedCompanies.length > 0) {
    preApprovedSection = `PRE-APPROVED COMPANIES:
The user has pre-approved these specific companies as target employers. If a job is from ANY of these companies, treat the company as an automatic match — only evaluate whether the ROLE TITLE and RESPONSIBILITIES match the user's target roles. Do not penalize or lower the score because of the industry or product type — the user has already decided these companies are good targets.
Pre-approved companies: ${criteria.preApprovedCompanies.join(', ')}
For jobs NOT from the pre-approved list, apply normal scoring criteria.`;
  }

  const CONCURRENCY = 10;
  const results: JobMatch[] = [];

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    console.log(`Scoring batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(jobs.length / CONCURRENCY)} (${batch.length} jobs)...`);
    const batchResults = await Promise.all(batch.map((j) => scoreOne(j, criteriaText, preApprovedSection, criteria.preApprovedCompanies ?? [])));
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

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "resume": "<the full tailored resume text, formatted with clear sections>",
  "coverLetter": "<the full cover letter>"
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
