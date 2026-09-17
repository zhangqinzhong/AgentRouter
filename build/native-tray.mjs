import {brand,syncBrand} from "./brand.mjs";
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, copyFileSync, cpSync, readdirSync, chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';
export function buildNativeTray() {
 if (process.platform !== 'darwin') return;
 syncBrand();
 const root = path.resolve(import.meta.dirname, '..');
 const args = ['build', '--package-path', path.join(root, 'native/AgentRouterTray'), '-c', 'release', '--arch', 'arm64', '--arch', 'x86_64'];
 const built = spawnSync('swift', args, { stdio: 'inherit' });
 if (built.status !== 0) throw new Error('Native menu bar build failed');
 const bin = spawnSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' });
 if (bin.status !== 0) throw new Error('Native menu bar output missing');
 const out = path.join(root, 'packages/electron/dist/main/native');
 rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
 copyFileSync(path.join(bin.stdout.trim(), 'AgentRouterTray'),path.join(out,'AgentRouterTray'));
 for(const file of readdirSync(bin.stdout.trim()).filter(f=>f.endsWith('.bundle'))) cpSync(path.join(bin.stdout.trim(),file),path.join(out,file),{recursive:true});
 makeWritable(out);
 for (const suffix of ['', '@2x', '@3x']) copyFileSync(path.join(root,`packages/electron/assets/tray-layeredTemplate${suffix}.png`),path.join(out,`tray-layeredTemplate${suffix}.png`));
 copyFileSync(path.join(root,'native/AgentRouterTray/.build/checkouts/Vortex/LICENSE'),path.join(out,'LICENSE-Vortex'));
 copyFileSync(path.join(root,brand.macIcon),path.join(out,brand.nativeIconName));
 copyFileSync(path.join(root,'native/AgentRouterTray/LICENSE-TokenTracker'),path.join(out,'LICENSE-TokenTracker'));
}

function makeWritable(directory) {
 for (const entry of readdirSync(directory)) {
  const file = path.join(directory, entry);
  const mode = lstatSync(file).mode;
  if (lstatSync(file).isDirectory()) makeWritable(file);
  chmodSync(file, mode | (lstatSync(file).isDirectory() ? 0o700 : 0o600));
 }
}
