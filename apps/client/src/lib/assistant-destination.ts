// A DM to the assistant names the destination this screen showed (docs/06 "What members are told"): the
// node advertises an opaque `NetworkConfig.assistantDestinationRevision` beside `assistantDestination`, and
// refuses (409 `assistant_destination_changed`) a DM to the assistant that names any other, so a question
// written for a local model never goes to an online service the member wasn't shown.
import type { MessageCreateRequest, NetworkConfig, User } from "@loam/schema";

import { ApiError } from "./api";

/** The server's code for a DM to the assistant written for a destination that has since changed. */
export const ASSISTANT_DESTINATION_CHANGED = "assistant_destination_changed";

/** A DM create request (the `dm` arm of `MessageCreateRequest`). */
type DmCreateRequest = Extract<MessageCreateRequest, { type: "dm" }>;

/**
 * `request` with the destination revision this screen holds, when its recipient is the assistant (a `bot`
 * user record); a DM to a person, or one sent while no revision is known, goes as it is.
 *
 * @param request - The DM about to be sent.
 * @param recipient - The recipient's user record, if this device has it.
 * @param networkConfig - The network config this screen shows.
 */
export function withAssistantDestination(
  request: DmCreateRequest,
  recipient: User | undefined,
  networkConfig: NetworkConfig | undefined,
): DmCreateRequest {
  const revision = networkConfig?.assistantDestinationRevision;
  return recipient?.type === "bot" && revision !== undefined ? { ...request, assistantDestinationRevision: revision } : request;
}

/** Whether `error` is the node's refusal of a DM written for an assistant destination that has changed. */
export function isAssistantDestinationChanged(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === ASSISTANT_DESTINATION_CHANGED;
}
