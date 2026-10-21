/**
 * Terminal renderers + decision helpers for the interactive pause rails.
 *
 * The controller exposes every pause as a `ChatHooks` callback; each of these
 * pure functions turns a payload into what the CLI should print and ask. Keeping
 * them pure makes the terminal behaviour unit-testable without a TTY.
 */

import type { PendingPauseCard, UserChoiceQuestion } from '@nexus/chat-core';

export type Prompt =
  | { type: 'confirm'; message: string }
  | { type: 'select'; message: string; options: Array<{ value: string; label: string }> }
  | { type: 'text'; message: string }
  | { type: 'notice'; message: string }
  | { type: 'none' };

export type RailPresentation = {
  lines: string[];
  prompt: Prompt;
};

/** Route a `pending-pause` card to its terminal presentation. */
export function presentPendingPause(card: PendingPauseCard): RailPresentation {
  switch (card.kind) {
    case 'approval':
      return {
        lines: [
          `The agent wants to run a gated write:`,
          `  command: ${card.command}`,
          card.mutationClass ? `  class:   ${card.mutationClass}` : '',
        ].filter(Boolean),
        prompt: { type: 'confirm', message: `Approve ${card.command}?` },
      };
    case 'mode_switch':
      return {
        lines: [
          `The agent requests a mode switch${card.from && card.to ? ` (${card.from} → ${card.to})` : ''}.`,
          card.reason ? `  reason: ${card.reason}` : '',
        ].filter(Boolean),
        prompt: { type: 'confirm', message: 'Accept the mode switch?' },
      };
    case 'client_tool':
      return {
        lines: [`The agent wants to run a local tool: ${card.name}`],
        prompt: card.requiresApproval
          ? { type: 'confirm', message: `Run ${card.name} locally?` }
          : { type: 'none' },
      };
    default:
      return { lines: [], prompt: { type: 'none' } };
  }
}

/** Numbered select for an `ask_user_choice` question, mirroring the agent picker. */
export function presentAskUserChoice(question: UserChoiceQuestion): RailPresentation {
  const lines = [
    question.question,
    question.summary ? `  ${question.summary}` : '',
    question.multiSelect ? '  (select one or more, comma-separated)' : '',
    question.rememberDecision ? '  (your choice may be remembered)' : '',
  ].filter(Boolean);

  return {
    lines,
    prompt: {
      type: 'select',
      message: 'Choose an option',
      options: question.options.map((o, i) => ({
        value: o.id,
        label: `${i + 1}. ${o.label}${o.recommended ? ' ★' : ''}${o.description ? ` — ${o.description}` : ''}`,
      })),
    },
  };
}

/** Permission elevation → confirm prompt, showing the reason and onboarding gate. */
export function presentPermissionElevation(info: {
  pack?: string | null;
  command?: string | null;
  commandNames?: string[];
  reason?: string | null;
  requiredOnboardingType?: string | null;
  onboardingSatisfied?: boolean;
}): RailPresentation {
  const names = info.commandNames?.length
    ? info.commandNames.join(', ')
    : info.command ?? info.pack ?? 'a capability';
  const lines = [
    `The agent needs elevated permission: ${names}`,
    info.reason ? `  reason: ${info.reason}` : '',
    info.requiredOnboardingType && !info.onboardingSatisfied
      ? `  requires onboarding: ${info.requiredOnboardingType}`
      : '',
  ].filter(Boolean);
  return { lines, prompt: { type: 'confirm', message: `Grant ${names}?` } };
}

export function presentToolApproval(run: { tool: string }, mode: 'acknowledge' | 'knowledge' | '2fa'): RailPresentation {
  const lines = [`The agent needs approval to use: ${run.tool}`];
  if (mode === '2fa') lines.push('  This requires a 2FA code.');
  if (mode === 'knowledge') lines.push('  This requires your account password.');
  return {
    lines,
    prompt: mode === 'acknowledge' ? { type: 'confirm', message: 'Approve this action?' } : { type: 'text', message: mode === '2fa' ? 'Enter 2FA code' : 'Enter password' },
  };
}

/** SCA/2FA: the CLI can only poll; biometric approval happens in the ANX app. */
export function presentSca(info: { authRequestId: string | null; command: string }): RailPresentation {
  return {
    lines: [
      `Two-factor confirmation required for ${info.command}.`,
      '  Approve in the ANX app, or enter the code below.',
    ],
    prompt: { type: 'text', message: 'Enter 2FA code (or leave empty and approve in the app)' },
  };
}

export function presentSubAgentNotice(info: { pack?: string | null; command?: string | null }): RailPresentation {
  return {
    lines: [
      `(notice) A background sub-agent needs approval: ${info.command ?? info.pack ?? 'a capability'}`,
      '  The main session stays usable; answer it when convenient.',
    ],
    prompt: { type: 'none' },
  };
}

/** Parse a numbered selection (1-based) or a raw id back to an option id. */
export function resolveSelection(input: string, options: Array<{ value: string; label: string }>): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1].value;
  }
  return options.some((o) => o.value === trimmed) ? trimmed : null;
}

/** Parse a multi-select answer ("1,3") into option ids. */
export function resolveMultiSelection(
  input: string,
  options: Array<{ value: string; label: string }>,
): string[] {
  const parts = input
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const ids: string[] = [];
  for (const p of parts) {
    const resolved = resolveSelection(p, options);
    if (resolved) ids.push(resolved);
  }
  return ids;
}
