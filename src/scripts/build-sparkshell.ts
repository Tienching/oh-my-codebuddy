import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');
const nativeRoot = join(projectRoot, 'crates', 'omb-sparkshell');
const manifestPath = process.env.OMB_SPARKSHELL_MANIFEST ?? process.env.OMB_SPARKSHELL_MANIFEST ?? join(nativeRoot, 'Cargo.toml');
const builtBinaryName = platform() === 'win32' ? 'omb-sparkshell.exe' : 'omb-sparkshell';
const packagedBinaryName = builtBinaryName;
const releaseBinaryPath = join(projectRoot, 'target', 'release', builtBinaryName);
const stageDirOverride = process.env.OMB_SPARKSHELL_STAGE_DIR ?? process.env.OMB_SPARKSHELL_STAGE_DIR;
const stagedBinaryRoot = stageDirOverride
  ? join(stageDirOverride, `${platform()}-${arch()}`)
  : join(projectRoot, 'bin', 'native', `${platform()}-${arch()}`);
const packagedBinaryDir = stagedBinaryRoot;
const packagedBinaryPath = join(packagedBinaryDir, packagedBinaryName);
const extraArgs = process.argv.slice(2);
const args = ['build', '--manifest-path', manifestPath, '--release', ...extraArgs];

if (!existsSync(manifestPath)) {
  console.error(`omb sparkshell build: missing Rust manifest at ${manifestPath}`);
  process.exit(1);
}

const result = spawnSync('cargo', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`omb sparkshell build: failed to launch cargo: ${result.error.message}`);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(releaseBinaryPath)) {
  console.error(`omb sparkshell build: expected release binary at ${releaseBinaryPath}`);
  process.exit(1);
}

mkdirSync(packagedBinaryDir, { recursive: true });
copyFileSync(releaseBinaryPath, packagedBinaryPath);
if (platform() !== 'win32') {
  chmodSync(packagedBinaryPath, 0o755);
}
console.log(`omb sparkshell build: staged native binary at ${packagedBinaryPath}`);
