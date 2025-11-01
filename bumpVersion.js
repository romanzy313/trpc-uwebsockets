const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Function to validate semver format
function isValidSemver(version) {
  const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
  return semverRegex.test(version);
}

// Function to prompt user for input
function promptUser(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

// Main function
async function updateVersions() {
  try {
    const packageJsonPath = path.join(__dirname, 'package.json');

    // Check if package.json exists
    if (!fs.existsSync(packageJsonPath)) {
      console.error('❌ package.json not found in current directory');
      process.exit(1);
    }

    // Read package.json
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const projectVersion = packageJson.version;
    const serverVersion = packageJson.dependencies['@trpc/server'];
    const clientVersion = packageJson.devDependencies['@trpc/client'];

    console.log('🔍 Current versions:');
    console.log(`   Project: ${projectVersion}`);
    console.log(`   @trpc/server: ${serverVersion}`);
    console.log(`   @trpc/client: ${clientVersion}`);
    console.log('');

    // Get new version from user
    let newVersion = null;

    if (serverVersion === clientVersion && serverVersion !== projectVersion) {
      console.log(`Detected update. Bump project version to ${serverVersion}?`);

      const confirm = await promptUser('Confirm (y/N): ');
      if (confirm.toLowerCase() === 'y') {
        newVersion = serverVersion;
      } else {
        console.log('Using manual updating.');
      }
    }

    if (!newVersion) {
      while (true) {
        newVersion = await promptUser('Enter new version (e.g., 11.3.0): ');

        if (!newVersion) {
          console.log(
            '❌ Version cannot be empty. Please enter a valid version.'
          );
          continue;
        }

        if (!isValidSemver(newVersion)) {
          console.log(
            '❌ Invalid version format. Please use semantic versioning (e.g., 1.2.3).'
          );
          continue;
        }

        break;
      }
    }
    // Ask for confirmation
    console.log('');
    console.log('📝 Planned changes:');
    console.log(`   Project version: ${projectVersion} → ${newVersion}`);
    console.log(`   @trpc/server: ${serverVersion} → ${newVersion}`);
    console.log(`   @trpc/client: ${clientVersion} → ${newVersion}`);
    console.log('');

    const confirm = await promptUser('Proceed with these changes? (Y/n): ');

    if (confirm.toLowerCase() === 'n' && confirm.toLowerCase() === 'no') {
      console.log('❌ Operation cancelled.');
      rl.close();
      return;
    }

    // Update versions
    packageJson.version = newVersion;
    packageJson.dependencies['@trpc/server'] = `${newVersion}`;
    packageJson.devDependencies['@trpc/client'] = `${newVersion}`;

    // Write back to package.json with proper formatting
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(packageJson, null, 2) + '\n',
      'utf8'
    );

    console.log('');
    console.log('✅ Successfully updated package.json!');
  } catch (error) {
    console.error('❌ Error updating versions:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

updateVersions();
