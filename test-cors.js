// Simple test to verify CORS headers
async function testCORS() {
  const response = await fetch('https://revenueforge-api.pronitopenclaw.workers.dev/api/products', {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://revenueforge.pages.dev',
      'Access-Control-Request-Method': 'GET',
    }
  });
  
  console.log('Status:', response.status);
  console.log('CORS Headers:');
  for (const [key, value] of response.headers.entries()) {
    if (key.startsWith('access-control')) {
      console.log(`  ${key}: ${value}`);
    }
  }
}

testCORS().catch(console.error);
