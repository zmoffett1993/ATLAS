import { createClient } from "npm:@supabase/supabase-js@2";

export const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type,x-atlas-receiver-id,x-atlas-receiver-secret"};
export const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
export const service=()=>createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
export async function authenticated(req:Request){
  const token=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  if(!token)throw Object.assign(new Error("ATLAS_AUTH_REQUIRED"),{status:401});
  const {data,error}=await service().auth.getUser(token);
  if(error||!data.user)throw Object.assign(new Error("ATLAS_AUTH_REQUIRED"),{status:401});
  return data.user;
}
export const roles=(user:any)=>new Set([user?.app_metadata?.role,user?.app_metadata?.atlas_role,...(Array.isArray(user?.app_metadata?.roles)?user.app_metadata.roles:[])].map(value=>String(value||"").toLowerCase()).filter(Boolean));
export const hasRole=(user:any,allowed:string[])=>allowed.some(role=>roles(user).has(role));
export const normalizeWarehouseCode=(value:unknown)=>String(value||"").trim().toUpperCase().replace(/[^A-Z]/g,"").slice(0,8);
export function warehouseDayStart(timeZone:string){
  const zone=String(timeZone||"UTC"),now=new Date();
  const dateParts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now).map(part=>[part.type,part.value]));
  const wallMidnight=Date.UTC(Number(dateParts.year),Number(dateParts.month)-1,Number(dateParts.day));
  const wallParts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(new Date(wallMidnight)).map(part=>[part.type,part.value]));
  const represented=Date.UTC(Number(wallParts.year),Number(wallParts.month)-1,Number(wallParts.day),Number(wallParts.hour),Number(wallParts.minute),Number(wallParts.second));
  return new Date(wallMidnight-(represented-wallMidnight)).toISOString();
}
export async function sha256(value:string|Uint8Array){const bytes=typeof value==="string"?new TextEncoder().encode(value):value;const digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest)).map(value=>value.toString(16).padStart(2,"0")).join("")}
export function decodeBase64(value:string){const binary=atob(value);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes}
export function encodeBase64(bytes:Uint8Array){let output="";for(let i=0;i<bytes.length;i+=0x8000)output+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(output)}
export function fail(error:unknown){const source=error as any;return json({error:String(source?.message||"COC_REQUEST_FAILED")},Number(source?.status)||500)}

async function warehouseById(db:any,warehouseId:unknown){
  const id=String(warehouseId||"");
  if(!id)return null;
  const result=await db.from("warehouses").select("id,code,display_name,time_zone,active").eq("id",id).maybeSingle();
  if(result.error)throw result.error;
  return result.data||null;
}

export async function warehouseContext(user:any,requestedCode:unknown=""){
  const db=service();
  const profileResult=await db.from("profiles").select("user_id,display_name,role,warehouse_id").eq("user_id",user.id).maybeSingle();
  if(profileResult.error||!profileResult.data)throw Object.assign(new Error("WAREHOUSE_PROFILE_REQUIRED"),{status:403});
  const accessResult=await db.from("profile_warehouse_access").select("warehouse_id").eq("user_id",user.id);
  if(accessResult.error)throw accessResult.error;
  const warehouseIds=[...new Set([(profileResult.data as any).warehouse_id,...(accessResult.data||[]).map((row:any)=>row.warehouse_id)].map(value=>String(value||"")).filter(Boolean))];
  const warehousesResult=warehouseIds.length
    ? await db.from("warehouses").select("id,code,display_name,time_zone,active").in("id",warehouseIds)
    : {data:[],error:null};
  if(warehousesResult.error)throw warehousesResult.error;
  const warehouseMap=new Map<string,any>((warehousesResult.data||[]).map((item:any)=>[String(item.id),item] as [string,any]));
  const home:any=warehouseMap.get(String((profileResult.data as any).warehouse_id||""))||null;
  const accessible=warehouseIds.map(id=>warehouseMap.get(id)).filter((item:any)=>item?.active);
  if(!accessible.some((item:any)=>item.id===home?.id)&&home?.active)accessible.unshift(home);
  const wanted=normalizeWarehouseCode(requestedCode)||normalizeWarehouseCode(home?.code);
  const selected=accessible.find((item:any)=>normalizeWarehouseCode(item.code)===wanted);
  if(!selected)throw Object.assign(new Error("WAREHOUSE_ACCESS_DENIED"),{status:403});
  return {profile:{userId:user.id,displayName:(profileResult.data as any).display_name,role:(profileResult.data as any).role},homeWarehouse:home,selectedWarehouse:selected,accessibleWarehouses:accessible};
}

export async function station(stationKey:string){
  const db=service();
  const {data,error}=await db.from("coc_stations").select("*").eq("station_key",stationKey).eq("active",true).single();
  if(error||!data)throw Object.assign(new Error("COC_STATION_NOT_FOUND"),{status:404});
  const warehouse=await warehouseById(db,data.warehouse_id);
  if(!warehouse)throw Object.assign(new Error("COC_STATION_WAREHOUSE_NOT_FOUND"),{status:404});
  return {...data,warehouses:warehouse};
}

export async function stationForWarehouse(user:any,warehouseCode:unknown=""){
  const context=await warehouseContext(user,warehouseCode);
  const db=service();
  const {data,error}=await db.from("coc_stations").select("*").eq("warehouse_id",context.selectedWarehouse.id).eq("active",true).single();
  if(error||!data)throw Object.assign(new Error("COC_STATION_NOT_FOUND"),{status:404});
  return {context,station:{...data,warehouses:context.selectedWarehouse}};
}

export async function assertStationAccess(user:any,target:any){
  const code=normalizeWarehouseCode(target?.warehouses?.code);
  const context=await warehouseContext(user,code);
  if(context.selectedWarehouse.id!==target.warehouse_id)throw Object.assign(new Error("WAREHOUSE_ACCESS_DENIED"),{status:403});
  return context;
}

export async function receiver(req:Request,user:any){
  if(!hasRole(user,["office","office_receiver","supervisor","admin","administrator"]))throw Object.assign(new Error("OFFICE_ROLE_REQUIRED"),{status:403});
  const publicId=req.headers.get("X-Atlas-Receiver-Id")||"",secret=req.headers.get("X-Atlas-Receiver-Secret")||"";
  if(!publicId||!secret)throw Object.assign(new Error("RECEIVER_CREDENTIALS_REQUIRED"),{status:401});
  const db=service(),secretHash=await sha256(secret);
  const {data,error}=await db.from("coc_receiver_devices").select("*,coc_stations(*)").eq("device_public_id",publicId).eq("secret_hash",secretHash).eq("active",true).is("revoked_at",null).single();
  if(error||!data)throw Object.assign(new Error("RECEIVER_NOT_AUTHORIZED"),{status:403});
  const warehouse=await warehouseById(db,(data as any).coc_stations?.warehouse_id);
  if(!warehouse)throw Object.assign(new Error("COC_STATION_WAREHOUSE_NOT_FOUND"),{status:404});
  const hydrated={...data,coc_stations:{...(data as any).coc_stations,warehouses:warehouse}};
  await assertStationAccess(user,hydrated.coc_stations);
  return hydrated;
}
