import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../native/AgentRouterTray');
const hashes=JSON.parse(readFileSync(path.join(root,'upstream-files.json')));
const sha=s=>createHash('sha256').update(s).digest('hex');
const files=['ClawdCompanionView','ActivityHeatmapView','SummaryCardsView','UsageTrendChart','TopModelsView','FooterView','PeriodPickerView','UsageLimitBar','LimitsSettingsView'];
for(const name of files){const file=`Views/${name}.swift`;assert.equal(sha(readFileSync(path.join(root,'Sources/AgentRouterTray/Upstream',file),'utf8').replaceAll('Bundle.module.resourceURL?', 'Bundle.main.resourceURL?').replaceAll('.appendingPathComponent("\\(filename)")', '.appendingPathComponent("EmbeddedServer/tokentracker/dashboard/dist/brand-logos/\\(filename)")')),hashes[file],`${name} drifted from upstream`);}
const s=readFileSync(path.join(root,'Sources/AgentRouterTray/Upstream/Services/StatusBarController.swift'),'utf8');
const expected=JSON.parse(readFileSync(path.join(root,'upstream-interactions.json')));
for(const [name,hash] of Object.entries(expected)){const a=s.indexOf(`func ${name}(`);let i=s.indexOf('{',a)+1,depth=1;while(depth){if(s[i]==='{')depth++;else if(s[i]==='}')depth--;i++;}assert.equal(sha(s.slice(a,i).replaceAll("AgentRouter v", "TokenTracker v")),hash,`${name} interaction drifted`);}
console.log(`Verified ${files.length} unchanged view files and ${Object.keys(expected).length} unchanged interaction functions.`);
