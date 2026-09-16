const {execFileSync}=require('node:child_process');
function localIdentity(){
 if(process.platform!=='darwin')return null;
 if(process.env.CSC_NAME)return {identity:process.env.CSC_NAME,type:process.env.CSC_NAME.startsWith('Apple Development:')?'development':'distribution'};
 try{const output=execFileSync('/usr/bin/security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'});const entries=[...output.matchAll(/"(Developer ID Application:[^"]+|Apple Development:[^"]+)"/g)].map(m=>m[1]);const name=entries.find(n=>n.startsWith('Developer ID Application:'))||entries[0];return name?{identity:name,type:name.startsWith('Apple Development:')?'development':'distribution'}:null;}catch{return null;}
}
const signing=localIdentity();
const baseConfig = require("../electron-builder.json");

const config = {
  ...baseConfig,
  directories: {
    ...baseConfig.directories,
    output: "release-local"
  },
  mac: {
    ...baseConfig.mac,
    identity: signing?.identity||"-",
    type: signing?.type||"distribution",
    notarize: false,
    forceCodeSigning: false
  }
};

delete config.afterSign;

module.exports = config;
