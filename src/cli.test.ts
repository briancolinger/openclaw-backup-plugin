import { describe, expect, it } from 'vitest';

import { registerBackupCli } from './cli.js';

// ---------------------------------------------------------------------------
// Mock CommandLike factory
// ---------------------------------------------------------------------------

interface MockCommand {
  command(name: string): MockCommand;
  description(str: string): MockCommand;
  option(flags: string, desc: string): MockCommand;
  action(fn: (opts: Record<string, unknown>) => void): MockCommand;
}

interface MockProgram {
  mock: MockCommand;
  commands: string[];
  descriptions: string[];
}

function makeMockProgram(): MockProgram {
  const commands: string[] = [];
  const descriptions: string[] = [];
  const mock: MockCommand = {
    command(name) {
      commands.push(name);
      return mock;
    },
    description(str) {
      descriptions.push(str);
      return mock;
    },
    option() {
      return mock;
    },
    action() {
      return mock;
    },
  };
  return { mock, commands, descriptions };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerBackupCli', () => {
  it('should register commands without throwing', () => {
    const { mock } = makeMockProgram();
    expect(() => { registerBackupCli(mock); }).not.toThrow();
  });

  it('should throw when program is not a CommandLike', () => {
    expect(() => { registerBackupCli(null); }).toThrow('Commander Command');
    expect(() => { registerBackupCli('not a command'); }).toThrow('Commander Command');
    expect(() => { registerBackupCli(42); }).toThrow('Commander Command');
    expect(() => { registerBackupCli({}); }).toThrow('Commander Command');
  });

  it('should register "backup" and "restore" top-level commands', () => {
    const { mock, commands } = makeMockProgram();
    registerBackupCli(mock);
    expect(commands).toContain('backup');
    expect(commands).toContain('restore');
  });

  it('should register expected backup subcommands', () => {
    const { mock, commands } = makeMockProgram();
    registerBackupCli(mock);
    expect(commands).toContain('list');
    expect(commands).toContain('prune');
    expect(commands).toContain('status');
    expect(commands).toContain('rotate-key');
  });

  it('should set non-empty descriptions on all registered commands', () => {
    const { mock, descriptions } = makeMockProgram();
    registerBackupCli(mock);
    expect(descriptions.length).toBeGreaterThan(0);
    for (const desc of descriptions) {
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it('should register all 6 commands total', () => {
    const { mock, commands } = makeMockProgram();
    registerBackupCli(mock);
    // backup, list, prune, status, rotate-key, restore
    expect(commands).toHaveLength(6);
  });
});
