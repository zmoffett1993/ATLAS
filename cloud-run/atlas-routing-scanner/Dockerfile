FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node atlas-routing-assignment.js atlas-routing-core.js atlas-routing-storage.js atlas-routing-planner.js ./
COPY --chown=node:node tools/routing-preview/scanner-planning-worker.mjs ./tools/routing-preview/
COPY --chown=node:node cloud-run/atlas-routing-scanner/job.mjs ./cloud-run/atlas-routing-scanner/
COPY --chown=node:node cloud-run/atlas-routing-preview/trip-model.mjs ./cloud-run/atlas-routing-preview/
COPY --chown=node:node supabase/functions/atlas-routing-preview/handler.mjs ./supabase/functions/atlas-routing-preview/
USER node
CMD ["node","cloud-run/atlas-routing-scanner/job.mjs"]
