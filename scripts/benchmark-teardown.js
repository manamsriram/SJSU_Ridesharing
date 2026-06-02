const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

function getEnvOrMountedSecret(key) {
  if (process.env[key]) return process.env[key];
  const secretPath = path.join(process.env.SECRET_MOUNT_PATH || '/mnt/secrets-store', key);
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8').trim();
  return undefined;
}

const pool = new Pool({ connectionString: getEnvOrMountedSecret('DATABASE_URL') });

async function teardown() {
  const client = await pool.connect();

  try {
    console.log('🧹 Benchmark teardown starting...\n');

    // Resolve benchmark user IDs
    const usersRes = await client.query(
      `SELECT user_id FROM users WHERE email LIKE 'benchmark-%@sjsu.edu'`
    );
    const benchmarkUserIds = usersRes.rows.map(r => r.user_id);

    if (benchmarkUserIds.length === 0) {
      console.log('No benchmark users found — nothing to clean up.');
      return;
    }

    console.log(`Found ${benchmarkUserIds.length} benchmark users`);

    // Resolve benchmark trip IDs (trips owned by benchmark driver)
    const tripsRes = await client.query(
      `SELECT trip_id FROM trips WHERE driver_id = ANY($1)`,
      [benchmarkUserIds]
    );
    const benchmarkTripIds = tripsRes.rows.map(r => r.trip_id);
    console.log(`Found ${benchmarkTripIds.length} benchmark trips`);

    // Resolve benchmark booking IDs (bookings on benchmark trips OR by benchmark riders)
    const bookingsRes = await client.query(
      `SELECT booking_id FROM bookings
       WHERE trip_id = ANY($1) OR rider_id = ANY($2)`,
      [benchmarkTripIds, benchmarkUserIds]
    );
    const benchmarkBookingIds = bookingsRes.rows.map(r => r.booking_id);
    console.log(`Found ${benchmarkBookingIds.length} benchmark bookings`);

    // Delete in FK dependency order
    if (benchmarkUserIds.length > 0) {
      const r = await client.query(
        `DELETE FROM ratings WHERE rater_id = ANY($1) OR ratee_id = ANY($1)`,
        [benchmarkUserIds]
      );
      console.log(`  deleted ${r.rowCount} ratings`);
    }

    if (benchmarkBookingIds.length > 0) {
      const p = await client.query(
        `DELETE FROM payments WHERE booking_id = ANY($1)`,
        [benchmarkBookingIds]
      );
      console.log(`  deleted ${p.rowCount} payments`);

      const q = await client.query(
        `DELETE FROM quotes WHERE booking_id = ANY($1)`,
        [benchmarkBookingIds]
      );
      console.log(`  deleted ${q.rowCount} quotes`);

      const b = await client.query(
        `DELETE FROM bookings WHERE booking_id = ANY($1)`,
        [benchmarkBookingIds]
      );
      console.log(`  deleted ${b.rowCount} bookings`);
    }

    if (benchmarkTripIds.length > 0) {
      const t = await client.query(
        `DELETE FROM trips WHERE trip_id = ANY($1)`,
        [benchmarkTripIds]
      );
      console.log(`  deleted ${t.rowCount} trips`);
    }

    const u = await client.query(
      `DELETE FROM users WHERE user_id = ANY($1)`,
      [benchmarkUserIds]
    );
    console.log(`  deleted ${u.rowCount} users`);

    console.log('\n✅ Benchmark teardown complete — no benchmark data remains.\n');

  } catch (err) {
    console.error('❌ Teardown failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

teardown().catch(console.error);
