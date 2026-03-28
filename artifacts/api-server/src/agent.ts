import Anthropic from '@anthropic-ai/sdk';
import type { ScrapedJob } from './scraper.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
  ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL }
    : {}),
});

export interface SubScores {
  roleFit: number;           // 0-10: role title/level vs target roles
  companyQuality: number;    // 0-10: company reputation, growth, prestige
  locationFit: number;       // 0-10: remote/hybrid/location match
  hiringUrgency: number;     // 0-10: active hiring signals vs stale evergreen
  tailoringRequired: number; // 0-10: 10=minimal tailoring, 0=major overhaul needed
  referralOdds: number;      // 0-10: likelihood of finding a warm referral
  realVsFake: number;        // 0-10: confidence this is a genuine open role
  qualificationFit: number;  // 0-10: how well candidate's actual background matches JD requirements
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
): Promise<JobMatch | null> {
  try {
    const isPreApproved = preApprovedCompanies.some(
      (name) => name.toLowerCase() === job.company.toLowerCase()
    );
    let companySpecificSection = preApprovedSection;
    if (isPreApproved) {
      companySpecificSection += `\n\nNOTE: ${job.company} is on the user's pre-approved companies list. The user has already decided this company is a target employer. Score at least 65 if the role title meaningfully matches any of the user's target roles. Only score below 65 if the role type is completely wrong (e.g. engineering, marketing, HR, finance, legal) or the location is outside the user's preferences.`;
    }

    // Build salary constraint text
    const salaryParts: string[] = [];
    if (minSalary) {
      salaryParts.push(`Minimum BASE salary: $${minSalary.toLocaleString()}. If the listing shows a base salary AND the highest figure is below this: set matchScore=0, isMatch=false.`);
    }
    if (minOte) {
      salaryParts.push(`Minimum OTE (On-Target Earnings / total comp): $${minOte.toLocaleString()}. OTE is the total package including base + variable/commission when at 100% quota. If the listing shows an OTE AND the highest figure is below this: set matchScore=0, isMatch=false.`);
    }
    const salaryRule = salaryParts.length > 0
      ? `COMPENSATION REQUIREMENTS (hard gates):\n${salaryParts.join('\n')}\nIf no salary is listed: do not penalize — mention the unknown compensation in whyGoodFit.`
      : '';

    // Candidate background section
    const resumeSection = candidateResume
      ? `═══════════════════════════════════════════════════
CANDIDATE BACKGROUND (from uploaded resume)
═══════════════════════════════════════════════════
Read this to understand who the candidate actually IS — their real experience, past titles, industries sold into, methodologies used, deal sizes, and achievements. Use this to evaluate whether they are genuinely qualified for the role.

${candidateResume.slice(0, 2500)}
`
      : '';

    const prompt = `You are a world-class career strategist and executive recruiter who evaluates job-candidate fit with surgical precision. You understand the nuances of enterprise sales roles deeply: the difference between hunters and farmers, the difference between SMB/Commercial/Mid-Market/Enterprise/Strategic levels, industry vertical specialists vs generalists, and what methodologies like MEDDPICC, Challenger, or Command of the Message signal about a candidate.

Your job: evaluate how well THIS job matches THIS specific candidate — based on their actual background (resume) AND their stated preferences.

${resumeSection}
═══════════════════════════════════════════════════
CANDIDATE PREFERENCES & CRITERIA
═══════════════════════════════════════════════════
${criteriaText}

${salaryRule}

═══════════════════════════════════════════════════
JOB TO EVALUATE
═══════════════════════════════════════════════════
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Description:\n${job.description.slice(0, 1500)}` : '(No description available)'}

${companySpecificSection}

═══════════════════════════════════════════════════
SCORING INSTRUCTIONS
═══════════════════════════════════════════════════
Score based on BOTH the candidate's preferences AND their actual qualifications from the resume.

1. matchScore (0-100): Overall fit score combining preferences + actual qualification.
   - Start at 50. Adjust up/down:
   - Role title matches target roles: +/-25 (biggest factor)
   - Candidate is actually qualified based on resume: +/-20 (second biggest factor)
   - Location/remote match: +/-15
   - Compensation meets requirements (if known): hard gate
   - Must-have requirements met: +/-8 each
   - Avoid keywords present: -25 each (likely disqualifier)
   - Company quality/fit with candidate's industry background: +/-10
   - AI displacement risk: LOW=no penalty, MEDIUM=-5, HIGH=-20

2. isMatch: true if matchScore >= 60, otherwise false.

3. isHardware: true if the company sells physical hardware, semiconductors, networking equipment, industrial machinery, or data center infrastructure products.

4. aiRisk — how easily could AI replace this company's core product?
   - LOW: Physical hardware, semiconductors, networking gear, storage, servers, industrial/defense tech, robotics — physical supply chains AI cannot replicate.
   - MEDIUM: Complex vertical SaaS with deep integrations, proprietary data moats, specialized industry software, ERP.
   - HIGH: Generic horizontal SaaS — workflow tools, basic project management, email productivity, simple analytics, form builders.

5. subScores (each 0-10):
   - roleFit: Does the title/responsibilities precisely match the candidate's target roles AND their experience level? 10=exact title+level match, 5=partial, 0=wrong type.
   - companyQuality: Company reputation, financial health, growth stage. 10=elite/public/unicorn, 5=solid mid-market, 2=tiny unknown.
   - locationFit: Remote/location match against candidate preferences. 10=perfect, 0=wrong region, no remote.
   - hiringUrgency: Signs of real active hiring vs evergreen pipeline posting. 10=specific team context, 0=generic template.
   - tailoringRequired: 10=candidate's background is a natural fit (minimal resume work), 0=significant gap (major tailoring needed).
   - referralOdds: Likelihood of finding a warm referral. 10=large well-known company, 0=tiny obscure startup.
   - realVsFake: Confidence this is a genuine currently-open role. 10=specific unique JD, 0=generic evergreen template.
   - qualificationFit: How well does the candidate's ACTUAL background from the resume match what this JD requires? Consider: industry experience, past title level, deal sizes, methodologies, product types sold. 10=highly qualified (has done this exact work before), 5=transferable skills with some gap, 0=significant qualification mismatch.

LOCATION NOTE: "Remote" alone = work from anywhere. "Remote, [City]" means must live near that city. Score locationFit 2-4 if city doesn't match candidate's locations.

═══════════════════════════════════════════════════
REQUIRED OUTPUT — JSON ONLY, NO MARKDOWN
═══════════════════════════════════════════════════
{
  "matchScore": <0-100 integer>,
  "whyGoodFit": "<2-3 sentences that SPECIFICALLY reference the candidate's background and why this role does or doesn't fit — mention their past titles, industries, or specific experience. Not generic statements.>",
  "isMatch": <true if matchScore >= 60, else false>,
  "isHardware": <true | false>,
  "aiRisk": <"LOW" | "MEDIUM" | "HIGH">,
  "aiRiskReason": "<one sentence on AI displacement risk for this company's product>",
  "subScores": {
    "roleFit": <0-10>,
    "companyQuality": <0-10>,
    "locationFit": <0-10>,
    "hiringUrgency": <0-10>,
    "tailoringRequired": <0-10>,
    "referralOdds": <0-10>,
    "realVsFake": <0-10>,
    "qualificationFit": <0-10>
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
        qualificationFit?: number;
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
      roleFit:            Math.min(10, Math.max(0, parsed.subScores?.roleFit ?? 5)),
      companyQuality:     Math.min(10, Math.max(0, parsed.subScores?.companyQuality ?? 5)),
      locationFit:        Math.min(10, Math.max(0, parsed.subScores?.locationFit ?? 5)),
      hiringUrgency:      Math.min(10, Math.max(0, parsed.subScores?.hiringUrgency ?? 5)),
      tailoringRequired:  Math.min(10, Math.max(0, parsed.subScores?.tailoringRequired ?? 5)),
      referralOdds:       Math.min(10, Math.max(0, parsed.subScores?.referralOdds ?? 5)),
      realVsFake:         Math.min(10, Math.max(0, parsed.subScores?.realVsFake ?? 5)),
      qualificationFit:   Math.min(10, Math.max(0, parsed.subScores?.qualificationFit ?? 5)),
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

  const isQualityCompany  = s.companyQuality >= 7;
  const goodRoleFit       = s.roleFit >= 6;
  // qualificationFit is a new field — legacy jobs (scored before this feature) have it undefined.
  // When undefined, do NOT apply any qualification gates so existing jobs are never downgraded.
  const qualFitRaw      = s.qualificationFit;
  const qualFitKnown    = qualFitRaw !== undefined && qualFitRaw !== null;
  const qualFit         = qualFitRaw ?? 7; // treat legacy as "well qualified" — no penalty
  const strongQualFit   = !qualFitKnown || qualFit >= 7;
  const weakQualFit     = qualFitKnown && qualFit < 4;

  // Hard downgrade: candidate is significantly underqualified (only applied when score is known)
  if (weakQualFit && matchScore < topTargetScore) return 'Probably Skip';

  // TOP TARGET: Accessible role + high score + quality company + strong role fit
  // qualificationFit gate is only applied when the score was actually computed
  if (isAccessibleRole && matchScore >= topTargetScore && isQualityCompany && goodRoleFit &&
      s.realVsFake >= 6 && (strongQualFit || qualFit >= 6)) {
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
  candidateResume?: string,
  minOte?: number | null,
): Promise<{ opportunityTier: OpportunityTier; subScores: SubScores; aiRisk: string; aiRiskReason: string; whyGoodFit: string; matchScore: number } | null> {
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
      batch.map((j) => scoreOne(
        j, criteriaText, preApprovedSection,
        criteria.preApprovedCompanies ?? [],
        criteria.tierSettings,
        criteria.minSalary,
        criteria.candidateResume,
        criteria.minOte,
      ))
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
  options?: { targetPages?: 1 | 2 }
): Promise<{ resume: string; coverLetter: string; suggestedEdits?: string; analysis?: TailoringAnalysis }> {

  // Estimate base resume word count to calibrate page target
  const baseWordCount = baseResume.trim().split(/\s+/).length;
  const targetPages = options?.targetPages ?? (baseWordCount > 600 ? 2 : 1);
  const wordMin = targetPages === 1 ? 480 : 850;
  const wordMax = targetPages === 1 ? 680 : 1150;

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

PHASE 4 — PAGE LENGTH DISCIPLINE:
The resume MUST fit the target page count. This is non-negotiable.
- 1-page target: ${wordMin}-${wordMax} words in the body. Cut ruthlessly — one role gets 2-3 bullets max, older roles may be collapsed.
- 2-page target: ${wordMin}-${wordMax} words. Expand bullets with context and achievements.
Count your words before finalizing. If over limit, edit down. If under, enrich.

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
CANDIDATE BASE RESUME (~${baseWordCount} words)
═══════════════════════════════
${baseResume}

═══════════════════════════════
TARGET
═══════════════════════════════
Page count: ${targetPages} page${targetPages > 1 ? 's' : ''} (${wordMin}–${wordMax} words in resume body)

Respond ONLY with a valid JSON object — no markdown fences, no text outside the JSON:
{
  "analysis": {
    "targetPageCount": ${targetPages},
    "wordTarget": "${wordMin}–${wordMax}",
    "requiredSkills": ["exact phrase from JD", "...up to 10"],
    "preferredSkills": ["...", "...up to 6"],
    "methodologies": ["MEDDPICC", "...any found"],
    "keySignals": ["Enterprise hunter", "...3-5 nuance signals you detected"],
    "keywordsPlaced": ["list every JD keyword you successfully wove into the resume"],
    "pageEstimate": "~X words → fits Y page(s)"
  },
  "resume": "# Full Name\\n\\n## Summary\\n[2-3 sentence power summary mirroring JD language]\\n\\n## Experience\\n**Job Title** — **Company Name** | Location | Dates\\n- [Strong verb] + [achievement] + [metric]\\n...\\n\\n## Key Skills\\n[JD-matched skills first, comma-separated]\\n\\n## Education\\n...",
  "coverLetter": "# Cover Letter\\n\\n[Recipient info]\\n\\n[Opening hook — reference company by name and why this role specifically]\\n\\n[Body — connect 2-3 specific achievements to the role's requirements using JD language]\\n\\n[Closing — confident call to action]\\n\\n[Sign-off]",
  "suggestedEdits": "## Suggested Edits for Your Resume\\n\\nMake these targeted changes directly in your original document — no full rewrite needed. Only reframe existing facts; never add anything that isn't true.\\n\\n### Skills / Summary Section\\n- **Add keyword**: [exact JD term] — appears as required in the JD\\n- **Move to top**: [skill] — JD lists this as a primary requirement\\n- **Remove or demote**: [unrelated skill] — not mentioned in JD, wastes prime real estate\\n\\n### [Company Name] ([start]–[end])\\n- **Bullet 1** — Change: \\"[current wording]\\" → \\"[improved wording with metric + JD keyword]\\"\\n  _Why: JD requires [specific signal]; adding [metric] proves impact_\\n- **Add**: One bullet about [topic] using language like \\"[JD-mirrored phrase]\\" — JD specifically calls this out\\n\\n### [Next Company / Role]\\n- **Bullet X** — Change: \\"[current]\\" → \\"[improved]\\"\\n  _Why: [reason]_\\n\\n> **Note**: If you have exact numbers (quota %, deal sizes, headcount), slot them in where shown as placeholders — your actual figures will be stronger than estimates."
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
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
