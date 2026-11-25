// Anonymous identity + session-token primitives and cookie helpers.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { generateDisplayName } from "@loam/display-name";
import { activeLlmProvider, UserSchema, type LoamConfig, type OllamaConfig, type User, type UserAvatar } from "@loam/schema";

/**
 * Create a human user record with a generated display name and creation timestamp.
 *
 * @param id - The unique user identifier
 * @param isAdmin - Whether the user has administrative privileges
 * @param pending - Whether the user is awaiting approval (approval join policy); omitted when false
 * @returns A validated `User` object constructed from the provided values
 */
export function makeUser(id: string, isAdmin = false, pending = false): User {
  return UserSchema.parse({
    id,
    displayName: generateDisplayName(id),
    type: "human",
    isAdmin,
    createdAt: Date.now(),
    ephemeral: false,
    ...(pending ? { pending: true } : {}),
  });
}

/**
 * Create a User record representing the configured Ollama bot.
 *
 * @param config - Ollama integration config containing the bot identifiers and display name
 * @returns A `User` object for the bot with `type: "bot"`, `isAdmin: false`, a patterned avatar seeded from the bot ID, and the current timestamp as `createdAt`
 */
export function makeBotUser(config: OllamaConfig): User {
  return UserSchema.parse({
    id: config.botId,
    displayName: config.botDisplayName,
    avatar: {
      seed: config.botId,
      mode: "pattern",
    },
    type: "bot",
    isAdmin: false,
    createdAt: Date.now(),
    ephemeral: false,
  });
}

/**
 * Create a new user identifier for an anonymous session: `user.<16 hex>` (64 random bits). The old
 * 8-hex (32-bit) form made a birthday collision plausible on a busy long-lived node, and a colliding
 * mint silently inherited the existing user's record (ensureUser returns what it finds). Ids minted
 * earlier keep working — nothing parses the suffix.
 *
 * @param isTaken - Optional predicate; when given, minting retries until it returns false, so a new
 *   identity can never alias an existing user or session (callers pass their user/session lookups)
 * @returns A fresh `user.<16hex>` id
 */
export function makeSessionUserId(isTaken?: (id: string) => boolean): string {
  for (;;) {
    const id = `user.${randomBytes(8).toString("hex")}`;

    if (!isTaken?.(id)) {
      return id;
    }
  }
}

/** A fresh session-cookie bearer token (256 random bits, base64url). */
export function makeSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** A fresh 256-bit secure identity token (docs/20) — high-entropy, so a fast hash (not scrypt) is the
 * right at-rest protection. */
export function makeIdentityToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of an identity token, base64url — what's stored/looked-up, never the bearer value. */
export function hashIdentityToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** A fresh one-time admin setup code for the `setupCode` bootstrap. */
export function makeAdminSetupCode(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/** Percent-encode a cookie value so it survives `Set-Cookie` framing. */
export function encodeCookieValue(value: string): string {
  return encodeURIComponent(value);
}

/** Read one named cookie's decoded value from a `Cookie` header, or undefined. */
export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const [rawName, ...rawValue] = cookie.trim().split("=");

    if (rawName !== name) {
      continue;
    }

    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Control and format characters, as explicit code-point ranges: C0 and C1 controls, the soft hyphen, the
 * Arabic letter mark, the Mongolian vowel separator, zero-width and directional marks, bidi embeddings,
 * overrides and isolates, invisible operators, the byte order mark, and interlinear annotation marks. They
 * draw nothing (or reorder what is around them), so a name or file name can hide behind them. Ranges, not
 * `\p{Cc}`/`\p{Cf}`: the Android host's Node is built without ICU.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_AND_FORMAT_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;

/** `text` with every control and format character removed (see `CONTROL_AND_FORMAT_CHARACTERS`). */
export function stripControlAndFormatCharacters(text: string): string {
  return text.replace(CONTROL_AND_FORMAT_CHARACTERS, "");
}

/**
 * Characters that are not control or format characters but still draw nothing, or nothing a reader can tell
 * apart, in a name: the combining grapheme joiner, the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the
 * blank Braille pattern, the variation selectors (U+FE00 to U+FE0F and U+E0100 to U+E01EF) and the tag
 * characters (U+E0000 to U+E007F). Removed only from the comparison form: a stored name keeps them, since
 * U+FE0F is what makes "❤️" an emoji. Explicit ranges, as above, for the Node built without ICU.
 */
const INVISIBLE_IN_COMPARISON = /[\u034F\u115F\u1160\u2800\u3164\uFFA0\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/**
 * The form two display names are compared in, so a copy of someone's name with another case, hidden
 * characters or extra spaces counts as the same name: control and format characters and the characters in
 * `INVISIBLE_IN_COMPARISON` removed, NFKC, the same characters removed again, whitespace runs collapsed to
 * one space, trimmed, lower-cased. They go before NFKC because a joiner between a letter and its accent
 * keeps the two from composing, and again after it because NFKC can produce one (U+FFA0 becomes U+3164).
 * An empty result is a name that shows as blank. `normalize` may do nothing (or throw) on a Node built
 * without ICU, so nothing else here depends on it.
 */
export function displayNameComparisonForm(name: string): string {
  let normalized = stripInvisibleInComparison(name);
  try {
    normalized = normalized.normalize("NFKC");
  } catch {
    // No ICU: compare the name as typed.
  }
  return stripInvisibleInComparison(normalized).replace(/\s+/g, " ").trim().toLowerCase();
}

/** `text` without control and format characters or the characters in `INVISIBLE_IN_COMPARISON`. */
function stripInvisibleInComparison(text: string): string {
  return stripControlAndFormatCharacters(text).replace(INVISIBLE_IN_COMPARISON, "");
}

/** The assistant's display name while a backend is active, else undefined: a person may not take it then. */
export function activeAssistantName(llm: LoamConfig["llm"]): string | undefined {
  return activeLlmProvider(llm) !== "off" ? llm.ollama.botDisplayName : undefined;
}

/**
 * Whether `name` would read as someone else's: its `displayNameComparisonForm` equals that of the assistant's
 * name (`assistantName`, from `activeAssistantName`) or of any record in `users` other than `subjectId`'s own.
 */
export function displayNameTakenByOther(name: string, subjectId: string, users: readonly User[], assistantName: string | undefined): boolean {
  const wanted = displayNameComparisonForm(name);
  return (
    (assistantName !== undefined && displayNameComparisonForm(assistantName) === wanted) ||
    users.some((user) => user.id !== subjectId && displayNameComparisonForm(user.displayName) === wanted)
  );
}

/** Ids that only the node mints (people, the assistant, mesh senders): a chosen avatar seed may not start so. */
const RESERVED_SEED_PREFIX = /^(user|llm|mesh)\./;

/**
 * Whether a generated avatar drawn from `seed` would pass `subjectId` off as another record: the seed is
 * another record's id or current seed, or starts with an id prefix the node mints. A record's own id is
 * always its own seed.
 */
export function avatarSeedImpersonates(seed: string, subjectId: string, users: readonly User[]): boolean {
  if (seed === subjectId) {
    return false;
  }
  return RESERVED_SEED_PREFIX.test(seed) || users.some((user) => user.id !== subjectId && (user.id === seed || user.avatar?.seed === seed));
}

/** Whether `avatar` names an uploaded picture file (any of the fields only the upload route sets). */
export function avatarNamesImage(avatar: UserAvatar | undefined): boolean {
  return (
    avatar !== undefined &&
    (avatar.kind === "image" || avatar.imageId !== undefined || avatar.mimeType !== undefined || avatar.uploadedAt !== undefined)
  );
}
