import {buildNativeAppIcon} from './native-app-icon.mjs';
if(process.platform!=='darwin')throw Error('Generate native app icons on macOS with Xcode installed');
buildNativeAppIcon();
console.log('App icons generated from the Icon Composer document.');
