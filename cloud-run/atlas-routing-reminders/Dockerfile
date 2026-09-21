FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/cloud-run/atlas-routing-reminders
# Intentionally cannot build until an approved install produces a reviewed lockfile.
COPY cloud-run/atlas-routing-reminders/package.json cloud-run/atlas-routing-reminders/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
WORKDIR /app
COPY --chown=node:node atlas-routing-notifications.js ./
COPY --chown=node:node tools/routing-preview/notification-dispatcher.mjs ./tools/routing-preview/
COPY --chown=node:node cloud-run/atlas-routing-reminders/job.mjs cloud-run/atlas-routing-reminders/store.mjs ./cloud-run/atlas-routing-reminders/
USER node
CMD ["node", "cloud-run/atlas-routing-reminders/job.mjs"]
