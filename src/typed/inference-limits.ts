/* v8 ignore file -- build-time constants consumed by the type parser and generation scripts */
/** Maximum tokens the type-level scanner emits for one literal expression. */
export const INFERENCE_TOKEN_LIMIT = 64

/** Maximum source characters the type-level scanner visits for one literal expression. */
export const INFERENCE_SOURCE_STEP_LIMIT = 256

export type InferenceTokenLimit = typeof INFERENCE_TOKEN_LIMIT
export type InferenceSourceStepLimit = typeof INFERENCE_SOURCE_STEP_LIMIT
