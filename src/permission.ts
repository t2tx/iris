import type {types} from '@slack/bolt';
import type {PermissionRequest} from './claude.js';

type Block = types.KnownBlock;

/**
 * permission.ts — bridges Claude permission requests (control_request) to
 * Slack Block Kit buttons, and resolves block_actions back to allow/deny.
 *
 * We keep a registry keyed by requestId so a button click can be routed back
 * to the right thread/process. The original tool input is retained so an
 * "allow" can echo it back as updatedInput.
 */

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
}

const ACTION_ALLOW = 'iris_perm_allow';
const ACTION_DENY = 'iris_perm_deny';

export class PermissionRegistry {
  private readonly pending = new Map<string, PendingPermission>();

  register(
    channel: string,
    sessionKey: string,
    req: PermissionRequest,
    threadTs: string | undefined,
    project: string,
  ): void {
    this.pending.set(req.requestId, {
      project,
      sessionKey,
      channel,
      threadTs,
      requestId: req.requestId,
      input: req.input,
    });
  }

  resolve(requestId: string): PendingPermission | undefined {
    const p = this.pending.get(requestId);
    if (p) this.pending.delete(requestId);
    return p;
  }

  /** Drop and return all pending requests for a session (e.g. on process death). */
  drainSession(sessionKey: string): PendingPermission[] {
    const out: PendingPermission[] = [];
    for (const [id, p] of this.pending) {
      if (p.sessionKey === sessionKey) {
        out.push(p);
        this.pending.delete(id);
      }
    }
    return out;
  }
}

/** Build the Block Kit message asking the user to allow/deny a tool use. */
export function permissionBlocks(req: PermissionRequest): Block[] {
  const detail = describeInput(req.toolName, req.input);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:lock: *Permission request* — Claude wants to use *${req.toolName}*${detail ? `\n\`\`\`${detail}\`\`\`` : ''}`,
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
          value: req.requestId,
        },
        {
          type: 'button',
          style: 'danger',
          text: {type: 'plain_text', text: '❌ Deny'},
          action_id: ACTION_DENY,
          value: req.requestId,
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
