import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const companies: { name: string; ats_type: string; ats_slug?: string; careers_url?: string }[] = [
  // Greenhouse
  { name: 'Pure Storage', ats_type: 'greenhouse', ats_slug: 'purestorage' },
  { name: 'CoreWeave', ats_type: 'greenhouse', ats_slug: 'coreweave' },
  { name: 'Samsara', ats_type: 'greenhouse', ats_slug: 'samsara' },
  { name: 'Databricks', ats_type: 'greenhouse', ats_slug: 'databricks' },
  { name: 'Iron Mountain', ats_type: 'greenhouse', ats_slug: 'ironmountainsolutions' },
  { name: 'Cohesity', ats_type: 'greenhouse', ats_slug: 'cohesity' },
  { name: 'Bentley Systems', ats_type: 'greenhouse', ats_slug: 'bentleysystems' },
  { name: 'Crane NXT', ats_type: 'greenhouse', ats_slug: 'cranenxt' },
  { name: 'Scale AI', ats_type: 'greenhouse', ats_slug: 'scaleai' },
  { name: 'Enverus', ats_type: 'greenhouse', ats_slug: 'enverus' },
  { name: 'Cognite', ats_type: 'greenhouse', ats_slug: 'cognite' },
  { name: 'Urbint', ats_type: 'greenhouse', ats_slug: 'urbint' },
  { name: 'EnergyHub', ats_type: 'greenhouse', ats_slug: 'energyhub' },
  // Lever
  { name: 'Extreme Networks', ats_type: 'lever', ats_slug: 'extremenetworks' },
  // Workday
  { name: 'NVIDIA', ats_type: 'workday', careers_url: 'nvidia.wd5.myworkdayjobs.com', ats_slug: 'NVIDIAExternalCareerSite' },
  { name: 'Broadcom', ats_type: 'workday', careers_url: 'broadcom.wd1.myworkdayjobs.com', ats_slug: 'External_Career' },
  { name: 'Lumentum', ats_type: 'workday', careers_url: 'lumentum.wd5.myworkdayjobs.com', ats_slug: 'LITE' },
  { name: 'Marvell Technology', ats_type: 'workday', careers_url: 'marvell.wd1.myworkdayjobs.com', ats_slug: 'MarvellCareers' },
  { name: 'Calix', ats_type: 'workday', careers_url: 'calix.wd1.myworkdayjobs.com', ats_slug: 'External' },
  { name: 'Dell Technologies', ats_type: 'workday', careers_url: 'dell.wd1.myworkdayjobs.com', ats_slug: 'External' },
  { name: 'HPE', ats_type: 'workday', careers_url: 'hpe.wd5.myworkdayjobs.com', ats_slug: 'Jobsathpe' },
  { name: 'Cisco', ats_type: 'workday', careers_url: 'cisco.wd5.myworkdayjobs.com', ats_slug: 'Cisco_Careers' },
  { name: 'Micron', ats_type: 'workday', careers_url: 'micron.wd1.myworkdayjobs.com', ats_slug: 'External' },
  { name: 'Equinix', ats_type: 'workday', careers_url: 'equinix.wd1.myworkdayjobs.com', ats_slug: 'External' },
  { name: 'F5', ats_type: 'workday', careers_url: 'ffive.wd5.myworkdayjobs.com', ats_slug: 'f5jobs' },
  { name: 'Seagate', ats_type: 'workday', careers_url: 'seagate.wd1.myworkdayjobs.com', ats_slug: 'EXT' },
  { name: 'Rockwell Automation', ats_type: 'workday', careers_url: 'rockwellautomation.wd1.myworkdayjobs.com', ats_slug: 'External_Rockwell_Automation' },
  { name: 'Baker Hughes', ats_type: 'workday', careers_url: 'bakerhughes.wd5.myworkdayjobs.com', ats_slug: 'BakerHughes' },
  { name: 'Entegris', ats_type: 'workday', careers_url: 'entegris.wd1.myworkdayjobs.com', ats_slug: 'EntegrisCareers' },
  { name: 'Cognex', ats_type: 'workday', careers_url: 'cognex.wd1.myworkdayjobs.com', ats_slug: 'External_Career_Site' },
  { name: 'Bloom Energy', ats_type: 'workday', careers_url: 'bloomenergy.wd1.myworkdayjobs.com', ats_slug: 'BloomEnergyCareers' },
  { name: '3M', ats_type: 'workday', careers_url: '3m.wd1.myworkdayjobs.com', ats_slug: 'Search' },
  { name: 'Honeywell', ats_type: 'workday', careers_url: 'honeywell.wd5.myworkdayjobs.com', ats_slug: 'Honeywell' },
  { name: 'Cadence Design Systems', ats_type: 'workday', careers_url: 'cadence.wd1.myworkdayjobs.com', ats_slug: 'External_Careers' },
  { name: 'Xylem', ats_type: 'workday', careers_url: 'xylem.wd1.myworkdayjobs.com', ats_slug: 'Xylem' },
  { name: 'Trimble', ats_type: 'workday', careers_url: 'trimble.wd1.myworkdayjobs.com', ats_slug: 'TrimbleCareers' },
  { name: 'Aspen Technology', ats_type: 'workday', careers_url: 'aspentech.wd1.myworkdayjobs.com', ats_slug: 'AspenTech' },
  // Plain
  { name: 'Nutanix', ats_type: 'plain', careers_url: 'https://careers.nutanix.com/' },
  { name: 'Palo Alto Networks', ats_type: 'plain', careers_url: 'https://jobs.paloaltonetworks.com/en' },
  { name: 'Arista Networks', ats_type: 'plain', careers_url: 'https://www.arista.com/en/careers' },
  { name: 'Coherent Corp', ats_type: 'plain', careers_url: 'https://www.coherent.com/company/careers' },
  { name: 'CommScope', ats_type: 'plain', careers_url: 'https://jobs.commscope.com/' },
  { name: 'NetApp', ats_type: 'plain', careers_url: 'https://careers.netapp.com/' },
  { name: 'Veeva Systems', ats_type: 'plain', careers_url: 'https://careers.veeva.com/' },
  { name: 'AMD', ats_type: 'plain', careers_url: 'https://careers.amd.com/' },
  { name: 'Vertiv', ats_type: 'plain', careers_url: 'https://www.vertiv.com/en-us/about/careers/' },
  { name: 'Juniper Networks', ats_type: 'plain', careers_url: 'https://jobs.juniper.net' },
  { name: 'Eaton', ats_type: 'plain', careers_url: 'https://jobs.eaton.com' },
  { name: 'Keysight Technologies', ats_type: 'plain', careers_url: 'https://careers.keysight.com' },
  { name: 'Schneider Electric', ats_type: 'plain', careers_url: 'https://careers.schneiderelectric.com' },
  { name: 'Supermicro', ats_type: 'plain', careers_url: 'https://www.supermicro.com/en/about/jobs' },
  { name: 'Fortinet', ats_type: 'plain', careers_url: 'https://www.fortinet.com/corporate/careers/careers-search' },
  { name: 'Ciena', ats_type: 'plain', careers_url: 'https://www.ciena.com/careers' },
  { name: 'Infinera', ats_type: 'plain', careers_url: 'https://www.infinera.com/company/careers' },
  { name: 'Viavi Solutions', ats_type: 'plain', careers_url: 'https://www.viavisolutions.com/en-us/careers' },
  { name: 'Western Digital', ats_type: 'plain', careers_url: 'https://jobs.westerndigital.com' },
  { name: 'Lambda Labs', ats_type: 'plain', careers_url: 'https://lambdalabs.com/careers' },
  { name: 'Groq', ats_type: 'plain', careers_url: 'https://groq.com/careers' },
  { name: 'Cerebras', ats_type: 'plain', careers_url: 'https://cerebras.ai/careers' },
  { name: 'Tenstorrent', ats_type: 'plain', careers_url: 'https://tenstorrent.com/careers' },
  { name: 'Digital Realty', ats_type: 'plain', careers_url: 'https://www.digitalrealty.com/careers' },
  { name: 'One Stop Systems', ats_type: 'plain', careers_url: 'https://onestopsystems.com/pages/sales-account-manager' },
  { name: 'VAST Data', ats_type: 'plain', careers_url: 'https://www.vastdata.com/careers' },
  { name: 'Weka', ats_type: 'plain', careers_url: 'https://www.weka.io/company/careers' },
  { name: 'Teradyne', ats_type: 'plain', careers_url: 'https://jobs.teradyne.com' },
  { name: 'Zebra Technologies', ats_type: 'plain', careers_url: 'https://careers.zebra.com' },
  { name: 'Halliburton', ats_type: 'plain', careers_url: 'https://www.halliburton.com/en/careers' },
  { name: 'Schlumberger', ats_type: 'plain', careers_url: 'https://www.slb.com/careers' },
  { name: 'ABB', ats_type: 'plain', careers_url: 'https://careers.abb/global/en/jobs' },
  { name: 'Siemens', ats_type: 'plain', careers_url: 'https://jobs.siemens.com/careers' },
  { name: 'Dow', ats_type: 'plain', careers_url: 'https://www.dow.com/en-us/careers' },
  { name: 'PPG Industries', ats_type: 'plain', careers_url: 'https://careers.ppg.com' },
  { name: 'Axalta', ats_type: 'plain', careers_url: 'https://careers.axalta.com' },
  { name: 'Enphase Energy', ats_type: 'plain', careers_url: 'https://www.enphase.com/careers' },
  { name: 'First Solar', ats_type: 'plain', careers_url: 'https://www.firstsolar.com/careers' },
  { name: 'Ameresco', ats_type: 'plain', careers_url: 'https://www.ameresco.com/careers' },
  { name: 'Keyence', ats_type: 'plain', careers_url: 'https://www.keyence.com/company/jobs' },
  { name: 'Fluence', ats_type: 'plain', careers_url: 'https://fluenceenergy.com/energy-storage-careers/' },
  { name: 'Emerson Electric', ats_type: 'plain', careers_url: 'https://www.emerson.com/en-us/careers/career-opportunities' },
  { name: 'AVEVA', ats_type: 'plain', careers_url: 'https://www.aveva.com/en/about/careers' },
  { name: 'Itron', ats_type: 'plain', careers_url: 'https://www.itron.com/na/about/careers' },
  { name: 'IDEX Corporation', ats_type: 'plain', careers_url: 'https://www.idexcorp.com/careers' },
  { name: 'Roper Technologies', ats_type: 'plain', careers_url: 'https://www.ropertechnologies.com/careers' },
  { name: 'AWS', ats_type: 'plain', careers_url: 'https://aws.amazon.com/careers' },
  { name: 'Google Cloud', ats_type: 'plain', careers_url: 'https://careers.google.com' },
];

async function main() {
  console.log('Connecting to database...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Wipe the companies table
    const del = await client.query('DELETE FROM companies');
    console.log(`Deleted ${del.rowCount} existing companies`);

    // Re-insert all companies from seed data
    let count = 0;
    for (const co of companies) {
      await client.query(
        'INSERT INTO companies (name, ats_type, ats_slug, careers_url) VALUES ($1, $2, $3, $4)',
        [co.name, co.ats_type, co.ats_slug ?? null, co.careers_url ?? null]
      );
      count++;
      console.log(`  Inserted: ${co.name} (${co.ats_type})`);
    }

    await client.query('COMMIT');
    console.log(`\nDone. Inserted ${count} companies.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error — rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
