import type { GroupParticipant } from "../store/groupChatStore";

/**
 * Resolve the @-mention send target from message text.
 * RULE: default = ALL. A mention routes to an agent from ANYWHERE in the
 * message - beginning or mid-sentence. Every @token in the whole text is a
 * candidate; the LAST token that MATCHES a participant wins; stray
 * non-matching @tokens (paths, emails) never strip a real mention.
 *
 * LIVES IN A LIB (2026-11-26 group-input unification): the group panel no
 * longer renders its own composer - the MAIN input bar routes group sends,
 * so the resolver is shared between the panel's historical use and the
 * composer's submit path.
 */
export function resolveGroupMentionTarget(
  text: string,
  participants: GroupParticipant[],
): string | undefined {
  const tokens = [...text.matchAll(/@([^\s]+)/g)];
  if (tokens.length === 0) return undefined; // default: all
  const matchParticipant = (raw: string) => {
    const token = raw.toLowerCase();
    return participants.find(
      (p) =>
        p.name.toLowerCase() === token ||
        p.name
          .toLowerCase()
          .replace(/\s+/g, "")
          .startsWith(token.replace(/\s+/g, "")) ||
        p.name.toLowerCase().includes(token),
    );
  };
  let hit: GroupParticipant | undefined;
  for (const token of tokens) {
    hit = matchParticipant(token[1]) ?? hit;
  }
  return hit ? hit.projectId : undefined; // default: all
}
