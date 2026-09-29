require('dotenv').config();
const pg = require('pg');
const dns = require('dns');

// Force IPv4 to avoid IPv6 connectivity issues
dns.setDefaultResultOrder('ipv4first');

async function tryConnect() {
  const client = new pg.Client({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl:      { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });

  console.log('Connecting to:', process.env.DB_HOST + ':' + process.env.DB_PORT, 'as', process.env.DB_USER);

  try {
    await client.connect();
    const r = await client.query('SELECT NOW() as time');
    console.log('Connected! Server time:', r.rows[0].time);
    await client.end();
    process.exit(0);
  } catch (err) {
    console.error('Connection FAILED:', err.message);
    await client.end().catch(() => {});
    process.exit(1);
  }
}

tryConnect();
