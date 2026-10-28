import { describe, expect, test } from 'bun:test';
import { diffSkills } from '../../scripts/skills-sync';

describe('skills do projeto', () => {
  // .agents/skills é a fonte (Antigravity); .claude/skills é cópia gerada (Claude Code).
  test('.claude/skills é cópia exata de .agents/skills', () => {
    expect(diffSkills()).toEqual([]);
  });
});
