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

export async function generateCoverLetterWithClaude(params: {
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  resumeText: string;
  userName: string;
  existingResearch?: string | null;
  temperature?: number;
}): Promise<CoverLetterResult> {
  const { jobTitle, companyName, jobDescription, resumeText, userName, existingResearch } = params;
  const temperature = params.temperature ?? 1;

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
      model: 'claude-sonnet-4-5',
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
    ? `RECENT COMPANY RESEARCH (use at least 2 of these specific facts naturally in the letter):\n${research.specificFacts.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nCOMPANY MOMENT (work this into the opening or closing):\n${research.companyMoment}\n\nROLE CONTEXT (what problem am I being hired to solve):\n${research.roleContext}`
    : `Note: Live research was unavailable. Use the job description and resume to craft the most compelling letter possible.`;

  const systemPrompt = `You are an expert cover letter writer who has helped hundreds of enterprise technology sales professionals land roles at top hardware, semiconductor, AI infrastructure, and industrial technology companies. You write cover letters that sound completely human — like they were written by a confident, articulate sales professional who knows exactly what they want and why they are the right person for this role.

CRITICAL RULES FOR HUMAN-SOUNDING WRITING:
- Never use em dashes (—) or en dashes (–) anywhere in the letter
- Never use the word "leverage" or "leveraging"
- Never use the word "passionate" or "passionate about"
- Never use the phrase "I am excited to" or "I am thrilled to"
- Never use the word "synergy" or "synergistic"
- Never use the word "utilize" — use "use" instead
- Never use "in terms of"
- Never use bullet points or lists — this is prose only
- Vary sentence length naturally — mix short punchy sentences with longer ones
- Write in first person with confidence, not humility
- Never start consecutive sentences with "I"
- Never use corporate buzzwords like "thought leader", "best-in-class", "cutting-edge"
- The letter should sound like it was written by a real person who is genuinely interested but not sycophantic
- Maximum 4 paragraphs, each focused and tight
- Total length: 250-350 words maximum — hiring managers do not read long cover letters
- The letter must never mention Claude, AI, or that it was generated`;

  const userPrompt = `Write a cover letter for this application. Here is all the context you need:

ROLE: ${jobTitle} at ${companyName}

JOB DESCRIPTION:
${jobDescription.slice(0, 1500)}

MY RESUME:
${resumeText.slice(0, 2000)}

MY NAME: ${userName || 'The Candidate'}

${factsBlock}

INSTRUCTIONS:
Paragraph 1 — Opening: Reference something specific and recent about the company that shows genuine research. Connect it to why this role at this company matters right now. Do NOT open with "I am applying for" — start with the company insight.

Paragraph 2 — My fit: Pull 2-3 specific, quantified achievements from my resume that directly map to what this role requires. Be concrete — numbers, company names, outcomes. Do not be generic.

Paragraph 3 — Why this company specifically: Show that you understand their market position, what they are building, and why my specific experience makes me valuable to them at this exact moment. Reference the company moment if research is available.

Paragraph 4 — Close: Confident, direct, brief. Express genuine interest without begging. End with a specific call to action.

Write the full cover letter now. Return ONLY the cover letter text — no subject line, no preamble, no explanation. Start directly with the first paragraph.`;

  const genMsg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const letterText = genMsg.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text as string)
    .join('\n')
    .trim();

  return { coverLetter: letterText, research, researchFailed };
}
