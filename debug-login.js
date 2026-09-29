require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const TEST_PHONE = '254700000003';
const TEST_PASSWORD = 'Kandaria2026';

async function debug() {
  console.log('\n--- ENV CHECK ---');
  console.log('HOST:', process.env.DB_HOST);
  console.log('PORT:', process.env.DB_PORT);
  console.log('USER:', process.env.DB_USER);
  console.log('PASS:', process.env.DB_PASSWORD ? '(set)' : '(NOT SET)');

  console.log('\n--- Step 1: Checking DB connection ---');
  const client = new Client({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const result = await client.query('SELECT NOW() as time');
    console.log('✅ DB connected:', result.rows[0].time);
  } catch (err) {
    console.error('❌ DB connection FAILED:', err.message);
    await client.end().catch(() => {});
    process.exit(1);
  }

  console.log('\n--- Step 2: Looking up user by phone ---');
  try {
    const result = await client.query(
      'SELECT id, full_name, role, password FROM users WHERE phone_number = $1',
      [TEST_PHONE]
    );
    if (result.rows.length === 0) {
      console.error('❌ No user found with phone:', TEST_PHONE);
      await client.end();
      process.exit(1);
    }
    const user = result.rows[0];
    console.log('✅ User found:', user.full_name, '| Role:', user.role);

    console.log('\n--- Step 3: Checking role ---');
    const roleOk = ['caretaker', 'landlord', 'accountant'].includes(user.role);
    if (!roleOk) {
      console.error('❌ Role is:', user.role, '— not allowed for caretaker login');
    } else {
      console.log('✅ Role OK:', user.role);
    }

    console.log('\n--- Step 4: Password check ---');
    if (!user.password) {
      console.error('❌ Password is NULL in DB');
      await client.end();
      process.exit(1);
    }
    const match = await bcrypt.compare(TEST_PASSWORD, user.password);
    if (match) {
      console.log('✅ Password matches! Login should work.');
    } else {
      console.error('❌ Password does NOT match.');
      const newHash = bcrypt.hashSync(TEST_PASSWORD, 10);
      console.log('\nRun this in Supabase SQL Editor:');
      console.log(`UPDATE users SET password = '${newHash}' WHERE phone_number = '${TEST_PHONE}';`);
    }
  } catch (err) {
    console.error('❌ Query error:', err.message);
  }

  await client.end();
  process.exit(0);
}

debug();
