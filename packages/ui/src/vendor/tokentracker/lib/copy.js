import data from '../copy-data.json';
let locale='zh';
export function setUsageLocale(value){locale=value==='en'?'en':'zh';}
export function getCopyLocale(){return locale==='zh'?'zh-CN':'en';}
export function copy(key,values={}){let text=data[locale][key]??data.en[key]??key;return String(text).replace(/\{\{(\w+)\}\}/g,(_,name)=>String(values[name]??''));}
