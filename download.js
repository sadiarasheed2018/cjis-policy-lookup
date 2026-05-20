const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PDF_URL = 'https://le.fbi.gov/file-repository/cjis_security_policy_v6-0_20241227.pdf';
const OUTPUT_PATH = path.join(__dirname, 'cjis-policy.pdf');

async function download() {
  console.log('Downloading CJIS Security Policy v6.0...');
  console.log(`Source: ${PDF_URL}`);

  const response = await axios({
    method: 'GET',
    url: PDF_URL,
    responseType: 'stream',
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });

  const writer = fs.createWriteStream(OUTPUT_PATH);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      const size = fs.statSync(OUTPUT_PATH).size;
      console.log(`Saved to: ${OUTPUT_PATH}`);
      console.log(`File size: ${(size / 1024 / 1024).toFixed(1)} MB`);
      resolve();
    });
    writer.on('error', reject);
  });
}

download().catch(err => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
