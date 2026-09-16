export async function getSessions({refresh=false,from,to,limit}={}) {
  const api=typeof window==="undefined"?undefined:window.agentrouter;
  if(!api?.getLocalUsageSessions){
    throw new Error("Local session data is unavailable.");
  }
  return api.getLocalUsageSessions({refresh:Boolean(refresh),from,to,limit});
}
