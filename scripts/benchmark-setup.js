const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
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

const SJSU = {
  name: 'San Jose State University, 1 Washington Sq, San Jose, CA',
  lat: 37.3352,
  lng: -121.8811,
};

// Spread benchmark trips across multiple hubs so the search query returns variety
const BENCHMARK_HUBS = [
  { name: 'San Francisco Caltrain, 700 4th St, San Francisco, CA',       lat: 37.7765, lng: -122.3953 },
  { name: 'Oakland 12th St BART, 1245 Broadway, Oakland, CA',            lat: 37.8036, lng: -122.2715 },
  { name: 'Fremont BART Station, 2000 BART Way, Fremont, CA',            lat: 37.5577, lng: -121.9760 },
  { name: 'Milpitas Great Mall, 447 Great Mall Dr, Milpitas, CA',        lat: 37.4147, lng: -121.9004 },
  { name: 'Santa Clara Caltrain, 1000 Railroad Ave, Santa Clara, CA',    lat: 37.3528, lng: -121.9366 },
];

async function setup() {
  const client = await pool.connect();

  try {
    console.log('🔧 Benchmark setup starting...\n');

    const riderHash  = await bcrypt.hash('Password123', 10);
    const driverHash = await bcrypt.hash('benchmarkpass123', 10);

    // ── Upsert benchmark driver ───────────────────────────────────────────
    console.log('👤 Upserting benchmark-driver@sjsu.edu...');
    const driverRes = await client.query(`
      INSERT INTO users (name, email, password_hash, role, sjsu_id_status, rating, vehicle_info, seats_available)
      VALUES ($1, $2, $3, 'Driver', 'verified', 4.8, 'Toyota Camry 2022', 4)
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            role           = EXCLUDED.role,
            sjsu_id_status = EXCLUDED.sjsu_id_status,
            vehicle_info   = EXCLUDED.vehicle_info,
            seats_available = EXCLUDED.seats_available
      RETURNING user_id
    `, ['Benchmark Driver', 'benchmark-driver@sjsu.edu', driverHash]);

    const driverId = driverRes.rows[0].user_id;
    console.log(`  driver user_id: ${driverId}`);

    // ── Upsert 20 benchmark riders ────────────────────────────────────────
    console.log('👥 Upserting benchmark-rider-01 through benchmark-rider-20...');
    for (let i = 1; i <= 20; i++) {
      const email = `benchmark-rider-${String(i).padStart(2, '0')}@sjsu.edu`;
      await client.query(`
        INSERT INTO users (name, email, password_hash, role, sjsu_id_status, rating)
        VALUES ($1, $2, $3, 'Rider', 'verified', 4.5)
        ON CONFLICT (email) DO UPDATE
          SET password_hash = EXCLUDED.password_hash,
              role           = EXCLUDED.role,
              sjsu_id_status = EXCLUDED.sjsu_id_status
      `, [`Benchmark Rider ${i}`, email, riderHash]);
    }
    console.log('  ✅ 20 riders upserted');

    // ── Delete previous benchmark trips (idempotent re-run) ───────────────
    console.log('\n🗑️  Removing stale benchmark trips...');
    const deleted = await client.query(
      `DELETE FROM trips WHERE driver_id = $1 RETURNING trip_id`,
      [driverId]
    );
    if (deleted.rowCount > 0) {
      console.log(`  removed ${deleted.rowCount} old benchmark trips`);
    }

    // ── Insert fresh benchmark trips ──────────────────────────────────────
    // 3 trips per hub (15 total), departing 1–5 days out, 20 seats each.
    // High seat count prevents exhaustion when 20 VUs book concurrently.
    console.log('🚗 Creating 15 benchmark trips (3 per hub → SJSU)...');
    const tripIds = [];

    for (const hub of BENCHMARK_HUBS) {
      for (let j = 0; j < 3; j++) {
        const daysOut    = j + 1; // 1, 2, 3 days out per hub
        const departure  = new Date();
        departure.setDate(departure.getDate() + daysOut);
        departure.setHours(8 + j * 2, 0, 0, 0); // 08:00, 10:00, 12:00

        const result = await client.query(`
          INSERT INTO trips (
            driver_id, origin, destination,
            origin_point, destination_point,
            departure_time, seats_available, status
          ) VALUES (
            $1, $2, $3,
            ST_SetSRID(ST_MakePoint($4, $5), 4326),
            ST_SetSRID(ST_MakePoint($6, $7), 4326),
            $8, 20, 'active'
          ) RETURNING trip_id
        `, [
          driverId,
          hub.name, SJSU.name,
          hub.lng, hub.lat,
          SJSU.lng, SJSU.lat,
          departure,
        ]);

        tripIds.push(result.rows[0].trip_id);
      }
    }

    console.log(`  ✅ ${tripIds.length} benchmark trips created\n`);

    console.log('✅ Benchmark setup complete!\n');
    console.log('Riders:  benchmark-rider-01@sjsu.edu … benchmark-rider-20@sjsu.edu  (password: Password123)');
    console.log('Driver:  benchmark-driver@sjsu.edu                                  (password: benchmarkpass123)');
    console.log(`Trips:   ${tripIds.length} active trips → SJSU, 20 seats each, departing in 1–3 days\n`);

  } catch (err) {
    console.error('❌ Setup failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

setup().catch(console.error);
