FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node supabase/functions/atlas-routing-preview/handler.mjs ./supabase/functions/atlas-routing-preview/handler.mjs
COPY --chown=node:node cloud-run/atlas-routing-preview/server.mjs ./cloud-run/atlas-routing-preview/server.mjs
COPY --chown=node:node cloud-run/atlas-routing-preview/planner-handler.mjs cloud-run/atlas-routing-preview/trip-model.mjs ./cloud-run/atlas-routing-preview/
COPY --chown=node:node cloud-run/atlas-routing-preview/preview-access.mjs cloud-run/atlas-routing-preview/photo-handler.mjs ./cloud-run/atlas-routing-preview/
USER node
EXPOSE 8080
CMD ["node", "cloud-run/atlas-routing-preview/server.mjs"]
