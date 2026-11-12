import { describe, expect, it, vi } from 'vitest';

import {
  type BudgetChatMessage,
  dropOldestTurns,
  fitMessagesToContext,
  ON_DEVICE_N_CTX,
  ON_DEVICE_N_PREDICT,
  ON_DEVICE_PROMPT_BUDGET,
} from './llm-context-budget';

/** A stand-in template + tokenizer: 4 characters per token plus 4 tokens of framing per turn. */
const countTokens = vi.fn(async (messages: BudgetChatMessage[]) =>
  messages.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 4, 0),
);

/** A user/assistant conversation of `turns` turns of `chars` characters, opening and closing on a user turn. */
function conversation(turns: number, chars: number): BudgetChatMessage[] {
  return Array.from({ length: turns }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index}:`.padEnd(chars, 'x'),
  }));
}

describe('ON_DEVICE_PROMPT_BUDGET', () => {
  it('leaves room for a whole reply inside the context', () => {
    expect(ON_DEVICE_PROMPT_BUDGET + ON_DEVICE_N_PREDICT).toBeLessThan(ON_DEVICE_N_CTX);
  });
});

describe('dropOldestTurns', () => {
  const system: BudgetChatMessage = { role: 'system', content: 'sys' };

  it('keeps the system prompt and the newest turn whatever the count', () => {
    const turns = conversation(5, 10);
    expect(dropOldestTurns([system, ...turns], 99)).toEqual([system, turns[4]]);
  });

  it('never opens the conversation on an assistant turn', () => {
    const turns = conversation(5, 10);
    // Dropping one leaves an assistant turn first; it goes too.
    expect(dropOldestTurns([system, ...turns], 1)).toEqual([system, turns[2], turns[3], turns[4]]);
    expect(dropOldestTurns(turns, 0)).toEqual(turns);
  });

  it('leaves a system-only list alone', () => {
    expect(dropOldestTurns([system], 3)).toEqual([system]);
  });
});

describe('fitMessagesToContext', () => {
  it('returns a history that already fits unchanged, after one count', async () => {
    countTokens.mockClear();
    const messages = [{ role: 'system' as const, content: 'Be brief.' }, ...conversation(5, 100)];
    const result = await fitMessagesToContext(messages, countTokens);
    expect(result).toMatchObject({ fits: true, dropped: 0 });
    expect(result.messages).toEqual(messages);
    expect(countTokens).toHaveBeenCalledTimes(1);
  });

  it('cuts a 40 x 8000-character history down to the newest turns that fit with the reply', async () => {
    const system = { role: 'system' as const, content: 'S'.repeat(4000) };
    const turns = conversation(39, 8000);
    const result = await fitMessagesToContext([system, ...turns], countTokens);
    expect(result.fits).toBe(true);
    expect(result.messages[0]).toBe(system);
    expect(result.messages.at(-1)).toBe(turns.at(-1));
    expect(result.messages[1].role).toBe('user');
    expect(result.promptTokens).toBeLessThanOrEqual(ON_DEVICE_PROMPT_BUDGET);
    expect(result.promptTokens + ON_DEVICE_N_PREDICT).toBeLessThanOrEqual(ON_DEVICE_N_CTX);
    expect(await countTokens(result.messages)).toBe(result.promptTokens);
  });

  it('keeps as many turns as fit, not fewer', async () => {
    // 19 turns of 400 characters = 104 tokens each; a 1000-token budget holds 9 (936), not 10 (1040).
    // The newest nine are turns 10..18, which open on a user turn.
    const turns = conversation(19, 400);
    const result = await fitMessagesToContext(turns, countTokens, 1000);
    expect(result).toMatchObject({ fits: true, promptTokens: 936, dropped: 10 });
    expect(result.messages).toEqual(turns.slice(10));
  });

  it('drops an extra turn rather than open on an assistant turn', async () => {
    // A budget of 10 turns (1040) would keep turns 9..18, which opens on an assistant turn: keep 10..18.
    const turns = conversation(19, 400);
    const result = await fitMessagesToContext(turns, countTokens, 1040);
    expect(result.messages).toEqual(turns.slice(10));
  });

  it('reports fits: false when the system prompt and the newest message alone are too long', async () => {
    const system = { role: 'system' as const, content: 'S'.repeat(4000) };
    const result = await fitMessagesToContext([system, ...conversation(3, 8000), { role: 'user', content: 'z'.repeat(20_000) }], countTokens);
    expect(result.fits).toBe(false);
    expect(result.messages).toEqual([system, { role: 'user', content: 'z'.repeat(20_000) }]);
  });
});
