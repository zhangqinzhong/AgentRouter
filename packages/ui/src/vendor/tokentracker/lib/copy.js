import {setNumberLocale} from '../../../lib/number-format.js';
import data from '../copy-data.json';

function initialUsageLocale(){
  if(typeof window==='undefined')return 'zh';
  try{
    const preference=window.localStorage?.getItem('ar.ui.language');
    if(preference==='en'||preference==='zh')return preference;
  }catch{}
  const languages=typeof navigator!=='undefined'&&navigator.languages?.length?navigator.languages:[navigator?.language];
  return languages?.some((language)=>String(language||'').toLowerCase().startsWith('zh'))?'zh':'en';
}

let locale=initialUsageLocale();
setNumberLocale(locale);
export function setUsageLocale(value){locale=value==='en'?'en':'zh';setNumberLocale(locale);}
export function getCopyLocale(){return locale==='zh'?'zh-CN':'en';}
export function copy(key,values={}){let text=data[locale][key]??data.en[key]??key;return String(text).replace(/\{\{(\w+)\}\}/g,(_,name)=>String(values[name]??''));}
