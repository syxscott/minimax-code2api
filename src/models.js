// Model catalog and request-model resolution.
//
// Catalog mirrors the managed MiniMax models published by the official
// client (MiniMax-AI/minimax-code, packages/config/src/minimax-model-catalog.ts,
// MIT) plus M2.5 / M3.1-Flash, which the managed endpoint verifiably serves.
// The remote snapshot in the desktop app remains authoritative at runtime.

export const MINIMAX_MODELS = {
  'MiniMax-M3': {
    id: 'MiniMax-M3',
    display_name: 'MiniMax M3',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 512000,
    max_output: 128000,
    context_window_options: [512000, 1000000],
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    thinking: 'switchable',
  },
  'MiniMax-M3.1-Flash-Preview': {
    id: 'MiniMax-M3.1-Flash-Preview',
    display_name: 'MiniMax M3.1 Flash (Preview)',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 512000,
    max_output: 128000,
    context_window_options: [512000, 1000000],
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    thinking: 'forced_on',
  },
  'MiniMax-M3.1-Flash': {
    id: 'MiniMax-M3.1-Flash',
    display_name: 'MiniMax M3.1 Flash',
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 1048576,
    max_output: 512000,
    modalities: { input: ['text', 'image', 'video'], output: ['text'] },
    thinking: 'forced_on',
  },
  'MiniMax-M2.7-highspeed': {
    id: 'MiniMax-M2.7-highspeed',
    display_name: 'MiniMax M2.7 Highspeed',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 200000,
    max_output: 128000,
    modalities: { input: ['text'], output: ['text'] },
    thinking: 'on',
  },
  'MiniMax-M2.7': {
    id: 'MiniMax-M2.7',
    display_name: 'MiniMax M2.7',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 200000,
    max_output: 128000,
    modalities: { input: ['text'], output: ['text'] },
    thinking: 'on',
  },
  'MiniMax-M2.5': {
    id: 'MiniMax-M2.5',
    display_name: 'MiniMax M2.5',
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    context: 196608,
    max_output: 32768,
    modalities: { input: ['text'], output: ['text'] },
    thinking: 'on',
  },
};

export const DEFAULT_MODEL = 'MiniMax-M3';

export function isKnownModel(modelId) {
  return Object.prototype.hasOwnProperty.call(MINIMAX_MODELS, modelId);
}

// Resolution policy (verified against the live managed endpoint):
//  - any "MiniMax-*" style id passes through verbatim; the upstream either
//    serves it or silently downgrades to the closest served model, so we
//    must not swallow ids the plan actually supports (e.g. M2.5);
//  - foreign ids (gpt-*, claude-*, ...) map through modelAlias, then to the
//    configured default model.
export function resolveUpstreamModel(requestedModel, config) {
  const requested = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (!requested) return { model: config.defaultModel, mappedFrom: '' };
  if (/^minimax[-_]/iu.test(requested)) {
    return { model: requested, mappedFrom: '' };
  }
  if (isKnownModel(requested)) return { model: requested, mappedFrom: '' };
  const aliased = config.modelAlias[requested];
  if (aliased && isKnownModel(aliased)) return { model: aliased, mappedFrom: requested };
  return { model: config.defaultModel, mappedFrom: requested };
}
