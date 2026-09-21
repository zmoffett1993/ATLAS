// Run as a private Cloud Run JOB, not an HTTP service. Scheduler invokes the authenticated Jobs API.
import { pathToFileURL } from "node:url";
import { createReminderStore } from "./store.mjs";
import { createDispatcher } from "../../tools/routing-preview/notification-dispatcher.mjs";

export async function runReminderJob({ env = name=>process.env[name], loadWebPush = ()=>import("web-push"), fetchImpl = fetch, now = ()=>new Date() } = {}) {
  if(env("ATLAS_NOTIFICATIONS_ENABLED")!=="true")return {attempted:0,sent:0,skipped:true};
  if(env("CLOUD_RUN_JOB")!=="atlas-routing-reminders")throw new Error("Private notification job required.");
  const publicKey=env("ATLAS_PUSH_PUBLIC_KEY"),privateKey=env("ATLAS_PUSH_PRIVATE_KEY"),subject=env("ATLAS_PUSH_SUBJECT");
  let validSubject=/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject||"");
  try{const url=new URL(subject);validSubject ||= url.protocol==="https:"&&!url.username&&!url.password&&!url.hash;}catch{}
  if(!/^[A-Za-z0-9_-]{87}$/.test(publicKey||"")||!/^[A-Za-z0-9_-]{43}$/.test(privateKey||"")||!validSubject)throw new Error("Private Web Push configuration required.");
  const module=await loadWebPush(),webPush=module.default||module;
  const store=createReminderStore({secretKey:env("ATLAS_NOTIFICATION_DB_SECRET"),fetchImpl});
  return createDispatcher({enabled:true,recipientId:env("ATLAS_NOTIFICATION_RECIPIENT_ID"),store,now,
    sendNotification:(subscription,payload,options)=>webPush.sendNotification(subscription,payload,{...options,vapidDetails:{subject,publicKey,privateKey}})})();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const counts=await runReminderJob();console.log(JSON.stringify(counts));}
  catch{console.error("Private delivery reminder job failed; no automatic retry was made.");process.exitCode=1;}
}
