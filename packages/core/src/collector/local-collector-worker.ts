import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const {createCollector} = createRequire(__filename)("./tokentracker/collector.cjs");
let fetchId=0;
const fetches=new Map<number,{resolve:(response:Response)=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
// Delegate network transport to the host's proxy-aware fetch. The worker never
// opens the app configuration database or initializes gateway authentication.
const fetchFromHost:typeof fetch=async(input,init={})=>new Promise<Response>((resolve,reject)=>{
  const id=++fetchId;
  const abort=()=>{fetches.delete(id);parentPort?.postMessage({abortFetchId:id});reject(new Error("Request aborted"));};
  if(init.signal?.aborted){reject(new Error("Request aborted"));return;}
  init.signal?.addEventListener("abort",abort,{once:true});
  const cleanup=()=>init.signal?.removeEventListener("abort",abort);
  fetches.set(id,{resolve,reject,cleanup});
  const {signal:_,...options}=init;
  parentPort?.postMessage({fetchId:id,url:String(input),init:{...options,headers:Object.fromEntries(new Headers(init.headers))}});
});
const collector = createCollector({fetchImpl:fetchFromHost});
parentPort?.on("message", async (message) => {
  if(message.fetchId) {
    const request=fetches.get(message.fetchId);if(!request)return;fetches.delete(message.fetchId);request.cleanup();
    if(message.error)request.reject(new Error(message.error));
    else request.resolve(new Response([204,205,304].includes(message.status)?null:message.body,{status:message.status,headers:message.headers}));
    return;
  }
  const {id,path,query}=message;
  try { parentPort?.postMessage({id,data:await collector.query(path,query)}); }
  catch(error) { parentPort?.postMessage({id,error:error instanceof Error ? error.message : "Local data unavailable"}); }
});
