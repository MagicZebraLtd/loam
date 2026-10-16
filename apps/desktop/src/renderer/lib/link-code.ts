/**
 * The "Link another LOAM node" QR (server `sync-links.ts`, docs/11), built as the Android share screen
 * builds it (apps/app/src/lib/link-code.ts): the join URL with its `#k=` key, which the joining node pins,
 * then `&l=<code>`. Never without a key: the code must only travel sealed, and the scanner refuses a link
 * code that comes with no key. Any `&i=` invite is dropped; it has nothing to do with linking.
 */
export function linkCodeUrl(joinUrlWithKey: string, code: string): string | undefined {
  if (!/#k=[A-Za-z0-9_-]+/.test(joinUrlWithKey)) {
    return undefined;
  }
  return `${joinUrlWithKey.replace(/&i=[A-Za-z0-9_-]+/, "")}&l=${code}`;
}

/** Whether the join URL carries an `&i=` invite (an approval-only node lets a scanner straight in). */
export function hasInvite(joinUrl: string): boolean {
  return /[#&]i=[A-Za-z0-9_-]+/.test(joinUrl);
}

/** Whether the join URL carries the node's `#k=` key. */
export function hasKey(joinUrl: string): boolean {
  return /#k=[A-Za-z0-9_-]+/.test(joinUrl);
}
