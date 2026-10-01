/*
 * The test-only SERVICE:fionas-web identity shared by the e2e stub (e2e/stub-commerce.mjs) and the
 * previews it serves. Deliberately fake: these values only ever authenticate against the stub and
 * must never be used for a deployment.
 */
export const E2E_SERVICE_ID = 'e2e00000-0000-4000-8000-0000000000e2';
export const E2E_SERVICE_CREDENTIAL = 'e2e-test-only-service-credential';
/** Every access token the stub issues starts with this. */
export const E2E_ACCESS_TOKEN_PREFIX = 'e2e-access-token-';
