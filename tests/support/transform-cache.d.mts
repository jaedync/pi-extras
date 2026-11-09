/** The checkout's jiti transform cache for tests, one per Pi and jiti version, in `node_modules/.cache`. */
export declare const TEST_TRANSFORM_CACHE: string;
/** Makes `<tmpDir>/jiti` a link to the checkout's transform cache, so a new TMPDIR keeps a warm cache. */
export declare function linkTransformCache(tmpDir: string): void;
