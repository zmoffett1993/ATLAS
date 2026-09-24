/* Identity is an account UUID. Names are display snapshots, never permissions. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.atlasRoutingAssignment = api;
})(typeof window === 'undefined' ? null : window, () => {
  'use strict';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const vehicles = Object.freeze({box_truck:'Box Truck',van_1:'Cargo Van 1',van_2:'Cargo Van 2'});
  const legacyVehicles = {truck:'box_truck',van1:'van_1',van2:'van_2'};
  const schedules = Object.freeze({standard:{start:360,departure:390,end:900,afterFinalReturn:true},relief:{start:480,departure:510,end:1020,afterFinalReturn:false}});
  function validate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['driverUserId','driverName','vehicleId','scheduleId'].includes(k)) ||
      !uuid.test(value.driverUserId || '') || typeof value.driverName !== 'string' || !value.driverName.trim() || value.driverName.length>160 ||
      !Object.hasOwn(vehicles,value.vehicleId) || (value.scheduleId!==undefined && !Object.hasOwn(schedules,value.scheduleId))) throw Error('Review the driver account, vehicle and planning schedule.');
    return {driverUserId:value.driverUserId.toLowerCase(),driverName:value.driverName,vehicleId:value.vehicleId,scheduleId:value.scheduleId || 'standard'};
  }
  function read(value) {
    if(typeof value !== 'string')return validate(value);
    const match=/^(Bubba|Achmad):(truck|van1|van2)$/.exec(value);
    if(!match)throw Error('Review the legacy driver assignment.');
    return {driverUserId:null,driverName:match[1],vehicleId:legacyVehicles[match[2]],scheduleId:match[1]==='Achmad'?'relief':'standard',legacy:true};
  }
  function resolve(value,candidates) {
    const assignment=read(value);
    if(!assignment.legacy)return assignment;
    const matches=candidates.filter(c=>c.displayName.trim().toLowerCase()===assignment.driverName.toLowerCase() && !c.testAccount);
    if(matches.length!==1)return {...assignment,needsReview:true};
    return validate({driverUserId:matches[0].userId,driverName:matches[0].displayName,vehicleId:assignment.vehicleId,scheduleId:assignment.scheduleId});
  }
  function legacy(value) {
    const a=read(value); return `${a.scheduleId==='relief'?'Achmad':'Bubba'}:${Object.keys(legacyVehicles).find(k=>legacyVehicles[k]===a.vehicleId)}`;
  }
  function load(value) {
    const a=read(value), vehicleId=Object.keys(legacyVehicles).find(k=>legacyVehicles[k]===a.vehicleId);
    return {driver:a.driverName,driverUserId:a.driverUserId,scheduleId:a.scheduleId,vehicleId,vehicle:vehicleId==='truck'?'truck':'van'};
  }
  function sorted(candidates) {
    const seen=new Set();
    return candidates.filter(c=>uuid.test(c.userId||'') && !seen.has(c.userId.toLowerCase()) && seen.add(c.userId.toLowerCase()))
      .sort((a,b)=>a.displayName.localeCompare(b.displayName,undefined,{sensitivity:'base'}) || a.userId.localeCompare(b.userId));
  }
  async function request(action,payload={}) {
    if(!['candidates','configure_account','publish','my_trips','stop_action','pod_context','seed_test','reassign','publish_ready','open_trip','admin_trips','cancel','cleanup_prepare'].includes(action))throw Error('Unknown driver action.');
    const owner=window.AtlasAuth?.getSession()?.user?.id;
    const session=await window.AtlasAuth?.getValidSession();
    if(!owner || owner!==session?.user?.id)throw Error('Sign into ATLAS again.');
    const response=await fetch(`https://dwrrbpiprcmajfyronlf.supabase.co/rest/v1/rpc/atlas_driver_${action}`,{
      method:'POST',cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{apikey:window.atlasSupabaseConfig.key,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const result=await response.json();
    if(window.AtlasAuth?.getSession()?.user?.id!==owner)throw Error('The ATLAS account changed. Reopen the trip.');
    if(!response.ok)throw Object.assign(Error(response.status===403?'This account no longer has access. Refresh your trips.':result.message || 'Driver connection unavailable.'),{status:response.status,code:result.code});
    return result;
  }
  return Object.freeze({validate,read,resolve,legacy,load,sorted,vehicles,schedules,request});
});
