/**
 * hermes-permission.ts — pure mapping from Hermes' ACP permission options to Iris's
 * two-button Slack bridge, under each `permission_mode`.
 *
 * Decision recorded on issue #84. Kept pure (no IO) and standalone on purpose:
 * `permission.ts` / `format.ts` stay untouched — every backend-specific policy
 * lives here, and hermes.ts (issue #87) feeds the returned option id into its
 * `respondPermission` (or surfaces a Slack request).
 *
 * Facts (verified against `acp_adapter/permissions.py` / `edit_approval.py`):
 *    - `session/request_permission` arrives with `params.options` (a list of ACP
 *      PermissionOption `{option_id, kind, name}`) and `params.tool_call` carrying
 *      a `kind` of "edit" or "execute" — the discriminant for edit vs non-edit.
 *    - Hermes offers a stable subset that ALWAYS includes `allow_once` and `deny`;
 *      the rest (`allow_session`, `allow_always`, `deny_always`) depend on the
 *      request's `allow_permanent` / `smart_denied` flags.
 *    - The client answers the request's JSON-RPC id with
 *      `{ outcome: { outcome: "selected", option_id } }`; an unknown option_id is
 *      collapsed to `deny` by Hermes, so we only ever pick a real offered id.
 *
 * Policy (2-button parity is preserved — `allow_session` / `allow_always` /
 * `deny_always` are NEVER surfaced as buttons; they are auto-policy only):
 *
 *    mode        | edit (kind=edit)        | non-edit (kind=execute / "other")
 *    ------------|-------------------------|-----------------------------------
 *    auto        | resolve allow_once      | resolve allow_session
 *    acceptEdits | resolve allow_once      | surface (manual)
 *    manual      | surface                 | surface
 *
 * In `auto`, non-edit resolves to the widest thread-scoped grant available —
 * `allow_session`, falling back to `allow_always`, then `allow_once` — so it
 * never writes a persistent global "always" unless no narrower grant is offered.
 * `acceptEdits` auto-allows only the edit and surfaces every dangerous command.
 */

/** The Iris permission_mode values (mirrors agent.ts PermissionMode). */
export type HermesPermissionMode = "manual" | "acceptEdits" | "auto";

/** Either surface a two-button Slack request, or auto-resolve to a concrete option id. */
export type PermissionDecision =
	| {
			action: "surface";
	  }
	| {
			action: "resolve";
			optionId: string;
	  };

/**
 * Resolve a Hermes permission request into an Iris action.
 *
 * @param mode     the project's permission_mode.
 * @param offeredIds the `option_id`s Hermes actually offered in this request.
 *                  Must contain at least `allow_once` and `deny` for a surfaceable
 *                  request; callers surface only when this is non-empty.
 * @param isEdit   true when the request's `tool_call.kind === "edit"`.
 */
export function resolvePermissionOption(
	mode: HermesPermissionMode,
	offeredIds: string[],
	isEdit: boolean,
): PermissionDecision {
	if (mode === "manual") {
		return { action: "surface" };
	}

	if (mode === "acceptEdits") {
		// Edit tools are auto-allowed (no scope expansion); every dangerous
		// (non-edit) command is surfaced for the user to decide.
		if (isEdit && offeredIds.includes("allow_once")) {
			return { action: "resolve", optionId: "allow_once" };
		}
		return { action: "surface" };
	}

	// mode === "auto": resolve to the widest thread-scoped grant that is offered,
	// never a persistent global "always" unless nothing narrower is available.
	const auto = firstOffered(offeredIds, [
		"allow_session",
		"allow_always",
		"allow_once",
	]);
	return auto ? { action: "resolve", optionId: auto } : { action: "surface" };
}

/** First entry of `prefer` that appears in `offered`, or undefined. */
function firstOffered(offered: string[], prefer: string[]): string | undefined {
	for (const id of prefer) {
		if (offered.includes(id)) return id;
	}
	return undefined;
}
