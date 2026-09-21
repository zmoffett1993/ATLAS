// Only served by the approved permanent routing origin. It does not cache orders or API responses.
import { createBindingStore } from "./notification-binding.mjs";
import { createNotificationHandlers } from "./notification-worker.mjs";
const store = createBindingStore(self.indexedDB);
const handlers = createNotificationHandlers({ scope: self.registration.scope, registration: self.registration, clients: self.clients,
  getBinding: async () => (await store.read())?.binding || null });
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("push", event => event.waitUntil(handlers.push(event)));
self.addEventListener("notificationclick", event => event.waitUntil(handlers.click(event)));
// A changed/expired browser subscription must be explicitly re-enabled by its owner.
self.addEventListener("pushsubscriptionchange", event => event.waitUntil(store.clear()));
