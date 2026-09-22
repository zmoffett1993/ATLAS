// The earlier, undeployed Edge Function draft is superseded by keyless Cloud Run.
// Keep this entry point closed if accidentally deployed. See cloud-run/README.md.
Deno.serve(() => new Response(JSON.stringify({ error: "USE_KEYLESS_CLOUD_RUN_PREVIEW" }), {
  status: 503,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
}));
