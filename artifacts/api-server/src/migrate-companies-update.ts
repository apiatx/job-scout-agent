import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('Connecting to database...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // === FIXES to existing companies ===

    // 1. Bentley Systems: greenhouse → plain
    const r1 = await client.query(
      `UPDATE companies SET ats_type = 'plain', ats_slug = NULL, careers_url = 'https://jobs.bentley.com' WHERE name = 'Bentley Systems'`
    );
    console.log(`Bentley Systems: ${r1.rowCount} row(s) updated`);

    // 2. Crane NXT: greenhouse → plain
    const r2 = await client.query(
      `UPDATE companies SET ats_type = 'plain', ats_slug = NULL, careers_url = 'https://www.cranenxt.com/en/careers' WHERE name = 'Crane NXT'`
    );
    console.log(`Crane NXT: ${r2.rowCount} row(s) updated`);

    // 3. Enverus: greenhouse → plain
    const r3 = await client.query(
      `UPDATE companies SET ats_type = 'plain', ats_slug = NULL, careers_url = 'https://www.enverus.com/about/careers' WHERE name = 'Enverus'`
    );
    console.log(`Enverus: ${r3.rowCount} row(s) updated`);

    // 4. Aspen Technology: fix Workday domain and careerSite
    const r4 = await client.query(
      `UPDATE companies SET careers_url = 'aspentech.wd5.myworkdayjobs.com', ats_slug = 'aspentech' WHERE name = 'Aspen Technology'`
    );
    console.log(`Aspen Technology: ${r4.rowCount} row(s) updated`);

    // 5. Xylem: Workday → plain
    const r5 = await client.query(
      `UPDATE companies SET ats_type = 'plain', ats_slug = NULL, careers_url = 'https://www.xylem.com/en-us/careers/' WHERE name = 'Xylem'`
    );
    console.log(`Xylem: ${r5.rowCount} row(s) updated`);

    // === ADD new companies ===
    const newCompanies: { name: string; ats_type: string; ats_slug?: string; careers_url?: string }[] = [
      // Greenhouse
      { name: 'Anthropic', ats_type: 'greenhouse', ats_slug: 'anthropic' },
      { name: 'Commvault', ats_type: 'greenhouse', ats_slug: 'commvault' },
      { name: 'Impinj', ats_type: 'greenhouse', ats_slug: 'impinj' },
      { name: 'Celestica', ats_type: 'greenhouse', ats_slug: 'celestica' },
      { name: 'Nextracker', ats_type: 'greenhouse', ats_slug: 'nextracker' },
      { name: 'Stem Inc', ats_type: 'greenhouse', ats_slug: 'stem' },
      // Workday
      { name: 'Intel', ats_type: 'workday', careers_url: 'intel.wd1.myworkdayjobs.com', ats_slug: 'External' },
      { name: 'Motorola Solutions', ats_type: 'workday', careers_url: 'motorolasolutions.wd5.myworkdayjobs.com', ats_slug: 'Careers' },
      { name: 'TE Connectivity', ats_type: 'workday', careers_url: 'te.wd10.myworkdayjobs.com', ats_slug: 'TECareers' },
      { name: 'Cummins', ats_type: 'workday', careers_url: 'cummins.wd1.myworkdayjobs.com', ats_slug: 'External' },
      { name: 'Generac', ats_type: 'workday', careers_url: 'generac.wd5.myworkdayjobs.com', ats_slug: 'GeneracCareers' },
      // Plain
      { name: 'Belden', ats_type: 'plain', careers_url: 'https://careers.belden.com' },
      { name: 'Amphenol', ats_type: 'plain', careers_url: 'https://careers.amphenol.com' },
      { name: 'Danfoss', ats_type: 'plain', careers_url: 'https://www.danfoss.com/en/careers/' },
      { name: 'Spirent Communications', ats_type: 'plain', careers_url: 'https://www.spirent.com/about/careers' },
      { name: 'Array Technologies', ats_type: 'plain', careers_url: 'https://arraytechinc.com/careers' },
    ];

    let inserted = 0;
    for (const co of newCompanies) {
      // Check if company already exists
      const existing = await client.query(
        `SELECT id FROM companies WHERE name = $1`,
        [co.name]
      );
      if (existing.rowCount && existing.rowCount > 0) {
        console.log(`  Skipped (already exists): ${co.name}`);
        continue;
      }
      await client.query(
        `INSERT INTO companies (name, ats_type, ats_slug, careers_url) VALUES ($1, $2, $3, $4)`,
        [co.name, co.ats_type, co.ats_slug ?? null, co.careers_url ?? null]
      );
      inserted++;
      console.log(`  Inserted: ${co.name} (${co.ats_type})`);
    }

    await client.query('COMMIT');
    console.log(`\nMigration complete. Updated 5 existing companies, inserted ${inserted} new companies.`);
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
