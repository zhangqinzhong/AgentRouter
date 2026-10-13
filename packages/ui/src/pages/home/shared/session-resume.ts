import {profileOpenSurfaces} from '@/vendor/tokentracker/pages/SessionsPage';
export function managedSessionTargets(profiles:any[],session:{profileId?:string;host?:string}) {
 if(session.host||!session.profileId)return [];
 // Only the owning profile can reopen an isolated home. Never guess another
 // enabled profile when the original was removed or disabled.
 const profile=profiles.find(p=>p.enabled&&p.id===session.profileId);
 if(!profile)return [];
 return profileOpenSurfaces(profile).map(surface=>({id:`profile:${profile.id}:${surface}`,name:`${profile.name||profile.id} · ${surface}`,profileId:profile.id,surface}));
}
