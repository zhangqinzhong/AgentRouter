import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const project = process.cwd();
function fixture(version = '0.1.1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-publisher-'));
  const tag = `v${version}`, artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(path.join(root, 'bin')); fs.mkdirSync(path.join(root, 'build')); fs.mkdirSync(path.join(root, 'docs/releases'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, `docs/releases/${version}.md`), 'Fixture release');
  fs.copyFileSync(path.join(project, 'build/merge-macos-update-metadata.mjs'), path.join(root, 'build/merge-macos-update-metadata.mjs'));
  fs.symlinkSync(path.join(project, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const make = (platform, names, metadata) => {
    const dir = path.join(artifacts, platform); fs.mkdirSync(dir, { recursive: true });
    const files = names.map(name => { const bytes = Buffer.from(name); fs.writeFileSync(path.join(dir, name), bytes); return { url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }; });
    fs.writeFileSync(path.join(dir, metadata), yaml.dump({ version, files, path: files[0].url, sha512: files[0].sha512 }));
  };
  make('arm64', [`AgentRouter_${version}-mac-Apple-Silicon-arm64.zip`, `AgentRouter_${version}-mac-Apple-Silicon-arm64.dmg`], 'latest-mac.yml');
  make('x64', [`AgentRouter_${version}-mac-Intel-x64.zip`, `AgentRouter_${version}-mac-Intel-x64.dmg`], 'latest-mac.yml');
  make('windows', [`AgentRouter_${version}.exe`], 'latest.yml');
  make('linux', [`AgentRouter_${version}.AppImage`], 'latest-linux.yml');
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ uploads: 0, edits: 0 }));
  fs.writeFileSync(path.join(root, 'bin/gh'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const file=process.env.AR_TEST_GH_STATE,s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2);
const save=()=>fs.writeFileSync(file,JSON.stringify(s));
const fail=()=>{process.stderr.write('release not found');process.exit(1)};
if(a[0]==='release'&&a[1]==='view'){if(!s.release)fail();console.log('https://api.github.com/repos/fixture/release/releases/42');}
else if(a[0]==='api'){if(!s.release||a[1].includes('/tags/'))fail();console.log(JSON.stringify(s.release));}
else if(a[0]==='release'&&a[1]==='create'){s.release={id:42,draft:true,prerelease:a.includes('--prerelease'),assets:[]};save();}
else if(a[0]==='release'&&a[1]==='upload'){s.uploads++;s.uploadedNames=a.slice(a.indexOf('--clobber')+1).map(p=>path.basename(p));const fresh=a.slice(a.indexOf('--clobber')+1).map(p=>{const b=fs.readFileSync(p);return {name:path.basename(p),size:b.length,digest:'sha256:'+crypto.createHash('sha256').update(b).digest('hex')}});s.release.assets=[...new Map([...s.release.assets,...fresh].map(a=>[a.name,a])).values()];if(s.tamper)s.release.assets[0].digest='sha256:bad';save();}
else if(a[0]==='release'&&a[1]==='edit'){s.edits++;s.release.draft=false;s.release.prerelease=a.includes('--prerelease=true');s.latest=a.includes('--latest=true');save();}
else {process.stderr.write('Unexpected gh invocation: '+a.join(' '));process.exit(2)}
`, { mode: 0o755 });
  const env = { ...process.env, GITHUB_REPOSITORY: 'fixture/release', AR_TEST_GH_STATE: stateFile, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config') };
  const git = args => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  git(['init','-q']); git(['config','user.name','Fixture']); git(['config','user.email','fixture@example.invalid']); git(['add','package.json']); git(['commit','--no-gpg-sign','-qm','fixture']); git(['tag',tag]);
  return { root, stateFile, run: () => spawnSync(process.execPath, [path.join(project, 'build/publish-release.mjs'), artifacts], { cwd: root, env, encoding: 'utf8' }), state: () => JSON.parse(fs.readFileSync(stateFile)), write: value => fs.writeFileSync(stateFile, JSON.stringify(value)), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('publisher creates a draft, validates uploaded digests, publishes, and reruns without overwriting', { skip: process.platform === 'win32' }, () => {
  const f = fixture(); try {
    const first = f.run(); assert.equal(first.status, 0, first.stderr);
    assert.equal(f.state().release.draft, false); assert.equal(f.state().uploads, 1); assert.equal(f.state().edits, 1);
    assert.ok(f.state().release.assets.some(a => a.name === 'SHA256SUMS')); assert.equal(f.state().latest, true);
    const published = f.state(); published.release.draft = true; f.write(published);
    const resumed = f.run(); assert.equal(resumed.status, 0, resumed.stderr); assert.equal(f.state().uploads, 1); assert.equal(f.state().edits, 2);
    const again = f.run(); assert.equal(again.status, 0, again.stderr); assert.equal(f.state().uploads, 1); assert.equal(f.state().edits, 2);
  } finally { f.close(); }
});
test('publisher resumes an existing draft through its numeric release ID', { skip: process.platform === 'win32' }, () => {
  const f = fixture(); try {
    f.write({ uploads: 0, edits: 0, release: { id: 42, draft: true, prerelease: false, assets: [] } });
    const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.equal(f.state().release.draft, false);
  } finally { f.close(); }
});
test('publisher leaves mismatched uploads in draft and never overwrites a published mismatch', { skip: process.platform === 'win32' }, () => {
  const f = fixture(); try {
    f.write({ uploads: 0, edits: 0, tamper: true });
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Published asset verification failed/); assert.equal(f.state().release.draft, true); assert.equal(f.state().edits, 0);
    const state = f.state(); state.release.draft = false; f.write(state);
    const again = f.run(); assert.notEqual(again.status, 0); assert.equal(f.state().uploads, 1); assert.equal(f.state().edits, 0);
  } finally { f.close(); }
});

test('candidate publication stays outside the stable latest channel', { skip: process.platform === 'win32' }, () => {
  const f = fixture('0.1.1-rc.1'); try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.equal(f.state().release.prerelease, true); assert.equal(f.state().latest, false);
  } finally { f.close(); }
});
test('missing platform artifacts prevent draft creation and uploads', { skip: process.platform === 'win32' }, () => {
  const f = fixture(); try {
    fs.rmSync(path.join(f.root, 'artifacts/windows/AgentRouter_0.1.1.exe'));
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Missing release platform artifact/); assert.equal(f.state().release, undefined); assert.equal(f.state().uploads, 0);
  } finally { f.close(); }
});

test('publisher repairs only missing or changed draft assets', { skip: process.platform === 'win32' }, () => {
  const f = fixture(); try {
    assert.equal(f.run().status, 0);
    const state = f.state(), retained = state.release.assets.slice(0, 2).map(a => a.name), count = state.release.assets.length;
    state.release.draft = true; state.release.assets = state.release.assets.slice(0, 2); state.uploads = 0; state.edits = 0; f.write(state);
    const result = f.run(); assert.equal(result.status, 0, result.stderr); assert.equal(f.state().release.assets.length, count); assert.equal(f.state().uploads, 1); assert.ok(f.state().uploadedNames.every(name => !retained.includes(name)));
  } finally { f.close(); }
});
