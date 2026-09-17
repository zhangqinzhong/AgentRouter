import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,cpSync,rmSync,readFileSync,chmodSync,readdirSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {brand,root,syncBrand} from './brand.mjs';
export function buildNativeWidget(){
 if(process.platform!=='darwin')return;
 syncBrand();
 const folder=path.join(root,'native/AgentRouterWidget');
 const version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
 const spec={name:'AgentRouterWidget',options:{deploymentTarget:{macOS:'14.0'}},settings:{base:{SWIFT_VERSION:'5.9',MACOSX_DEPLOYMENT_TARGET:'14.0'}},targets:{AgentRouterWidget:{type:'app-extension',platform:'macOS',sources:[{path:'Sources'},{path:'../AgentRouterTray/Sources/AgentRouterTray/Upstream/Shared'}],settings:{base:{PRODUCT_BUNDLE_IDENTIFIER:brand.appId+'.widget',PRODUCT_NAME:'AgentRouterWidget',MARKETING_VERSION:version,CURRENT_PROJECT_VERSION:'1',CODE_SIGN_ENTITLEMENTS:'Widget.entitlements',CODE_SIGN_STYLE:'Manual',CODE_SIGN_IDENTITY:'-',ENABLE_APP_SANDBOX:'YES',SKIP_INSTALL:'YES',APPLICATION_EXTENSION_API_ONLY:'YES',GENERATE_INFOPLIST_FILE:'YES',LD_RUNPATH_SEARCH_PATHS:['$(inherited)','@executable_path/../Frameworks','@executable_path/../../../../Frameworks']}},info:{path:'.generated/Info.plist',properties:{CFBundleDisplayName:brand.name,CFBundleShortVersionString:version,CFBundleVersion:'1',NSExtension:{NSExtensionPointIdentifier:'com.apple.widgetkit-extension'}}}}}};
 const specFile=path.join(folder,'.generated/project.json');mkdirSync(path.dirname(specFile),{recursive:true});writeFileSync(specFile,JSON.stringify(spec,null,2));
 function run(cmd,args){const r=spawnSync(cmd,args,{cwd:folder,stdio:'inherit'});if(r.status!==0)throw Error('Widget build failed: '+cmd);}
 run('xcodegen',['generate','--spec',specFile,'--project',folder,'--project-root',folder]);
 const derived=path.join(folder,'.build');
 run('xcodebuild',['-project','AgentRouterWidget.xcodeproj','-scheme','AgentRouterWidget','-configuration','Release','-derivedDataPath',derived,'-destination','generic/platform=macOS','ARCHS=arm64 x86_64','ONLY_ACTIVE_ARCH=NO','CODE_SIGNING_ALLOWED=NO','build']);
 const out=path.join(root,'packages/electron/dist/widgets');rmSync(out,{recursive:true,force:true});mkdirSync(out,{recursive:true});
 cpSync(path.join(derived,'Build/Products/Release/AgentRouterWidget.appex'),path.join(out,'AgentRouterWidget.appex'),{recursive:true});
 makeWritable(out);
}

function makeWritable(directory) {
 for (const entry of readdirSync(directory)) {
  const file = path.join(directory, entry);
  const stat = lstatSync(file);
  if (stat.isDirectory()) makeWritable(file);
  chmodSync(file, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
 }
}
