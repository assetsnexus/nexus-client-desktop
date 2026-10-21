import { describe, expect, it } from 'vitest';
import {
  presentAskUserChoice,
  presentPendingPause,
  presentPermissionElevation,
  presentSca,
  presentSubAgentNotice,
  presentToolApproval,
  resolveMultiSelection,
  resolveSelection,
} from './rails.js';

describe('presentPendingPause', () => {
  it('renders an approval card as a confirm', () => {
    const out = presentPendingPause({
      callId: 'c1',
      kind: 'approval',
      name: 'send',
      command: 'anx.communicate.message.send',
      arguments: {},
      mutationClass: 'business_write',
      mode: 'plan',
      preview: null,
    });
    expect(out.prompt.type).toBe('confirm');
    expect(out.lines.join('\n')).toContain('anx.communicate.message.send');
  });

  it('renders a client_tool with requiresApproval as a confirm, else no prompt', () => {
    const withApproval = presentPendingPause({
      callId: 'c2',
      kind: 'client_tool',
      name: 'app.shell.run',
      arguments: {},
      access: 'write',
      requiresApproval: true,
      action: 'request',
    });
    expect(withApproval.prompt.type).toBe('confirm');

    const withoutApproval = presentPendingPause({
      callId: 'c3',
      kind: 'client_tool',
      name: 'app.fs.read',
      arguments: {},
      access: 'read',
      requiresApproval: false,
      action: 'request',
    });
    expect(withoutApproval.prompt.type).toBe('none');
  });

  it('renders a mode_switch as a confirm', () => {
    const out = presentPendingPause({
      callId: 'c4',
      kind: 'mode_switch',
      from: 'ask',
      to: 'plan',
      reason: 'needs to write',
      planRef: null,
    });
    expect(out.prompt.type).toBe('confirm');
    expect(out.lines.join('\n')).toContain('ask → plan');
  });
});

describe('presentAskUserChoice', () => {
  const question = {
    questionId: 'q1',
    question: 'Which database?',
    options: [
      { id: 'pg', label: 'Postgres', recommended: true },
      { id: 'mongo', label: 'MongoDB', description: 'document store' },
    ],
    multiSelect: false,
    target: { kind: 'chatter' as const },
    rememberDecision: true,
    topicKey: null,
    summary: 'Pick one',
    urgency: 'normal',
    deadlineSeconds: null,
    onTimeout: 'wait',
    status: 'open' as const,
    askedAt: new Date().toISOString(),
    deadlineAt: null,
  };

  it('renders options as a numbered select with the recommended badge', () => {
    const out = presentAskUserChoice(question);
    expect(out.prompt.type).toBe('select');
    if (out.prompt.type === 'select') {
      expect(out.prompt.options[0].label).toContain('★');
      expect(out.prompt.options).toHaveLength(2);
    }
  });
});

describe('presentPermissionElevation', () => {
  it('shows command names and the onboarding gate', () => {
    const out = presentPermissionElevation({
      commandNames: ['anx.files.write'],
      reason: 'needs write access',
      requiredOnboardingType: 'kyc',
      onboardingSatisfied: false,
    });
    const text = out.lines.join('\n');
    expect(text).toContain('anx.files.write');
    expect(text).toContain('kyc');
    expect(out.prompt.type).toBe('confirm');
  });
});

describe('presentToolApproval', () => {
  it('maps verification modes to prompt types', () => {
    expect(presentToolApproval({ tool: 't' }, 'acknowledge').prompt.type).toBe('confirm');
    expect(presentToolApproval({ tool: 't' }, 'knowledge').prompt.type).toBe('text');
    expect(presentToolApproval({ tool: 't' }, '2fa').prompt.type).toBe('text');
  });
});

describe('presentSca', () => {
  it('tells the user to approve in the app', () => {
    const out = presentSca({ authRequestId: 'a1', command: 'anx.wallet.transfer' });
    expect(out.lines.join('\n')).toContain('ANX app');
    expect(out.prompt.type).toBe('text');
  });
});

describe('presentSubAgentNotice', () => {
  it('is non-blocking', () => {
    const out = presentSubAgentNotice({ command: 'anx.x' });
    expect(out.prompt.type).toBe('none');
    expect(out.lines.join('\n')).toContain('sub-agent');
  });
});

describe('resolveSelection', () => {
  const options = [
    { value: 'pg', label: 'Postgres' },
    { value: 'mongo', label: 'MongoDB' },
  ];

  it('resolves a 1-based number', () => {
    expect(resolveSelection('2', options)).toBe('mongo');
  });

  it('resolves a raw id', () => {
    expect(resolveSelection('pg', options)).toBe('pg');
  });

  it('rejects out-of-range and unknown input', () => {
    expect(resolveSelection('9', options)).toBeNull();
    expect(resolveSelection('nope', options)).toBeNull();
    expect(resolveSelection('', options)).toBeNull();
  });
});

describe('resolveMultiSelection', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
    { value: 'c', label: 'C' },
  ];

  it('resolves a comma-separated list', () => {
    expect(resolveMultiSelection('1,3', options)).toEqual(['a', 'c']);
  });

  it('drops invalid entries', () => {
    expect(resolveMultiSelection('1,9,x', options)).toEqual(['a']);
  });
});
