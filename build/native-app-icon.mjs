import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync,rmSync,mkdtempSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {brand,root,syncBrand} from './brand.mjs';
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout||cmd+' failed');return r.stdout.trim();}
export function buildNativeAppIcon(){
 if(process.platform!=='darwin')return;
 const source=path.join(root,brand.composerIcon);
 const output=path.join(root,'packages/electron/dist/native-icon');rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});
 run('xcrun',['actool',source,'--compile',output,'--platform','macosx','--minimum-deployment-target','12.0','--app-icon',brand.name,'--output-partial-info-plist',path.join(output,'icon-info.plist'),'--output-format','human-readable-text']);
 const compiled=path.join(output,brand.name+'.icns');
 if(existsSync(compiled))copyFileSync(compiled,path.join(root,brand.macIcon));
 const developer=run('xcode-select',['-p']);
 const ictool=path.resolve(developer,'../Applications/Icon Composer.app/Contents/Executables/ictool');
 if(existsSync(ictool)){
  run(ictool,[source,'--export-image','--output-file',path.join(root,brand.sourceIcon),'--platform','macOS','--rendition','Default','--width','1024','--height','1024','--scale','1']);
  copyFileSync(path.join(root,brand.sourceIcon),path.join(root,brand.uiIcon));
 }else if(!existsSync(path.join(root,brand.macIcon))||!existsSync(path.join(root,brand.uiIcon))){
  throw Error('Icon Composer is required to export app icons');
 }
 run('sips',['-z','64','64',path.join(root,brand.uiIcon),'--out',path.join(root,brand.favicon)]);
 const tmp=mkdtempSync(path.join(os.tmpdir(),'ar-icon-ico-'));
 try{
  const pngFile=path.join(tmp,'256.png');run('sips',['-z','256','256',path.join(root,brand.uiIcon),'--out',pngFile]);const png=readFileSync(pngFile);const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);writeFileSync(path.join(root,'build/icon.ico'),Buffer.concat([header,png]));
 }finally{rmSync(tmp,{recursive:true,force:true});}
 syncBrand();
}
