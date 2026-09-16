import {copy} from './copy';
export const isOtherModel=name=>!name||['unknown','unknow','unknown model'].includes(String(name).trim().toLowerCase());
export const modelDisplayName=name=>isOtherModel(name)?copy('usage.model.other'):name;
export const compareOtherLast=(a,b)=>Number(isOtherModel(a.name))-Number(isOtherModel(b.name));
