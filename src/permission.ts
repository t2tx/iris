import type {types} from '@slack/bolt';
import type {PermissionRequest} from './claude.js';

type Block = types.KnownBlock;

/**
 * permission.ts — bridges Claude permission requests (control_request) to
 * Slack Block Kit buttons, and resolves block_actions back to allow/deny.
 *
 * The registry is keyed by an opaque action key (`instanceId:requestId`), not
 * the requestId alone. Claude can reuse a request_id across process
 * generations, so keying by requestId would let a stale button (old process)
 * land on a newer pending entry with the same id. The action key embeds the
 * process generation, so a stale button simply finds no matching entry. The
 * key is also the Slack button value; requestId is kept only for the Claude
 * control response. The original tool input is retained so an "allow" can echo
 * it back as updatedInput.
 */

/** The opaque registry/button key that ties a click to one process generation. */
export function permissionActionKey(
  instanceId: number,
  requestId: string,
): string {
  return `${instanceId}:${requestId}`;
}

export interface PendingPermission {
  /** Project name, to route the decision back to the right SessionManager. */
  project: string;
  /** Session-manager key (thread_ts in a channel, channel id in a DM). */
  sessionKey: string;
  channel: string;
  /** thread_ts for posting the confirmation; undefined in a DM (flat). */
  threadTs?: string;
  requestId: string;
  input: Record<string, unknown>;
  /**
   * The ClaudeProcess instance that raised this request. A button click is
   * only honored if the session's live process still has this id — guards
   * against a stale click landing on a respawned process that happens to
   * reuse the same request_id.
   */
  instanceId: number;
}

const ACTION_ALLOW = 'iris_perm_allow';
const ACTION_DENY = 'iris_perm_deny';

export class PermissionRegistry {
  private readonly pending = new Map<string, PendingPermission>();

  /** Register a pending request; returns the opaque action key for its buttons. */
  register(
    channel: string,
    sessionKey: string,
    req: PermissionRequest,
    threadTs: string | undefined,
    project: string,
    instanceId: number,
  ): string {
    const actionKey = permissionActionKey(instanceId, req.requestId);
    this.pending.set(actionKey, {
      project,
      sessionKey,
      channel,
      threadTs,
      requestId: req.requestId,
      input: req.input,
      instanceId,
    });
    return actionKey;
  }

  resolve(actionKey: string): PendingPermission | undefined {
    const p = this.pending.get(actionKey);
    if (p) this.pending.delete(actionKey);
    return p;
  }

  /** Whether a request is still registered (not yet resolved or drained). */
  has(actionKey: string): boolean {
    return this.pending.has(actionKey);
  }

  /**
   * Drop and return pending requests for a session (e.g. on process death).
   * When `instanceId` is given, only requests raised by that process
   * generation are drained — so a delayed exit event from an old process
   * cannot drop permissions belonging to a newer process for the same session.
   */
  drainSession(sessionKey: string, instanceId?: number): PendingPermission[] {
    const out: PendingPermission[] = [];
    for (const [id, p] of this.pending) {
      if (p.sessionKey !== sessionKey) continue;
      if (instanceId !== undefined && p.instanceId !== instanceId) continue;
      out.push(p);
      this.pending.delete(id);
    }
    return out;
  }
}

/**
 * Build the Block Kit message asking the user to allow/deny a tool use.
 * `actionKey` (instanceId:requestId) is the button value so a click resolves
 * the exact pending entry for this process generation.
 */
export function permissionBlocks(
  req: PermissionRequest,
  actionKey: string,
): Block[] {
  const detail = describeInput(req.toolName, req.input);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔒 *Permission request* — Claude wants to use *${req.toolName}*${detail ? `\n\`\`\`${detail}\`\`\`` : ''}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: {type: 'plain_text', text: '✅ Allow'},
          action_id: ACTION_ALLOW,
          value: actionKey,
        },
        {
          type: 'button',
          style: 'danger',
          text: {type: 'plain_text', text: '❌ Deny'},
          action_id: ACTION_DENY,
          value: actionKey,
        },
      ],
    },
  ];
}

export const PermissionActionIds = {
  allow: ACTION_ALLOW,
  deny: ACTION_DENY,
} as const;

function describeInput(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const cmd = input['command'];
  if (typeof cmd === 'string') return clip(cmd);
  const fp = input['file_path'];
  if (typeof fp === 'string') return clip(fp);
  try {
    return clip(JSON.stringify(input));
  } catch {
    return '';
  }
}

function clip(s: string, max = 400): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
