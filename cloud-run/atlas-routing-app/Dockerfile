FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node cloud-run/atlas-routing-app/server.mjs ./cloud-run/atlas-routing-app/
COPY --chown=node:node tools/routing-preview/bridge.mjs tools/routing-preview/preview.mjs tools/routing-preview/maps.mjs tools/routing-preview/index.html tools/routing-preview/preview.css tools/routing-preview/routing.webmanifest tools/routing-preview/notification-client.mjs tools/routing-preview/notification-binding.mjs tools/routing-preview/notification-worker.mjs tools/routing-preview/routing-notification-sw.mjs ./tools/routing-preview/
COPY --chown=node:node atlas-auth.js atlas-auth.css atlas-jszip.min.js atlas-routing.js atlas-routing.css atlas-routing-core.js atlas-routing-planner.js atlas-routing-catalog.js atlas-routing-intake.js atlas-routing-storage.js atlas-routing-notifications.js atlas-brand-landscape-dark.svg chubby-gorilla-header-v2.png atlas-icon-v2-180.png atlas-icon-v2-192.png atlas-icon-v2-512.png ./
USER node
EXPOSE 8080
CMD ["node","cloud-run/atlas-routing-app/server.mjs"]
