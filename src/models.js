// First-run model catalog. Mirrors the managed MiniMax models published by
// the official client (MiniMax-AI/minimax-code, packages/config/src/
// minimax-model-catalog.ts, MIT). The remote snapshot in the desktop app
// remains authoritative at runtime; this list is what we expose to clients.

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
};

export const DEFAULT_MODEL = 'MiniMax-M3';

export function isKnownModel(modelId) {
  return Object.prototype.hasOwnProperty.call(MINIMAX_MODELS, modelId);
}

// Map whatever a client sends to an upstream model id. Unknown ids fall back
// to the configured default (clients love sending "gpt-4o"/"claude-sonnet-4"
// even when they mean "whatever you have").
export function resolveUpstreamModel(requestedModel, config) {
  const requested = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (!requested) return { model: config.defaultModel, mappedFrom: '' };
  if (isKnownModel(requested)) return { model: requested, mappedFrom: '' };
  const aliased = config.modelAlias[requested];
  if (aliased && isKnownModel(aliased)) return { model: aliased, mappedFrom: requested };
  return { model: config.defaultModel, mappedFrom: requested };
}
