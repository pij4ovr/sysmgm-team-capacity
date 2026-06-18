// Automates the release process: bump package.json version, commit, push,
// build the portable .exe, tag, and publish a GitHub release with the .exe
// attached. Replaces the manual multi-step sequence used for v1.0.0-v1.4.3.
//
// Usage:
//   npm run release -- <version> [--message "short summary"] [--notes-file path.md]
//
// Examples:
//   npm run release -- 1.5.0
//   npm run release -- 1.5.0 --message "Fix X, add Y"
//   npm run release -- 1.5.0 --notes-file release-notes.md
//
// If neither --message nor --notes-file is given, a minimal default note
// ("Release vX.Y.Z") is used for both the commit and the GitHub release.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function run(cmd) {
  console.log('> ' + cmd);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function usage() {
  console.error('Usage: npm run release -- <version> [--message "short summary"] [--notes-file path.md]');
  console.error('Example: npm run release -- 1.5.0 --message "Fix X, add Y"');
}

const args = process.argv.slice(2);
const version = args[0];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  usage();
  process.exit(1);
}

let notesFile = null, message = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--notes-file') notesFile = args[++i];
  else if (args[i] === '--message') message = args[++i];
}

const tag = 'v' + version;

// 1. Bump package.json
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Bumped package.json version -> ${version}`);

// 2. Commit + push whatever is currently pending, including the bump
const commitMsg = message || `Release ${tag}`;
const commitMsgFile = path.join(ROOT, '.release-commit-msg.tmp');
fs.writeFileSync(commitMsgFile, commitMsg + '\n');
run('git add -A');
let hasStagedChanges = true;
try { execSync('git diff --cached --quiet', { cwd: ROOT }); hasStagedChanges = false; } catch {}
if (hasStagedChanges) {
  run(`git commit -F "${commitMsgFile}"`);
} else {
  console.log('Nothing to commit (working tree already matches the bumped version).');
}
fs.unlinkSync(commitMsgFile);
run('git push');

// 3. Build the portable .exe
console.log('Building the .exe (this can take a minute)...');
run('npm run dist');

const exeRelPath = path.join('dist', `Team Capacity Calculator ${version}.exe`);
if (!fs.existsSync(path.join(ROOT, exeRelPath))) {
  console.error('Build did not produce the expected file: ' + exeRelPath);
  process.exit(1);
}

// 4. Tag and push the tag
run(`git tag -a ${tag} -m "${tag} release"`);
run(`git push origin ${tag}`);

// 5. Publish the GitHub release with the .exe attached
let releaseNotesFile = notesFile, cleanupNotes = false;
if (!releaseNotesFile) {
  releaseNotesFile = path.join(ROOT, '.release-notes.tmp.md');
  fs.writeFileSync(releaseNotesFile, `## ${tag}\n\n${commitMsg}\n`);
  cleanupNotes = true;
}
run(`gh release create ${tag} "${exeRelPath}" --title "${tag}" --notes-file "${releaseNotesFile}"`);
if (cleanupNotes) fs.unlinkSync(releaseNotesFile);

let repoUrl = null;
try { repoUrl = execSync('git remote get-url origin', { cwd: ROOT }).toString().trim().replace(/\.git$/, ''); } catch {}
console.log(`\nDone! Released ${tag}` + (repoUrl ? `: ${repoUrl}/releases/tag/${tag}` : ''));
