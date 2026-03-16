import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_LEAD_PROMPT, CODER_PROMPT, REVIEWER_PROMPT, TESTER_PROMPT, VALID_ROLES, getRolePrompt } from '../src/server/agent/swarm-prompts.ts';

describe('VALID_ROLES', () => {
  it('contains exactly the four expected roles', () => {
    assert.deepStrictEqual(VALID_ROLES, ['team-lead', 'coder', 'reviewer', 'tester']);
  });

  it('has length 4', () => {
    assert.equal(VALID_ROLES.length, 4);
  });
});

describe('getRolePrompt', () => {
  it('returns a string for each valid role', () => {
    for (const role of VALID_ROLES) {
      const prompt = getRolePrompt(role);
      assert.equal(typeof prompt, 'string', `Expected string for role "${role}"`);
      assert.ok(prompt!.length > 0, `Expected non-empty prompt for role "${role}"`);
    }
  });

  it('returns the correct prompt for each role', () => {
    assert.equal(getRolePrompt('team-lead'), TEAM_LEAD_PROMPT);
    assert.equal(getRolePrompt('coder'), CODER_PROMPT);
    assert.equal(getRolePrompt('reviewer'), REVIEWER_PROMPT);
    assert.equal(getRolePrompt('tester'), TESTER_PROMPT);
  });

  it('returns undefined for invalid roles', () => {
    assert.equal(getRolePrompt('invalid'), undefined);
    assert.equal(getRolePrompt(''), undefined);
    assert.equal(getRolePrompt('admin'), undefined);
    assert.equal(getRolePrompt('TEAM-LEAD'), undefined);
    assert.equal(getRolePrompt('coder '), undefined);
  });
});

describe('TEAM_LEAD_PROMPT', () => {
  it('contains all required placeholders', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('{{GOAL_BRANCH}}'), 'Missing {{GOAL_BRANCH}}');
    assert.ok(TEAM_LEAD_PROMPT.includes('{{AGENT_ID}}'), 'Missing {{AGENT_ID}}');
    // GATEWAY_URL, AUTH_TOKEN, GOAL_ID are passed as env vars, not embedded in prompt
    assert.ok(TEAM_LEAD_PROMPT.includes('BOBBIT_GATEWAY_URL'), 'Should reference BOBBIT_GATEWAY_URL env var');
    assert.ok(TEAM_LEAD_PROMPT.includes('BOBBIT_AUTH_TOKEN'), 'Should reference BOBBIT_AUTH_TOKEN env var');
    assert.ok(TEAM_LEAD_PROMPT.includes('BOBBIT_GOAL_ID'), 'Should reference BOBBIT_GOAL_ID env var');
  });

  it('contains curl examples', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('curl'), 'Expected curl examples');
  });

  it('mentions TASKS.md', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('TASKS.md'), 'Expected TASKS.md reference');
  });

  it('does not reference spawn_role() as a function call', () => {
    assert.ok(!TEAM_LEAD_PROMPT.includes('spawn_role('), 'Should not contain spawn_role() function call');
    assert.ok(!TEAM_LEAD_PROMPT.includes('spawn_role ()'), 'Should not contain spawn_role () function call');
  });

  it('describes the team lead role', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('Team Lead'), 'Expected Team Lead role description');
  });

  it('instructs not to write production code', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('NOT write production code'), 'Expected instruction to not write code');
  });
});

describe('CODER_PROMPT', () => {
  it('contains {{GOAL_BRANCH}} placeholder', () => {
    assert.ok(CODER_PROMPT.includes('{{GOAL_BRANCH}}'), 'Missing {{GOAL_BRANCH}}');
  });

  it('contains {{AGENT_ID}} placeholder', () => {
    assert.ok(CODER_PROMPT.includes('{{AGENT_ID}}'), 'Missing {{AGENT_ID}}');
  });

  it('mentions git sub-branches', () => {
    assert.ok(CODER_PROMPT.includes('sub-branch'), 'Expected mention of git sub-branches');
  });

  it('mentions TASKS.md', () => {
    assert.ok(CODER_PROMPT.includes('TASKS.md'), 'Expected TASKS.md reference');
  });

  it('describes the coder role', () => {
    assert.ok(CODER_PROMPT.includes('Coder'), 'Expected Coder role description');
  });
});

describe('REVIEWER_PROMPT', () => {
  it('contains {{GOAL_BRANCH}} placeholder', () => {
    assert.ok(REVIEWER_PROMPT.includes('{{GOAL_BRANCH}}'), 'Missing {{GOAL_BRANCH}}');
  });

  it('contains {{AGENT_ID}} placeholder', () => {
    assert.ok(REVIEWER_PROMPT.includes('{{AGENT_ID}}'), 'Missing {{AGENT_ID}}');
  });

  it('mentions NOT committing/modifying code', () => {
    assert.ok(
      REVIEWER_PROMPT.includes('NOT modify production code') || REVIEWER_PROMPT.includes('do NOT modify production code'),
      'Expected instruction to NOT modify production code',
    );
  });

  it('mentions TASKS.md', () => {
    assert.ok(REVIEWER_PROMPT.includes('TASKS.md'), 'Expected TASKS.md reference');
  });

  it('describes the reviewer role', () => {
    assert.ok(REVIEWER_PROMPT.includes('Reviewer'), 'Expected Reviewer role description');
  });
});

describe('TESTER_PROMPT', () => {
  it('contains {{GOAL_BRANCH}} placeholder', () => {
    assert.ok(TESTER_PROMPT.includes('{{GOAL_BRANCH}}'), 'Missing {{GOAL_BRANCH}}');
  });

  it('contains {{AGENT_ID}} placeholder', () => {
    assert.ok(TESTER_PROMPT.includes('{{AGENT_ID}}'), 'Missing {{AGENT_ID}}');
  });

  it('mentions tests', () => {
    assert.ok(TESTER_PROMPT.includes('test'), 'Expected mention of tests');
    assert.ok(TESTER_PROMPT.includes('Write') || TESTER_PROMPT.includes('write'), 'Expected mention of writing tests');
  });

  it('mentions TASKS.md', () => {
    assert.ok(TESTER_PROMPT.includes('TASKS.md'), 'Expected TASKS.md reference');
  });

  it('describes the tester role', () => {
    assert.ok(TESTER_PROMPT.includes('Tester'), 'Expected Tester role description');
  });
});

describe('Placeholder substitution', () => {
  const placeholders: Record<string, string> = {
    '{{GOAL_BRANCH}}': 'goal/feature-123',
    '{{AGENT_ID}}': 'agent-abc-456',

  };

  function substitutePlaceholders(prompt: string): string {
    let result = prompt;
    for (const [placeholder, value] of Object.entries(placeholders)) {
      result = result.replaceAll(placeholder, value);
    }
    return result;
  }

  it('replaces all placeholders in TEAM_LEAD_PROMPT', () => {
    const result = substitutePlaceholders(TEAM_LEAD_PROMPT);
    assert.ok(!result.includes('{{'), `Unsubstituted placeholder found: ${result.match(/\{\{[^}]+\}\}/)?.[0]}`);
  });

  it('replaces all placeholders in CODER_PROMPT', () => {
    const result = substitutePlaceholders(CODER_PROMPT);
    assert.ok(!result.includes('{{'), `Unsubstituted placeholder found: ${result.match(/\{\{[^}]+\}\}/)?.[0]}`);
  });

  it('replaces all placeholders in REVIEWER_PROMPT', () => {
    const result = substitutePlaceholders(REVIEWER_PROMPT);
    assert.ok(!result.includes('{{'), `Unsubstituted placeholder found: ${result.match(/\{\{[^}]+\}\}/)?.[0]}`);
  });

  it('replaces all placeholders in TESTER_PROMPT', () => {
    const result = substitutePlaceholders(TESTER_PROMPT);
    assert.ok(!result.includes('{{'), `Unsubstituted placeholder found: ${result.match(/\{\{[^}]+\}\}/)?.[0]}`);
  });

  it('substituted values appear in the output', () => {
    const result = substitutePlaceholders(TEAM_LEAD_PROMPT);
    assert.ok(result.includes('goal/feature-123'), 'Expected GOAL_BRANCH value');
    assert.ok(result.includes('agent-abc-456'), 'Expected AGENT_ID value');
    // GATEWAY_URL, AUTH_TOKEN, GOAL_ID are env vars — not substituted in prompt text
    assert.ok(result.includes('$BOBBIT_GATEWAY_URL'), 'Should reference env var in curl examples');
  });
});
