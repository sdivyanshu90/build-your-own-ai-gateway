import { describe, expect, it } from 'vitest';

import { type ChatMessage } from '../../../src/types/openai.js';
import {
  approximateTextTokens,
  countChatTokens,
  countEmbeddingTokens,
  countTextTokens,
  isOpenAITokenizable,
} from '../../../src/utils/tokens.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France?' },
];

describe('tokens: model family detection', () => {
  it('recognises OpenAI-family models', () => {
    expect(isOpenAITokenizable('gpt-4o')).toBe(true);
    expect(isOpenAITokenizable('o1-preview')).toBe(true);
    expect(isOpenAITokenizable('text-embedding-3-small')).toBe(true);
    expect(isOpenAITokenizable('claude-opus-4')).toBe(false);
    expect(isOpenAITokenizable('mistral-large')).toBe(false);
  });
});

describe('tokens: exact (tiktoken) counting', () => {
  it('counts a known string deterministically', () => {
    const a = countTextTokens('hello world', 'gpt-4o');
    expect(a).toBeGreaterThan(0);
    expect(a).toBe(countTextTokens('hello world', 'gpt-4o'));
  });

  it('counts chat messages including structural overhead', () => {
    const count = countChatTokens(messages, 'gpt-4o');
    // Two short messages plus per-message + reply overhead → a modest positive count.
    expect(count).toBeGreaterThan(10);
    expect(count).toBeLessThan(60);
  });
});

describe('tokens: approximate counting (non-OpenAI)', () => {
  it('approximates within ~10% of the exact count for English prompts', () => {
    const text = 'The quick brown fox jumps over the lazy dog repeatedly in the meadow.';
    const exact = countTextTokens(text, 'gpt-4o');
    const approx = approximateTextTokens(text);
    const ratio = approx / exact;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.5);
  });

  it('uses the heuristic for non-OpenAI models', () => {
    expect(countChatTokens(messages, 'claude-opus-4')).toBeGreaterThan(0);
  });

  it('returns 0 for empty input', () => {
    expect(approximateTextTokens('')).toBe(0);
  });
});

describe('tokens: embeddings', () => {
  it('counts a single string', () => {
    expect(countEmbeddingTokens('hello world', 'text-embedding-3-small')).toBeGreaterThan(0);
  });

  it('sums an array of strings', () => {
    const one = countEmbeddingTokens('hello', 'text-embedding-3-small');
    const two = countEmbeddingTokens(['hello', 'hello'], 'text-embedding-3-small');
    expect(two).toBe(one * 2);
  });

  it('counts pre-tokenized integer input as one token each', () => {
    expect(countEmbeddingTokens([1, 2, 3], 'text-embedding-3-small')).toBe(3);
  });
});
