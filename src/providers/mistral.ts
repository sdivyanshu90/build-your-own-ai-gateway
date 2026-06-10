/**
 * Mistral provider adapter.
 *
 * Mistral's API is OpenAI-compatible on the wire (Bearer auth, /chat/completions
 * and /embeddings, OpenAI-shaped streaming chunks and tool calls), so this
 * adapter extends the OpenAI adapter and overrides only where Mistral diverges:
 *   • `seed` is named `random_seed`.
 *   • Mistral rejects `logit_bias`, `presence_penalty`, `frequency_penalty`,
 *     `n`, and `user`, so those are stripped to avoid 422s on otherwise valid
 *     OpenAI requests.
 * Token counting falls through to the inherited heuristic counter (the model id
 * is non-OpenAI, so tiktoken is not used).
 */
import { type ChatCompletionRequest } from '../types/openai.js';
import { type AdapterType } from '../utils/constants.js';

import { OpenAIProvider } from './openai.js';

const UNSUPPORTED_FIELDS = ['logit_bias', 'presence_penalty', 'frequency_penalty', 'n', 'user'];

export class MistralProvider extends OpenAIProvider {
  public static readonly mistralAdapterType: AdapterType = 'mistral';

  protected override buildChatBody(
    request: ChatCompletionRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { ...super.buildChatBody(request, stream) };
    if (body['seed'] !== undefined) {
      body['random_seed'] = body['seed'];
    }
    delete body['seed'];
    for (const field of UNSUPPORTED_FIELDS) {
      delete body[field];
    }
    return body;
  }
}
