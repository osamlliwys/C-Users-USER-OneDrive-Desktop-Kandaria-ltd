const bcrypt = require('bcryptjs');

const password = 'Kandaria2026';
const hash = bcrypt.hashSync(password, 10);

console.log('\n=== COPY THE SQL BELOW INTO SUPABASE SQL EDITOR ===\n');
console.log(`UPDATE users SET password = '${hash}' WHERE role IN ('landlord', 'accountant', 'caretaker');`);
console.log('\n=== LOGIN DETAILS ===');
console.log('Caretaker phone : 254700000003');
console.log('Landlord phone  : 254700000001');
console.log('Accountant phone: 254700000002');
console.log('Password for all: Kandaria2026');
console.log('');
