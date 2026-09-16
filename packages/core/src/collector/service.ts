import { Worker } from "node:worker_threads";
import path from "node:path";
import { fetchWithSystemProxy } from "@agentrouter/core/proxy/system-proxy-fetch";
let worker: Worker | undefined;
let nextId=0;
const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
export function queryLocalCollector(endpoint:string, query:Record<string,string>={}):Promise<unknown> {
  if(!worker) {
    const current=new Worker(path.join(__dirname,"local-collector-worker.js"));worker=current;
    current.unref();
    const requests=new Map<number,AbortController>();
    current.on("message", async (message)=>{
      if(message.abortFetchId){requests.get(message.abortFetchId)?.abort();return;}
      if(message.fetchId){
        const controller=new AbortController();requests.set(message.fetchId,controller);
        const timeout=setTimeout(()=>controller.abort(),20000);
        try{const response=await fetchWithSystemProxy(message.url,{...message.init,signal:controller.signal});const body=new Uint8Array(await response.arrayBuffer());if(worker===current)current.postMessage({fetchId:message.fetchId,status:response.status,headers:Object.fromEntries(response.headers),body});}
        catch(error){if(worker===current)current.postMessage({fetchId:message.fetchId,error:error instanceof Error?error.message:"Provider request failed"});}
        finally{clearTimeout(timeout);requests.delete(message.fetchId);}
        return;
      }
      const {id,data,error}=message;const request=pending.get(id);if(!request)return;pending.delete(id);clearTimeout(request.timer);if(error)request.reject(new Error(error));else request.resolve(data);if(!pending.size)current.unref();});
    const fail=(error:Error)=>{if(worker!==current)return;worker=undefined;for(const controller of requests.values())controller.abort();requests.clear();for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}pending.clear();};
    current.on("error",fail);current.on("exit",code=>fail(new Error(`Local collector exited (${code})`)));
  }
  return new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>{pending.delete(id);if(!pending.size)worker?.unref();reject(new Error("Local collection timed out"));},180000);pending.set(id,{resolve,reject,timer});worker!.ref();worker!.postMessage({id,path:endpoint,query});});
}
