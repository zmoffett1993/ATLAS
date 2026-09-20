// Project IDs are identifiers, not credentials. No secrets belong in this file.
export const STAGING_PROJECT_ID = 'qiaixkmwnfnondiwdmya';
const PRODUCTION_PROJECT_ID = 'dwrrbpiprcmajfyronlf';

export function assertStagingTarget(projectId) {
  if (projectId === PRODUCTION_PROJECT_ID) throw new Error('PRODUCTION_TEST_WRITES_FORBIDDEN');
  if (projectId !== STAGING_PROJECT_ID) throw new Error('UNAPPROVED_STAGING_TARGET');
  return projectId;
}

export function stagingApiUrl(projectId) {
  return `https://${assertStagingTarget(projectId)}.supabase.co`;
}
