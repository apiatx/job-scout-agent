/**
 * company_classifier.ts
 *
 * Shared deterministic classification layer for jobs and companies.
 * Applied to ALL search sources (JobSpy, ATS scraping, Perplexity) via the
 * shared runScoutInBackground pipeline — NOT a Quick-Search-only feature.
 *
 * Two classification dimensions:
 *   CompanyType     — is this a real employer or noise (staffing/agency/job_board)?
 *   IndustryCategory — what industry segment does this company operate in?
 *
 * Rules are purely deterministic (keyword + pattern matching).
 * Claude is NOT called here — this runs as a cheap pre-filter before Claude scoring.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CompanyType =
  | 'direct_employer'
  | 'staffing_recruiting'
  | 'agency_services'
  | 'healthcare_provider'
  | 'job_board'
  | 'unknown';

export type IndustryCategory =
  | 'ai_infrastructure'
  | 'semiconductors'
  | 'photonics_optics'
  | 'electronic_components'
  | 'servers_data_center'
  | 'networking'
  | 'database'
  | 'infrastructure_security'
  | 'generic_saas'
  | 'staffing_recruiting'
  | 'healthcare'
  | 'other'
  | 'unknown';

export interface JobClassification {
  companyType: CompanyType;
  industryCategory: IndustryCategory;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
}

// ── Company-type patterns ─────────────────────────────────────────────────────

const KNOWN_STAFFING_NAMES = new Set([
  'lavendo', 'kforce', 'kforce tech', 'randstad', 'adecco', 'manpower',
  'staffmark', 'insight global', 'robert half', 'heidrick', 'heidrick & struggles',
  'spencer stuart', 'michael page', 'teksystems', 'tek systems', 'cybercoders',
  'hired', 'toptal', 'turing', 'andela', 'triplebyte', 'crossover',
  'acceleration partners', 'talentify', 'direct recruiters', 'talent inc',
  'revitalized recruiters', 'high alpha innovation', 'job mobz',
]);

const STAFFING_NAME_PATTERNS = [
  /\bstaffing\b/i,
  /\brecruiting(?!\s+software|\s+platform|\s+crm|\s+tool|\s+product)\b/i,
  /\brecruitment(?!\s+software|\s+platform|\s+crm|\s+tool)\b/i,
  /\bheadhunter(s|ing)?\b/i,
  /\bexecutive\s+search\b/i,
  /\btalent\s+(solutions|group|partners|inc|llc|acquisition\s+firm)\b/i,
  /\bplacement\s+(firm|group|services|agency)\b/i,
  /\bsearch\s+(group|firm|partners|associates)\b/i,
  /\bhr\s+(solutions|partners|consulting|services)\b/i,
  /\bworkforce\s+(solutions|services|management\s+group)\b/i,
  /\bprofessional\s+services\s+firm\b/i,
  /\bcontract\s+staffing\b/i,
];

const KNOWN_JOB_BOARDS = new Set([
  'indeed', 'linkedin', 'ziprecruiter', 'glassdoor', 'monster',
  'careerbuilder', 'dice', 'simplyhired', 'handshake', 'snagajob',
  'idealist', 'wayup', 'after college', 'internships.com',
]);

const HEALTHCARE_PROVIDER_PATTERNS = [
  /\bhospital\b/i,
  /\bhealth\s+system\b/i,
  /\bmedical\s+center\b/i,
  /\bclinic(s|al\s+center)?\b/i,
  /\bnursing\s+(home|facility|center)\b/i,
  /\bphysician\s+(group|practice|partners)\b/i,
  /\bhealthcare\s+(system|network|group|provider)\b/i,
  /\bmd\s+anderson\b/i,
  /\bmemorial\s+health(care)?\b/i,
  /\bchildren['s]*\s+hospital\b/i,
  /\buniversity\s+hospital\b/i,
  /\bregional\s+medical\s+center\b/i,
];

function classifyCompanyType(companyName: string, urlSlug = ''): { type: CompanyType; confidence: 'high' | 'medium' | 'low'; signal: string } {
  const lower = companyName.toLowerCase().trim();
  const slug  = urlSlug.toLowerCase().replace(/[^a-z0-9]/g, '');

  // ── Job board ──────────────────────────────────────────────────────────────
  if (KNOWN_JOB_BOARDS.has(lower) || KNOWN_JOB_BOARDS.has(slug)) {
    return { type: 'job_board', confidence: 'high', signal: `known_job_board:${lower}` };
  }

  // ── Staffing / recruiting ──────────────────────────────────────────────────
  if (KNOWN_STAFFING_NAMES.has(lower) || KNOWN_STAFFING_NAMES.has(slug)) {
    return { type: 'staffing_recruiting', confidence: 'high', signal: `known_staffing:${lower}` };
  }
  for (const p of STAFFING_NAME_PATTERNS) {
    if (p.test(companyName)) {
      return { type: 'staffing_recruiting', confidence: 'medium', signal: `staffing_pattern:${p.source}` };
    }
  }

  // ── Healthcare provider ────────────────────────────────────────────────────
  for (const p of HEALTHCARE_PROVIDER_PATTERNS) {
    if (p.test(companyName)) {
      return { type: 'healthcare_provider', confidence: 'medium', signal: `healthcare_pattern:${p.source}` };
    }
  }

  return { type: 'unknown', confidence: 'low', signal: 'no_match' };
}

// ── Industry signal maps ──────────────────────────────────────────────────────

interface IndustrySignals {
  namePatterns:   RegExp[];
  titlePatterns:  RegExp[];
  descPatterns:   RegExp[];
  negativeNames?: RegExp[];
}

const INDUSTRY_SIGNAL_MAP: Partial<Record<IndustryCategory, IndustrySignals>> = {

  ai_infrastructure: {
    namePatterns: [
      /\b(akash(network)?|centml|groq|cerebras|lambda\s+labs?|together\s+ai|replicate|modal(\s+labs?)?|runpod|coreweave|voltage\s+park|octoai|fireworks(\s+ai)?|baseten|anyscale|inflection(\s+ai)?|mistral(\s+ai)?|cohere|scale\s+ai|hugging\s+face|wandb|weights[\s&]+biases|determined\s+ai|cudo\s+compute|vast\.ai|gpu\.net|paperspace|gradient|phoenix\s+nap|hyperstack|imbue|stability\s+ai)\b/i,
    ],
    titlePatterns: [
      /\b(gpu\s+cloud|ai\s+accelerator|ai\s+cloud|ml\s+infrastructure|inference\s+(platform|cluster|cloud)|model\s+serving|ai\s+platform|llm\s+(platform|training|inference)|foundation\s+model)\b/i,
    ],
    descPatterns: [
      /\b(gpu\s+(cloud|compute|cluster|training)|ai\s+accelerator|nvidia\s+(h100|a100|gpu)|cuda|inference\s+(cluster|infrastructure|workload)|training\s+(cluster|workload)|llm\s+(training|inference)|foundation\s+model|ai\s+(workload|compute))\b/i,
    ],
  },

  semiconductors: {
    namePatterns: [
      /\b(intel|amd|nvidia|broadcom|qualcomm|marvell|arm(\s+holdings?)?|ampere(\s+computing)?|tenstorrent|sifive|esperanto\s+technologies|rivos|d-matrix|untether\s+ai|lightmatter|ayar\s+labs|openlight\s+photonics|litrinium|luminous\s+computing|asml|lam\s+research|applied\s+materials|kla(\s+corp)?|ipg\s+photonics|ii-vi|iivi|qorvo|skyworks|analog\s+devices|maxim\s+integrated|texas\s+instruments|microchip\s+technology|lattice\s+semiconductor|cirrus\s+logic|semtech|indie\s+semiconductor|sitime|enpirion|wolfson|dialog\s+semiconductor|nxp|infineon|st\s+microelectronics|renesas|onsemi|on\s+semiconductor|silicon\s+labs|maxlinear|rambus)\b/i,
    ],
    titlePatterns: [
      /\b(semiconductor|chip\s+(design|sales|market)|asic|fpga|silicon|wafer|integrated\s+circuit|soc(\s+design)?|eda\s+tools?|ip\s+cores?)\b/i,
    ],
    descPatterns: [
      /\b(semiconductor|asic\s+(design|development)|fpga|(silicon|chip)\s+(design|photonics|manufacturing)|wafer|tape-?out|integrated\s+circuit|soc\s+(architecture|design)|eda\s+tools?|design\s+ip)\b/i,
    ],
  },

  photonics_optics: {
    namePatterns: [
      /\b(lumentum|viavi(\s+solutions)?|finisar|acacia(\s+communications)?|ciena|infinera|coherent(\s+corp)?|nlight|ipg\s+photonics|ayar\s+labs|lightmatter|openlight|inphi|ixblue|luna\s+innovations|nanoplus|ii-vi|iivi|macom|trumpf|jenoptik|thorlabs|edmund\s+optics|ocean\s+optics|ocean\s+insight|rofin|coherix|ii\s+vi|finisar|jdsu|oplink|fabrinet)\b/i,
    ],
    titlePatterns: [
      /\b(photonics|optics|optical\s+(transceiver|interconnect|networking|systems|components)|fiber\s+optic|lidar|optoelectronics|laser\s+(systems?|diode|technology)|dwdm|coherent\s+optics|wavelength)\b/i,
    ],
    descPatterns: [
      /\b(photonics|optical\s+(transceiver|interconnect|networking|switch|module|amplifier|components?)|fiber\s+optic\s+(network|cable|components?)|lidar(\s+system)?|optoelectronics|coherent\s+optics|dwdm|wavelength\s+(division|routing)|photonic\s+(integrated\s+circuit|chip|device))\b/i,
    ],
  },

  electronic_components: {
    namePatterns: [
      /\b(molex|amphenol|te\s+connectivity|vishay|keysight|national\s+instruments|rohde\s+&\s+schwarz|murata|tdk|yageo|bourns|bel\s+fuse|littelfuse|panasonic\s+(electronic|industrial)|epson|kyocera|kyocera\s+avx|avx|ttm\s+technologies|isola|rogers\s+corp|park\s+electrochemical|moog|curtiss-wright|heico|esterline)\b/i,
    ],
    titlePatterns: [
      /\b(electronic\s+components?|sensors?\s+(division|business)|embedded\s+systems?|iot\s+(solutions?|platform)|pcb|circuit\s+board|ems\s+(provider|manufacturer)|contract\s+manufacturing)\b/i,
    ],
    descPatterns: [
      /\b(electronic\s+components?|sensors?\s+(hardware|devices?)|embedded\s+(systems?|software|linux)|iot\s+(devices?|platform|hardware)|printed\s+circuit\s+board|pcb\s+(design|manufacturing)|surface\s+mount|contract\s+electronics?\s+manufacturing)\b/i,
    ],
  },

  servers_data_center: {
    namePatterns: [
      /\b(supermicro|super\s+micro|dell\s+(emc|technologies)|hpe|hewlett\s+packard\s+enterprise|lenovo\s+(dcg|data\s+center)|quanta\s+(cloud|computer)|wiwynn|gigabyte\s+server|asus\s+(server|asmb)|pure\s+storage|netapp|cohesity|commvault|veeam|nutanix|zerto|druva|rubrik|scality|vast\s+data|hammerspace|qumulo|cloudian|seagate\s+(exos|lyve)|western\s+digital\s+data\s+center|backblaze|nerdio|weka|penguin\s+solutions|cray|sgimips|dataon|45drives)\b/i,
    ],
    titlePatterns: [
      /\b(data\s+center\s+(infrastructure|solutions?|sales?)|server\s+(hardware|infrastructure|solutions?)|colocation|bare\s+metal|hpc\s+(solutions?|cluster)|hyperscaler|compute\s+(cluster|infrastructure)|storage\s+systems?)\b/i,
    ],
    descPatterns: [
      /\b(data\s+center\s+(infrastructure|solutions?|design)|rack\s+server|colocation\s+(services?|provider|facility)|bare\s+metal\s+(cloud|computing)|hyperscaler\s+(partnership|qualification)|compute\s+(cluster|infrastructure)|storage\s+(hardware|infrastructure|systems?)|server\s+(hardware|procurement|lifecycle))\b/i,
    ],
  },

  networking: {
    namePatterns: [
      /\b(cisco|juniper\s+(networks?)?|arista\s+(networks?)?|palo\s+alto\s+networks?|fortinet|extreme\s+networks?|calix|ciena|ribbon\s+communications?|lumen\s+(technologies?)?|commscope|corning\s+(optical|cable)|netscout|spirent|keysight\s+network|sycamore\s+networks?|cradlepoint|cato\s+networks?|versa\s+networks?|aryaka|cloudflare|fastly|akamai|zscaler|netskope|illumio|f5(\s+networks?)?|a10\s+networks?|radware|barracuda|sonicwall|watchguard|aerohive|ruckus|ubiquiti|cambium\s+networks?|siklu|mimosa|dejima|viptela|silverpeak|talari|velocloud)\b/i,
    ],
    titlePatterns: [
      /\b(networking\s+(infrastructure|solutions?|equipment)|sd-wan|network\s+(fabric|security|monitoring|operations?|infrastructure)|routing\s+(hardware|protocols?)|switching\s+(fabric|hardware)|mpls|firewall\s+(platform|solutions?)|nfv|sdn(\s+platform)?|sase|sse)\b/i,
    ],
    descPatterns: [
      /\b(networking\s+(hardware|infrastructure|equipment|solutions?)|sd-wan\s+(solution|platform|vendor)|routing(\s+protocols?|\s+hardware)?|switching\s+(fabric|hardware|infrastructure)|mpls\s+(network|routing)|network\s+(security|fabric|monitoring|operations?)|firewall\s+(policy|platform)|nfv\s+(orchestration)?|sdn(\s+controller|\s+fabric)?)\b/i,
    ],
  },

  database: {
    namePatterns: [
      /\b(mongodb|snowflake|databricks|cockroach\s+labs?|planetscale|singlestore|couchbase|clickhouse|neon(\s+db)?|supabase|timescaledb|yugabyte|arangodb|neo4j|tigergraph|redis(\s+labs?)?|aerospike|scylladb|cassandra|mariadb|percona|vitess|tidb|pingcap|starburst|dremio|imply|rockset|materialize|firebolt|turso|xata|edgedb|surrealdb|fauna|convex|upstash|momento|dynatrace\s+db|influxdb|influx\s+data|questdb|kdb|cratedb)\b/i,
    ],
    titlePatterns: [
      /\b(database\s+(infrastructure|platform|solutions?|products?)|data\s+(warehouse|platform|lake\s+house?|infrastructure)|distributed\s+(database|systems?)|object\s+storage\s+(solutions?|platform)|olap\s+(engine|platform)|vector\s+(database|db|search))\b/i,
    ],
    descPatterns: [
      /\b(database\s+(infrastructure|platform|management|technology)|data\s+(warehouse|platform|lakehouse)|distributed\s+(database|data\s+store|systems?)|olap\s+(engine|workload|query)|object\s+storage\s+(platform|api)|time.?series\s+database|vector\s+(database|db|embeddings?\s+search))\b/i,
    ],
  },

  infrastructure_security: {
    namePatterns: [
      /\b(crowdstrike|sentinelone|wiz(\s+cloud)?|orca\s+security|lacework|darktrace|illumio|zscaler|netskope|vectra(\s+ai)?|axonius|tenable|qualys|rapid7|snyk|aqua\s+security|sysdig|cybereason|cyberark|sailpoint|delinea|telos|netsurion|secureworks|trustwave|exabeam|sumo\s+logic|logrhythm|securonix|devo(\s+technology)?|gurucul|varonis|forcepoint|proofpoint|mimecast|abnormal\s+security|ironscales|cofense|tessian|valimail|agari|red\s+canary|expel|arctic\s+wolf|huntress|blumira|detectify|intigriti|bugcrowd|hackerone|synack|cobalt\s+io|pentest(\s+tools?)?|threatlocker|xcitium|comodo|malwarebytes|webroot|sophos|bitdefender|eset|kaspersky|trend\s+micro|checkpoint|trellix|broadcom\s+security)\b/i,
    ],
    titlePatterns: [
      /\b(infrastructure\s+security|zero\s+trust\s+(network|architecture|platform|security)|cloud\s+security\s+(platform|posture|solutions?)|network\s+security\s+(solutions?|platform)|endpoint\s+(security|protection|detection)|siem\s+(platform|solution)|soar\s+(platform|solution)|sase\s+(platform|solution)|sse\s+platform|cnapp|cspm|cwpp|cdr|ciem|itdr|xdr\s+platform|edr\s+solution)\b/i,
    ],
    descPatterns: [
      /\b(zero\s+trust\s+(network|architecture|access)|cloud\s+(security\s+posture|workload\s+protection|infrastructure\s+entitlement)|network\s+security\s+(fabric|platform|monitoring)|endpoint\s+(security|detection\s+and\s+response|edr)|siem\s+(platform|analytics)|soar\s+(orchestration|automation)|sase\s+architecture|sse\s+platform|cnapp|cspm|cwpp|xdr\s+platform|identity\s+(threat|security)\s+(detection|posture))\b/i,
    ],
  },

  generic_saas: {
    namePatterns: [
      /\b(salesforce|hubspot|zendesk|freshworks|intercom|stripe|twilio|sendgrid|mailchimp|marketo|pardot|eloqua|gainsight|totango|churnzero|mixpanel|amplitude|segment|braze|iterable|klaviyo|attentive|yotpo|gorgias|dixa|kustomer|zoho|pipedrive|close\.io|outreach|salesloft|gong|chorus|clari|drift|qualified|6sense|demandbase|bombora|leadiq|apollo\.io|lusha|zoominfo|stackadapt|adroll|criteo|the\s+trade\s+desk|adobe\s+(marketing|experience)|workfront|asana|notion|clickup|monday\.com|airtable|smartsheet|coda|height\s+(app)?|shortcut|basecamp|trello|miro|figma|canva|loom|dovetail|productboard|pendo|fullstory|heap|hotjar|logrocket|datadog|new\s+relic|dynatrace|appdynamics|splunk|elastic|grafana|hashicorp|postman|insomnia|atlassian|linear\.app|auditboard|soc2|workiva|vanta|drata|lacework|tugboat\s+logic|hyperproof|zingtree|servicetitan|jobber|housecall\s+pro|mindbody|squarespace|wix|webflow|shopify|bigcommerce|magento|netsuite|sage\s+intacct|coupa|tipalti|bill\.com|expensify|concur|brex|ramp|bench|gusto|rippling|bamboohr|lattice|culture\s+amp|leapsome|15five|engagedly|reflektive|workday(\s+hcm)?|successfactors|cornerstone\s+ondemand|saba|docebo|absorb|bridge|lessonly|seismic|highspot|mindtickle|showpad|bigtincan)\b/i,
    ],
    descPatterns: [
      /\b(saas\s+(platform|company|product|startup|application|solution|tool)|cloud\s+software\s+(company|platform|provider)|workflow\s+automation\s+platform|crm\s+(platform|system)|marketing\s+automation\s+(platform|tool)|customer\s+success\s+(platform|software)|sales\s+(engagement|enablement)\s+platform|revenue\s+operations\s+(platform|tool)|ad\s+tech|adtech\s+platform|martech\s+(stack|platform|company)|hr\s+tech|hrtech\s+platform|legal\s+tech|legaltech|proptech|insurtech)\b/i,
    ],
    titlePatterns: [],
    negativeNames: [
      /\b(infrastructure|semiconductor|photonics|optical|networking|data\s+center|gpu|ai\s+(accelerator|chip|infrastructure)|security\s+(platform|infrastructure))\b/i,
    ],
  },

};

// ── Core classification function ──────────────────────────────────────────────

export function classifyJob(job: {
  title:       string;
  company:     string;
  description?: string;
  applyUrl?:   string;
}): JobClassification {
  const { title = '', company = '', description = '', applyUrl = '' } = job;
  const signals: string[] = [];

  // Extract URL slug for company-type matching
  let urlSlug = '';
  try {
    const u = new URL(applyUrl);
    urlSlug = u.pathname.split('/').filter(Boolean)[0] ?? '';
  } catch { /* ignore */ }

  // ── Step 1: Company type ───────────────────────────────────────────────────
  const { type: companyType, confidence: typeConf, signal: typeSignal } = classifyCompanyType(company, urlSlug);
  if (typeSignal !== 'no_match') signals.push(typeSignal);

  // ── Step 2: Industry category ──────────────────────────────────────────────
  let industryCategory: IndustryCategory = 'unknown';
  let industryConfidence: 'high' | 'medium' | 'low' = 'low';
  const text = `${company} ${title} ${description}`.toLowerCase();

  // Score each category against all three signal sources
  const scores: Partial<Record<IndustryCategory, number>> = {};

  for (const [cat, signals_] of Object.entries(INDUSTRY_SIGNAL_MAP) as [IndustryCategory, IndustrySignals][]) {
    if (!signals_) continue;
    let score = 0;

    for (const p of signals_.namePatterns ?? []) {
      if (p.test(company)) { score += 3; signals.push(`name:${cat}`); break; }
    }
    for (const p of signals_.titlePatterns ?? []) {
      if (p.test(title)) { score += 2; signals.push(`title:${cat}`); break; }
    }
    for (const p of signals_.descPatterns ?? []) {
      if (p.test(description ?? '')) { score += 1; signals.push(`desc:${cat}`); break; }
    }

    // Negative signals for generic_saas: don't label infra companies as SaaS
    if (cat === 'generic_saas' && score > 0) {
      for (const neg of signals_.negativeNames ?? []) {
        if (neg.test(text)) { score = 0; break; }
      }
    }

    if (score > 0) scores[cat] = score;
  }

  // Find the category with the highest score
  let bestScore = 0;
  for (const [cat, score] of Object.entries(scores) as [IndustryCategory, number][]) {
    if (score > bestScore) { bestScore = score; industryCategory = cat; }
  }

  // Determine confidence based on score
  if (bestScore >= 3) industryConfidence = 'high';       // name-level match
  else if (bestScore >= 2) industryConfidence = 'medium'; // title-level match
  else if (bestScore >= 1) industryConfidence = 'low';    // description-only match

  // If company type is staffing, override industry category too
  if (companyType === 'staffing_recruiting') {
    industryCategory = 'staffing_recruiting';
    industryConfidence = typeConf;
  } else if (companyType === 'healthcare_provider') {
    industryCategory = 'healthcare';
    industryConfidence = typeConf;
  } else if (companyType === 'job_board') {
    industryCategory = 'other';
    industryConfidence = typeConf;
  }

  // Overall confidence = max of company-type confidence and industry confidence
  const confRank = { high: 2, medium: 1, low: 0 };
  const overallConf: 'high' | 'medium' | 'low' =
    confRank[typeConf] >= confRank[industryConfidence] ? typeConf : industryConfidence;

  return {
    companyType,
    industryCategory,
    confidence: overallConf,
    signals: [...new Set(signals)], // deduplicate
  };
}

// ── User industry → IndustryCategory mapping ─────────────────────────────────

const USER_INDUSTRY_TO_CATEGORY: Array<{ patterns: RegExp[]; category: IndustryCategory }> = [
  {
    patterns: [/ai\s*(infrastructure|cloud|compute|accelerator|platform)/i, /machine\s+learning\s+(infra|platform)/i, /gpu\s+(cloud|compute)/i, /ml\s+infra/i, /generative\s+ai/i, /artificial\s+intelligence/i, /large\s+language/i, /llm/i],
    category: 'ai_infrastructure',
  },
  {
    patterns: [/semiconductor/i, /chip\s+(design|fab)/i, /silicon/i, /asic/i, /fpga/i, /soc\b/i, /integrated\s+circuit/i],
    category: 'semiconductors',
  },
  {
    patterns: [/photonics/i, /optics\b/i, /optical/i, /optoelectronics/i, /fiber\s+optic/i, /lidar/i, /transceiver/i],
    category: 'photonics_optics',
  },
  {
    patterns: [/electronic\s+components?/i, /sensors?\b/i, /embedded\s+systems?/i, /iot\b/i, /electronic\s+manufacturing/i],
    category: 'electronic_components',
  },
  {
    patterns: [/server(s)?\b/i, /data\s+center/i, /datacenter/i, /hyperscaler/i, /colocation/i, /bare\s+metal/i, /hpc\b/i, /compute\s+(infrastructure|cluster)/i],
    category: 'servers_data_center',
  },
  {
    patterns: [/networking\b/i, /network\s+(infrastructure|security|equipment|hardware)/i, /sd-?wan/i, /routing/i, /switching/i, /firewall/i],
    category: 'networking',
  },
  {
    patterns: [/database/i, /data\s+(warehouse|platform|lake)/i, /distributed\s+(database|systems)/i, /data\s+infrastructure/i, /object\s+storage/i, /vector\s+db/i],
    category: 'database',
  },
  {
    patterns: [/infrastructure\s+security/i, /zero\s+trust/i, /cloud\s+security/i, /network\s+security/i, /endpoint\s+security/i, /cybersecurity\b/i, /security\s+(platform|infrastructure)/i],
    category: 'infrastructure_security',
  },
];

export function mapUserIndustriesToCategories(userIndustries: string[]): Set<IndustryCategory> {
  const result = new Set<IndustryCategory>();
  for (const ind of userIndustries) {
    for (const { patterns, category } of USER_INDUSTRY_TO_CATEGORY) {
      if (patterns.some(p => p.test(ind))) {
        result.add(category);
        break;
      }
    }
  }
  return result;
}

// ── Filter decision ───────────────────────────────────────────────────────────

export type FilterDecision = 'pass' | 'drop_company_type' | 'drop_industry';

export function getFilterDecision(
  cls:                JobClassification,
  preferredCategories: Set<IndustryCategory>,
): FilterDecision {
  // ── Hard drops: company type is definitively not a real employer ───────────
  if (
    (cls.companyType === 'staffing_recruiting' || cls.companyType === 'healthcare_provider' || cls.companyType === 'job_board') &&
    cls.confidence !== 'low'
  ) {
    return 'drop_company_type';
  }

  // ── Industry whitelist — only when user has stated preferences ────────────
  // Only drop when:
  //   a) user has preferred categories (they've told us what they want)
  //   b) we have HIGH confidence in the classification (name-level match)
  //   c) the detected category is EXPLICITLY wrong (generic_saas or healthcare/staffing)
  //   d) the category does NOT match any preferred category
  //
  // We never drop 'unknown' — we can't be sure, so we pass it through.
  if (preferredCategories.size > 0 && cls.confidence === 'high') {
    const isDefinitelyWrong = (
      cls.industryCategory === 'generic_saas'   ||
      cls.industryCategory === 'healthcare'     ||
      cls.industryCategory === 'staffing_recruiting'
    );
    if (isDefinitelyWrong && !preferredCategories.has(cls.industryCategory)) {
      return 'drop_industry';
    }
  }

  return 'pass';
}
