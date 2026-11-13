import { readFileSync } from 'node:fs';

const tag = process.env.RELEASE_TAG;
if (!tag?.startsWith('v') || tag.length === 1) {
  throw new Error('Release tags must start with v, for example v0.1.0.');
}
const version = tag.slice(1);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8');
const cargoPackage = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
const lock = json('package-lock.json');
const versions = {
  'package.json': json('package.json').version,
  'package-lock.json': lock.version,
  'package-lock.json (root package)': lock.packages?.['']?.version,
  'src-tauri/tauri.conf.json': json('src-tauri/tauri.conf.json').version,
  'src-tauri/Cargo.toml': cargoPackage?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1],
};
for (const [path, actual] of Object.entries(versions)) {
  if (actual !== version) {
    throw new Error(
      path + ': version ' + (actual ?? '(missing)') + ' does not match tag ' + tag + '.',
    );
  }
}
console.log('Release ' + tag + ': all project versions match.');
