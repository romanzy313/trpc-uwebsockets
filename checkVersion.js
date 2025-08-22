const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function normalizeVersion(version) {
  if (!version) return null;

  // Extract base version (remove canary suffix)
  const canaryMatch = version.match(/^(.+?)-canary\.\d+$/);
  return canaryMatch ? canaryMatch[1] : version;
}

// Main function
async function checkVersions() {
  try {
    const packageJsonPath = path.join(__dirname, 'package.json');

    // Check if package.json exists
    if (!fs.existsSync(packageJsonPath)) {
      console.error('❌ package.json not found in current directory');
      process.exit(1);
    }

    // Read package.json
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    const serverVersion = packageJson.dependencies['@trpc/server'];
    const clientVersion = packageJson.devDependencies['@trpc/client'];
    const packageVersion = normalizeVersion(packageJson.version);

    // check the canary prefix

    if (packageVersion !== serverVersion && packageVersion !== clientVersion) {
      console.error('   Package version mismatch!');
      console.error(
        `   Project: ${packageJson.version}; Normalized: ${packageVersion}`
      );
      console.error(`   @trpc/server: ${serverVersion}`);
      console.error(`   @trpc/client: ${clientVersion}`);
      process.exit(1);
    }

    console.log(` ✅ Version ${packageJson.version} check complete`);
  } catch (error) {
    console.error('❌ Error checking versions:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

checkVersions();
