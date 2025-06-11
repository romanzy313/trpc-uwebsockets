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

    console.log('🔍 Current versions:');
    console.log(`   Project: ${packageJson.version}`);
    console.log(`   @trpc/server: ${packageJson.dependencies['@trpc/server']}`);
    console.log(
      `   @trpc/client: ${packageJson.devDependencies['@trpc/client']}`
    );
    console.log('');

    // Get new version from user
    let newVersion;
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

    // Ask for confirmation
    console.log('');
    console.log('📝 Planned changes:');
    console.log(`   Project version: ${packageJson.version} → ${newVersion}`);
    console.log(
      `   @trpc/server: ${packageJson.dependencies['@trpc/server']} → ^${newVersion}`
    );
    console.log(
      `   @trpc/client: ${packageJson.devDependencies['@trpc/client']} → ^${newVersion}`
    );
    console.log('');

    const confirm = await promptUser('Proceed with these changes? (Y/n): ');

    if (confirm.toLowerCase() === 'n' && confirm.toLowerCase() === 'no') {
      console.log('❌ Operation cancelled.');
      rl.close();
      return;
    }

    // Update versions
    packageJson.version = newVersion;
    packageJson.dependencies['@trpc/server'] = `^${newVersion}`;
    packageJson.devDependencies['@trpc/client'] = `^${newVersion}`;

    // Write back to package.json with proper formatting
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(packageJson, null, 2) + '\n',
      'utf8'
    );

    console.log('');
    console.log('✅ Successfully updated package.json!');
    // console.log('');
    // console.log('📋 Next steps:');
    // console.log('   1. Review the changes: git diff package.json');
    // console.log('   2. Install updated dependencies: yarn install');
    // console.log('   3. Run tests: yarn test');
    // console.log(
    //   '   4. Commit changes: git add package.json && git commit -m "bump version to ' +
    //     newVersion +
    //     '"'
    // );
    // console.log('   5. Create git tag: git tag v' + newVersion);
  } catch (error) {
    console.error('❌ Error updating versions:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

updateVersions();
