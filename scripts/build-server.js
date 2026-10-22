'use strict';
// Builds dist/PumpfunBotServer.exe: esbuild bundle -> Node single executable application.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const build = path.join(root, 'build', 'server');
const dist = path.join(root, 'dist');
const exe = path.join(dist, 'PumpfunBotServer.exe');
const version = require('../package.json').version;

fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

console.log('• bundling');
require('esbuild').buildSync({
  entryPoints: [path.join(root, 'server', 'index.js')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(build, 'bundle.cjs'),
  external: ['bufferutil', 'utf-8-validate'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
});

console.log('• preparing SEA blob');
const seaConfig = path.join(build, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(build, 'bundle.cjs'),
  output: path.join(build, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

console.log('• stamping executable');
fs.copyFileSync(process.execPath, exe);
const rcedit = path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
execFileSync(rcedit, [exe,
  '--set-icon', path.join(root, 'assets', 'server-icon.ico'),
  '--set-file-version', version,
  '--set-product-version', version,
  '--set-version-string', 'ProductName', 'Pumpfun Bot Server',
  '--set-version-string', 'FileDescription', 'Pumpfun Bot Server',
  '--set-version-string', 'CompanyName', 'Pumpfun Bot',
  '--set-version-string', 'LegalCopyright', 'MIT License',
  '--set-version-string', 'OriginalFilename', 'PumpfunBotServer.exe',
  '--set-version-string', 'InternalName', 'PumpfunBotServer',
], { stdio: 'inherit' });

console.log('• injecting app');
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [postject, exe, 'NODE_SEA_BLOB', path.join(build, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'], { stdio: 'inherit' });

const mb = (fs.statSync(exe).size / 1048576).toFixed(1);
console.log(`✓ ${path.relative(root, exe)} (${mb} MB)`);
