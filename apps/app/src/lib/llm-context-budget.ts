// Fitting a DM's chat history into the on-device model's context window (docs/06).
//
// The on-device model runs with a fixed context (`ON_DEVICE_N_CTX` tokens) and llama.rn's `ctx_shift` off,
// so a prompt that, with the reply's `n_predict` tokens, doesn't fit fails with "Context is full" (or stops
// mid-reply). The server sends at most 40 turns, capped by characters, but characters are not tokens, so
// the exact fit is decided here, against the loaded model's own chat template and tokenizer: drop the
// oldest turns until the formatted prompt plus the reply budget fits. Pure apart from the injected token
// counter, so it is unit-tested without a model.

/** One chat turn as the server sends it over the bridge. */
export type BudgetChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** The on-device model's context window, in tokens (passed to `initLlama`). */
export const ON_DEVICE_N_CTX = 4096;

/** The most tokens one reply may generate (passed to `completion`). */
export const ON_DEVICE_N_PREDICT = 512;

/** Slack for the BOS token and any template difference between counting and the real completion. */
export const ON_DEVICE_PROMPT_MARGIN = 16;

/** How many prompt tokens a completion may use and still leave room for a whole reply. */
export const ON_DEVICE_PROMPT_BUDGET = ON_DEVICE_N_CTX - ON_DEVICE_N_PREDICT - ON_DEVICE_PROMPT_MARGIN;

/** Counts the tokens of the prompt `messages` would be formatted into. */
export type PromptTokenCounter = (messages: BudgetChatMessage[]) => Promise<number>;

export type FitResult =
  | { fits: true; messages: BudgetChatMessage[]; promptTokens: number; dropped: number }
  | { fits: false; messages: BudgetChatMessage[]; promptTokens: number; dropped: number };

/**
 * `messages` with the oldest `count` conversation turns removed. System messages are always kept, and
 * so is the newest turn (the message being answered). A leading assistant turn left after the cut is
 * dropped too, so the conversation opens on a user turn (Gemma's template refuses one that doesn't
 * alternate user/assistant from a user turn).
 */
export function dropOldestTurns(messages: BudgetChatMessage[], count: number): BudgetChatMessage[] {
  const system = messages.filter((message) => message.role === 'system');
  const turns = messages.filter((message) => message.role !== 'system');
  if (turns.length === 0) {
    return system;
  }
  let kept = turns.slice(Math.min(Math.max(0, count), turns.length - 1));
  while (kept.length > 1 && kept[0].role === 'assistant') {
    kept = kept.slice(1);
  }
  return [...system, ...kept];
}

/**
 * Keep as much of the newest history as fits in `budget` prompt tokens. Tries the whole history first
 * (one count in the common case), then binary-searches the fewest oldest turns to drop: dropping more
 * never adds tokens, so the search is sound. When even the system prompt plus the newest turn don't fit,
 * returns `fits: false` with that smallest prompt, for the caller to refuse.
 */
export async function fitMessagesToContext(
  messages: BudgetChatMessage[],
  countPromptTokens: PromptTokenCounter,
  budget: number = ON_DEVICE_PROMPT_BUDGET,
): Promise<FitResult> {
  const whole = dropOldestTurns(messages, 0);
  const wholeTokens = await countPromptTokens(whole);
  if (wholeTokens <= budget) {
    return { fits: true, messages: whole, promptTokens: wholeTokens, dropped: messages.length - whole.length };
  }

  const turnCount = messages.filter((message) => message.role !== 'system').length;
  const maxDrop = Math.max(0, turnCount - 1);
  const smallest = dropOldestTurns(messages, maxDrop);
  const smallestTokens = await countPromptTokens(smallest);
  if (smallestTokens > budget) {
    return { fits: false, messages: smallest, promptTokens: smallestTokens, dropped: messages.length - smallest.length };
  }

  // Invariant: dropping `low` turns doesn't fit, dropping `high` does.
  let low = 0;
  let high = maxDrop;
  let best = { messages: smallest, promptTokens: smallestTokens };
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const candidate = dropOldestTurns(messages, middle);
    const tokens = await countPromptTokens(candidate);
    if (tokens <= budget) {
      high = middle;
      best = { messages: candidate, promptTokens: tokens };
    } else {
      low = middle;
    }
  }
  return { fits: true, messages: best.messages, promptTokens: best.promptTokens, dropped: messages.length - best.messages.length };
}
