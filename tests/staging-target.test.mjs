import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGING_PROJECT_ID, assertStagingTarget, stagingApiUrl } from './staging-target.mjs';

test('integration target permits only the recorded staging project', () => {
  assert.equal(assertStagingTarget(STAGING_PROJECT_ID), STAGING_PROJECT_ID);
  assert.equal(stagingApiUrl(STAGING_PROJECT_ID), 'https://qiaixkmwnfnondiwdmya.supabase.co');
});

test('integration target rejects production and unknown or malformed targets', () => {
  assert.throws(() => assertStagingTarget('dwrrbpiprcmajfyronlf'), /PRODUCTION_TEST_WRITES_FORBIDDEN/);
  for (const target of [undefined, null, '', 'unknown', `${STAGING_PROJECT_ID}.example.com`, ` ${STAGING_PROJECT_ID}`, STAGING_PROJECT_ID.toUpperCase()]) {
    assert.throws(() => stagingApiUrl(target), /UNAPPROVED_STAGING_TARGET/);
  }
});
