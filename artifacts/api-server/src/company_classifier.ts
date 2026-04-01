/**
 * company_classifier.ts
 *
 * Shared deterministic classification layer for jobs and companies.
 * Applied to ALL search sources via the shared runScoutInBackground pipeline.
 *
 * Two classification dimensions:
 *   CompanyType     — is this a real employer in the right space, or noise?
 *   IndustryCategory — what industry segment does this company operate in?
 *
 * Rules are purely deterministic (keyword + pattern matching).
 * Claude is NOT called here — this runs as a cheap pre-filter before Claude scoring.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CompanyType =
  | 'direct_employer'
  | 'staffing_recruiting'
  | 'agency_services'       // IT consulting, advertising agencies, management consulting
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
  | 'advertising_agency'
  | 'construction_engineering'
  | 'cleantech_energy'
  | 'it_services_consulting'
  | 'financial_services'
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
  'meridianit', 'meridian it', 'meridian information technology',
  'infosys bpm', 'wipro', 'tata consultancy', 'tcs', 'hcl technologies',
  'cognizant', 'tech mahindra', 'mphasis', 'hexaware', 'niit technologies',
  'syntel', 'mastech', 'igate', 'patni computer', 'rackspace managed',
]);

const KNOWN_AGENCY_SERVICE_NAMES = new Set([
  'publicis groupe', 'publicis', 'wpp', 'omnicom', 'interpublic', 'havas',
  'dentsu', 'grey', 'bbdo', 'jwt', 'ogilvy', 'saatchi', 'mcann',
  'accenture', 'deloitte digital', 'ibm consulting', 'capgemini', 'atos',
  'hitachi solutions', 'hitachi vantara', 'hitachi consulting',
  'ntt data', 'fujitsu', 'unisys',
  'invisible technologies', 'invisible.tech',
  'a team', 'the a team',
]);

const KNOWN_JOB_BOARDS = new Set([
  'indeed', 'linkedin', 'ziprecruiter', 'glassdoor', 'monster',
  'careerbuilder', 'dice', 'simplyhired', 'handshake', 'snagajob',
  'idealist', 'wayup', 'after college', 'internships.com',
  'jobsforhumanity', 'jobs for humanity',
  'smartdev', 'smartdev1',
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

const HEALTHCARE_COMPANY_NAMES = new Set([
  'alivecor', 'alive cor', 'docplanner', 'doc planner',
  'teladoc', 'doximity', 'veeva', 'epic systems', 'cerner',
  'allscripts', 'athenahealth', 'nextgen healthcare',
  'healthstream', 'privia health', 'modernizing medicine',
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

const AGENCY_SERVICES_PATTERNS = [
  /\b(it|technology)\s+(solutions|services|consulting)\s+(llc|inc|group|corp|gmbh|ltd)\b/i,
  /\bmanaged\s+(it|technology)\s+services?\b/i,
  /\bsystems?\s+integrator\b/i,
  /\bdigital\s+(agency|transformation\s+firm)\b/i,
  /\badvertising\s+agency\b/i,
  /\bmarketing\s+agency\b/i,
  /\boutso(urcing|urced)\s+(firm|company|partner)\b/i,
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

  // ── Agency / consulting services ───────────────────────────────────────────
  if (KNOWN_AGENCY_SERVICE_NAMES.has(lower)) {
    return { type: 'agency_services', confidence: 'high', signal: `known_agency:${lower}` };
  }
  for (const p of AGENCY_SERVICES_PATTERNS) {
    if (p.test(companyName)) {
      return { type: 'agency_services', confidence: 'medium', signal: `agency_pattern:${p.source}` };
    }
  }

  // ── Healthcare provider ────────────────────────────────────────────────────
  if (HEALTHCARE_COMPANY_NAMES.has(lower)) {
    return { type: 'healthcare_provider', confidence: 'high', signal: `known_healthcare:${lower}` };
  }
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
      /\b(akash(network)?|centml|groq|cerebras|lambda\s+labs?|together\s+ai|replicate|modal(\s+labs?)?|runpod|coreweave|voltage\s+park|octoai|fireworks(\s+ai)?|baseten|anyscale|inflection(\s+ai)?|mistral(\s+ai)?|cohere|scale\s+ai|hugging\s+face|wandb|weights[\s&]+biases|determined\s+ai|cudo\s+compute|vast\.ai|gpu\.net|paperspace|gradient|phoenix\s+nap|hyperstack|imbue|stability\s+ai|tensorwave|tensor\s+wave|evergrid|fiddler(\s+ai)?|rescale|andromeda(\s+systems?)?|tigerdata|tiger\s+data)\b/i,
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
      /\b(molex|amphenol|te\s+connectivity|vishay|keysight|national\s+instruments|rohde\s+&\s+schwarz|murata|tdk|yageo|bourns|bel\s+fuse|littelfuse|panasonic\s+(electronic|industrial)|epson|kyocera|kyocera\s+avx|avx|ttm\s+technologies|isola|rogers\s+corp|park\s+electrochemical|moog|curtiss-wright|heico|esterline|wind\s+river|windriver)\b/i,
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
      /\b(supermicro|super\s+micro|dell\s+(emc|technologies)|hpe|hewlett\s+packard\s+enterprise|lenovo\s+(dcg|data\s+center)|quanta\s+(cloud|computer)|wiwynn|gigabyte\s+server|asus\s+(server|asmb)|pure\s+storage|purestorage|netapp|cohesity|commvault|veeam|nutanix|zerto|druva|rubrik|scality|vast\s+data|hammerspace|qumulo|cloudian|seagate\s+(exos|lyve)|western\s+digital\s+data\s+center|backblaze|nerdio|weka|penguin\s+solutions|cray|sgimips|dataon|45drives)\b/i,
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
      /\b(cisco|juniper\s+(networks?)?|arista\s+(networks?)?|palo\s+alto\s+networks?|fortinet|extreme\s+networks?|calix|ciena|ribbon\s+communications?|lumen\s+(technologies?)?|commscope|corning\s+(optical|cable)|netscout|spirent|keysight\s+network|sycamore\s+networks?|cradlepoint|cato\s+networks?|versa\s+networks?|aryaka|cloudflare|fastly|akamai|zscaler|netskope|illumio|f5(\s+networks?)?|a10\s+networks?|radware|barracuda|sonicwall|watchguard|aerohive|ruckus|ubiquiti|cambium\s+networks?|siklu|mimosa|dejima|viptela|silverpeak|talari|velocloud|netgear|nordsec|nord\s+security)\b/i,
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
      /\b(mongodb|snowflake|databricks|cockroach\s+labs?|planetscale|singlestore|couchbase|clickhouse|neon(\s+db)?|supabase|timescaledb|yugabyte|arangodb|neo4j|tigergraph|redis(\s+labs?)?|aerospike|scylladb|cassandra|mariadb|percona|vitess|tidb|pingcap|starburst|dremio|imply|rockset|materialize|firebolt|turso|xata|edgedb|surrealdb|fauna|convex|upstash|momento|dynatrace\s+db|influxdb|influx\s+data|questdb|kdb|cratedb|teleport(\s+hq)?)\b/i,
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
      /\b(crowdstrike|sentinelone|wiz(\s+cloud)?|orca\s+security|lacework|darktrace|illumio|zscaler|netskope|vectra(\s+ai)?|axonius|tenable|qualys|rapid7|snyk|aqua\s+security|sysdig|cybereason|cyberark|sailpoint|delinea|telos|netsurion|secureworks|trustwave|exabeam|sumo\s+logic|logrhythm|securonix|devo(\s+technology)?|gurucul|varonis|forcepoint|proofpoint|mimecast|abnormal\s+security|ironscales|cofense|tessian|valimail|agari|red\s+canary|expel|arctic\s+wolf|huntress|blumira|detectify|intigriti|bugcrowd|hackerone|synack|cobalt\s+io|pentest(\s+tools?)?|threatlocker|xcitium|comodo|malwarebytes|webroot|sophos|bitdefender|eset|kaspersky|trend\s+micro|checkpoint|trellix|broadcom\s+security|menlo\s+security|menlosecurity)\b/i,
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
      /\b(salesforce|hubspot|zendesk|freshworks|intercom|stripe|twilio|sendgrid|mailchimp|marketo|pardot|eloqua|gainsight|totango|churnzero|mixpanel|amplitude|segment|braze|iterable|klaviyo|attentive|yotpo|gorgias|dixa|kustomer|zoho|pipedrive|outreach|salesloft|gong|chorus|clari|drift|qualified|6sense|demandbase|bombora|leadiq|zoominfo|stackadapt|adroll|criteo|the\s+trade\s+desk|workfront|asana|notion|clickup|monday\.com|airtable|smartsheet|coda|basecamp|trello|miro|figma|canva|loom|dovetail|productboard|pendo|fullstory|heap|hotjar|logrocket|datadog|new\s+relic|dynatrace|appdynamics|splunk|elastic|grafana|hashicorp|postman|atlassian|vanta|drata|servicetitan|jobber|housecall\s+pro|mindbody|squarespace|wix|webflow|shopify|bigcommerce|magento|netsuite|sage\s+intacct|coupa|tipalti|expensify|concur|brex|ramp|bench|gusto|rippling|bamboohr|lattice|culture\s+amp|workday|successfactors|cornerstone\s+ondemand|docebo|absorb|seismic|highspot|mindtickle|showpad|xplor|xplor\s+technologies|reonic)\b/i,
    ],
    descPatterns: [
      /\b(saas\s+(platform|company|product|startup|application|solution|tool)|cloud\s+software\s+(company|platform|provider)|workflow\s+automation\s+platform|crm\s+(platform|system)|marketing\s+automation\s+(platform|tool)|customer\s+success\s+(platform|software)|sales\s+(engagement|enablement)\s+platform|revenue\s+operations\s+(platform|tool)|ad\s+tech|adtech\s+platform|martech\s+(stack|platform|company)|hr\s+tech|hrtech\s+platform|legal\s+tech|legaltech|proptech|insurtech)\b/i,
    ],
    titlePatterns: [],
    negativeNames: [
      /\b(infrastructure|semiconductor|photonics|optical|networking|data\s+center|gpu|ai\s+(accelerator|chip|infrastructure)|security\s+(platform|infrastructure))\b/i,
    ],
  },

  advertising_agency: {
    namePatterns: [
      /\b(publicis|wpp|omnicom|interpublic|havas|dentsu|grey|bbdo|jwt|ogilvy|saatchi|mccann|leo\s+burnett|ddb|tbwa|y&r|vmly&r|razorfish|possible|sapient|digitas|performics|zenithoptimedia|starcom|mediavest|mindshare|maxus|mec|carat|isobar|isobar|serviceplan|draftfcb|mullen\s+lowe|draft\s+worldwide)\b/i,
    ],
    titlePatterns: [
      /\b(advertising\s+(agency|network|group)|media\s+(buying|planning|agency)|creative\s+agency|brand\s+agency|ad\s+(agency|network|tech\s+firm))\b/i,
    ],
    descPatterns: [
      /\b(advertising\s+(agency|network|holding|group)|media\s+(buying|planning\s+agency)|creative\s+agency|integrated\s+marketing\s+communications|brand\s+(strategy|agency))\b/i,
    ],
  },

  construction_engineering: {
    namePatterns: [
      /\b(aecom|bechtel|fluor|kbr(\s+inc)?|jacobs\s+(engineering)?|parsons(\s+corp)?|turner\s+construction|skanska|hok|gensler|stantec|wsatkins|atkins|arup|mott\s+macdonald|arcadis|cdm\s+smith|tetra\s+tech|black\s+&\s+veatch|burns\s+&\s+mcdonnell)\b/i,
    ],
    titlePatterns: [
      /\b(civil\s+engineering|construction\s+(management|services)|infrastructure\s+(engineering|construction)|project\s+management\s+(construction|engineering)|epc\s+(firm|contractor)|general\s+contractor)\b/i,
    ],
    descPatterns: [
      /\b(civil\s+(engineering|infrastructure)|construction\s+(management|services|project)|engineering\s+(procurement|construction)|epc\s+(project|contract)|general\s+contracting|design[\s-]build\s+(firm|contractor))\b/i,
    ],
  },

  cleantech_energy: {
    namePatterns: [
      /\b(reonic|sunrun|sunpower|sunnova|vivint\s+solar|tesla\s+energy|enphase|solaredge|solarwinds(?!\s+network)|nextracker|firstsolar|first\s+solar|suntech|canadian\s+solar|jinko\s+solar|longi\s+solar|siemens\s+energy|ge\s+vernova|vestas|orsted|northland\s+power|pattern\s+energy|nextera\s+energy)\b/i,
    ],
    titlePatterns: [
      /\b(renewable\s+(energy|power)|solar\s+(energy|power|installation|sales)|wind\s+(energy|power|turbine)|clean\s+energy|cleantech|energy\s+storage\s+(system|solutions?)|ev\s+charging\s+(solutions?|network)|electrification)\b/i,
    ],
    descPatterns: [
      /\b(renewable\s+(energy|power|generation)|solar\s+(panels?|installation|photovoltaic|pv)|wind\s+(turbine|power|energy)|clean\s+(energy|power)|energy\s+storage\s+(battery|system)|ev\s+charging|grid\s+(modernization|decarbonization)|net\s+zero\s+energy)\b/i,
    ],
  },

  it_services_consulting: {
    namePatterns: [
      /\b(accenture|deloitte(\s+consulting)?|ibm\s+(consulting|services)|capgemini|atos|infosys|wipro|tata\s+consultancy|tcs\b|hcl\s+(technologies|tech)|cognizant|tech\s+mahindra|mphasis|hexaware|niit\s+technologies|syntel|mastech|igate|kyndryl|dxc\s+technology|leidos|booz\s+allen|saic(\s+inc)?|gartner|forrester|idc(\s+research)?|hitachi\s+(solutions|vantara|consulting)|ntt\s+data|fujitsu(\s+america)?|unisys|logicalis|presidio|cdw(\s+corp)?|insight\s+direct|insight\s+enterprises|connection\s+(techsolve|inc)?|pc\s+connection|world\s+wide\s+technology|wwt\b|slalom|ness\s+digital|sapient|globe(\s+life)?|lumendata|meridian\s+it|meridianit|mirantis)\b/i,
    ],
    titlePatterns: [
      /\b(it\s+(managed\s+services|outsourcing|consulting\s+firm)|technology\s+consulting\s+(firm|services)|systems?\s+integration\s+firm|managed\s+services?\s+provider|msp\s+(firm|company))\b/i,
    ],
    descPatterns: [
      /\b(it\s+(managed\s+services|outsourcing|consulting\s+services)|technology\s+consulting\s+(services|firm)|systems?\s+integrator|managed\s+services?\s+provider|msp\s+(services?|company)|professional\s+services\s+(technology|it|technology\s+consulting))\b/i,
    ],
  },

  financial_services: {
    namePatterns: [
      /\b(jpmorgan|jp\s+morgan|chase(\s+bank)?|goldman\s+sachs|morgan\s+stanley|bank\s+of\s+america|wells\s+fargo|citibank|citigroup|hsbc|barclays|deutsche\s+bank|credit\s+suisse|ubs|blackrock|vanguard|fidelity|charles\s+schwab|td\s+(bank|ameritrade)|american\s+express|visa(\s+inc)?|mastercard|paypal|square(\s+inc)?|robinhood|coinbase|kraken(\s+exchange)?|binance|gemini\s+trust)\b/i,
    ],
    titlePatterns: [
      /\b(investment\s+(banking|management)|asset\s+management\s+firm|hedge\s+fund|private\s+equity\s+firm|venture\s+capital\s+firm|retail\s+banking|commercial\s+banking|financial\s+services\s+firm)\b/i,
    ],
    descPatterns: [
      /\b(investment\s+(banking|management|firm)|asset\s+management|hedge\s+fund|private\s+equity|venture\s+capital\s+firm|retail\s+banking|commercial\s+lending|financial\s+(services|advisory|markets))\b/i,
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

  // Score each category against all three signal sources
  const scores: Partial<Record<IndustryCategory, number>> = {};
  const text = `${company} ${title} ${description}`.toLowerCase();

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
  if (bestScore >= 3) industryConfidence = 'high';        // name-level match
  else if (bestScore >= 2) industryConfidence = 'medium';  // title-level match
  else if (bestScore >= 1) industryConfidence = 'low';     // description-only match

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
  } else if (companyType === 'agency_services') {
    industryCategory = 'it_services_consulting';
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

// Categories that are DEFINITIVELY off-target for hardware/infrastructure sales roles.
// When the user has specific preferred categories, any job classified here gets dropped.
const OFF_TARGET_CATEGORIES = new Set<IndustryCategory>([
  'generic_saas',
  'healthcare',
  'staffing_recruiting',
  'advertising_agency',
  'construction_engineering',
  'cleantech_energy',
  'it_services_consulting',
  'financial_services',
  'other',
]);

export function getFilterDecision(
  cls:                JobClassification,
  preferredCategories: Set<IndustryCategory>,
): FilterDecision {
  // ── Hard drops: company type is definitively not a real employer ───────────
  if (
    (cls.companyType === 'staffing_recruiting' ||
     cls.companyType === 'healthcare_provider' ||
     cls.companyType === 'job_board'           ||
     cls.companyType === 'agency_services') &&
    cls.confidence !== 'low'
  ) {
    return 'drop_company_type';
  }

  // ── Industry whitelist — only when user has stated preferences ────────────
  if (preferredCategories.size > 0) {
    const cat = cls.industryCategory;

    // If it's clearly in a preferred category → always pass
    if (preferredCategories.has(cat)) return 'pass';

    // If we have HIGH confidence it's an off-target category → drop
    if (cls.confidence === 'high' && OFF_TARGET_CATEGORIES.has(cat)) {
      return 'drop_industry';
    }

    // If we have MEDIUM confidence it's an off-target category → also drop
    // (medium = title-level match — strong enough to act on)
    if (cls.confidence === 'medium' && OFF_TARGET_CATEGORIES.has(cat)) {
      return 'drop_industry';
    }

    // 'unknown' at any confidence → pass through (can't be sure, let Claude decide)
    // high/medium confidence in a NON-preferred category that's also not off-target
    // (e.g. some edge category) → pass through to Claude
  }

  return 'pass';
}
