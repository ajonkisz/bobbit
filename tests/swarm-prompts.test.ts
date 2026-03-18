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
  });

  it('uses file-based discovery instead of env vars', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('~/.pi/gateway-token'), 'Should reference ~/.pi/gateway-token');
    assert.ok(TEAM_LEAD_PROMPT.includes('~/.pi/gateway-url'), 'Should reference ~/.pi/gateway-url');
    assert.ok(TEAM_LEAD_PROMPT.includes('BOBBIT_SESSION_ID'), 'Should reference BOBBIT_SESSION_ID env var');
    assert.ok(TEAM_LEAD_PROMPT.includes('/api/sessions/$BOBBIT_SESSION_ID'), 'Should discover goal ID via session API');
    // Should NOT have the old env var docs section
    assert.ok(!TEAM_LEAD_PROMPT.includes('BOBBIT_GATEWAY_URL'), 'Should not reference BOBBIT_GATEWAY_URL env var');
    assert.ok(!TEAM_LEAD_PROMPT.includes('BOBBIT_AUTH_TOKEN'), 'Should not reference BOBBIT_AUTH_TOKEN env var');
    assert.ok(!TEAM_LEAD_PROMPT.includes('BOBBIT_GOAL_ID'), 'Should not reference BOBBIT_GOAL_ID env var');
  });

  it('contains curl examples', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('curl'), 'Expected curl examples');
  });

  it('uses Task API instead of TASKS.md', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('/api/goals/$GOAL_ID/tasks'), 'Expected Task API endpoint');
    assert.ok(TEAM_LEAD_PROMPT.includes('/api/tasks/'), 'Expected task operations endpoint');
    // Should not instruct to create/edit TASKS.md
    assert.ok(!TEAM_LEAD_PROMPT.includes('Create and maintain TASKS.md'), 'Should not reference creating TASKS.md');
    assert.ok(!TEAM_LEAD_PROMPT.includes('## TASKS.md Format'), 'Should not have TASKS.md Format section');
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

  it('mentions steer-based notifications instead of polling', () => {
    assert.ok(TEAM_LEAD_PROMPT.includes('steer'), 'Expected steer notification reference');
    assert.ok(!TEAM_LEAD_PROMPT.includes('wait briefly then check'), 'Should not have polling pattern');
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

  it('uses Task API instead of TASKS.md', () => {
    assert.ok(CODER_PROMPT.includes('/api/tasks/'), 'Expected Task API endpoint');
    assert.ok(CODER_PROMPT.includes('BOBBIT_SESSION_ID'), 'Expected BOBBIT_SESSION_ID env var');
    assert.ok(CODER_PROMPT.includes('/assign'), 'Expected assign endpoint');
    assert.ok(CODER_PROMPT.includes('/transition'), 'Expected transition endpoint');
    // Should not instruct to edit TASKS.md
    assert.ok(!CODER_PROMPT.includes('Edit TASKS.md'), 'Should not reference editing TASKS.md');
  });

  it('describes the coder role', () => {
    assert.ok(CODER_PROMPT.includes('Coder'), 'Expected Coder role description');
  });

  it('uses file-based discovery for gateway URL and token', () => {
    assert.ok(CODER_PROMPT.includes('~/.pi/gateway-url'), 'Should reference ~/.pi/gateway-url');
    assert.ok(CODER_PROMPT.includes('~/.pi/gateway-token'), 'Should reference ~/.pi/gateway-token');
    assert.ok(CODER_PROMPT.includes('BOBBIT_SESSION_ID'), 'Should reference BOBBIT_SESSION_ID');
    assert.ok(!CODER_PROMPT.includes('BOBBIT_GATEWAY_URL'), 'Should not reference BOBBIT_GATEWAY_URL');
    assert.ok(!CODER_PROMPT.includes('BOBBIT_AUTH_TOKEN'), 'Should not reference BOBBIT_AUTH_TOKEN');
    assert.ok(!CODER_PROMPT.includes('BOBBIT_GOAL_ID'), 'Should not reference BOBBIT_GOAL_ID');
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

  it('uses Task API instead of TASKS.md', () => {
    assert.ok(REVIEWER_PROMPT.includes('/api/tasks/'), 'Expected Task API endpoint');
    assert.ok(REVIEWER_PROMPT.includes('resultSummary'), 'Expected resultSummary for findings');
    assert.ok(!REVIEWER_PROMPT.includes('Findings section of TASKS.md'), 'Should not reference TASKS.md Findings section');
  });

  it('describes the reviewer role', () => {
    assert.ok(REVIEWER_PROMPT.includes('Reviewer'), 'Expected Reviewer role description');
  });

  it('uses file-based discovery for gateway URL and token', () => {
    assert.ok(REVIEWER_PROMPT.includes('~/.pi/gateway-url'), 'Should reference ~/.pi/gateway-url');
    assert.ok(REVIEWER_PROMPT.includes('~/.pi/gateway-token'), 'Should reference ~/.pi/gateway-token');
    assert.ok(REVIEWER_PROMPT.includes('BOBBIT_SESSION_ID'), 'Should reference BOBBIT_SESSION_ID');
    assert.ok(!REVIEWER_PROMPT.includes('BOBBIT_GATEWAY_URL'), 'Should not reference BOBBIT_GATEWAY_URL');
    assert.ok(!REVIEWER_PROMPT.includes('BOBBIT_AUTH_TOKEN'), 'Should not reference BOBBIT_AUTH_TOKEN');
    assert.ok(!REVIEWER_PROMPT.includes('BOBBIT_GOAL_ID'), 'Should not reference BOBBIT_GOAL_ID');
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

  it('uses Task API instead of TASKS.md', () => {
    assert.ok(TESTER_PROMPT.includes('/api/tasks/'), 'Expected Task API endpoint');
    assert.ok(TESTER_PROMPT.includes('BOBBIT_SESSION_ID'), 'Expected BOBBIT_SESSION_ID env var');
    assert.ok(!TESTER_PROMPT.includes('Edit TASKS.md'), 'Should not reference editing TASKS.md');
  });

  it('describes the tester role', () => {
    assert.ok(TESTER_PROMPT.includes('Tester'), 'Expected Tester role description');
  });

  it('uses file-based discovery for gateway URL and token', () => {
    assert.ok(TESTER_PROMPT.includes('~/.pi/gateway-url'), 'Should reference ~/.pi/gateway-url');
    assert.ok(TESTER_PROMPT.includes('~/.pi/gateway-token'), 'Should reference ~/.pi/gateway-token');
    assert.ok(TESTER_PROMPT.includes('BOBBIT_SESSION_ID'), 'Should reference BOBBIT_SESSION_ID');
    assert.ok(!TESTER_PROMPT.includes('BOBBIT_GATEWAY_URL'), 'Should not reference BOBBIT_GATEWAY_URL');
    assert.ok(!TESTER_PROMPT.includes('BOBBIT_AUTH_TOKEN'), 'Should not reference BOBBIT_AUTH_TOKEN');
    assert.ok(!TESTER_PROMPT.includes('BOBBIT_GOAL_ID'), 'Should not reference BOBBIT_GOAL_ID');
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
    // Uses $GW and $TOKEN (from file reads), not env var references
    assert.ok(result.includes('$GW'), 'Should use $GW variable in curl examples');
    assert.ok(result.includes('$TOKEN'), 'Should use $TOKEN variable in curl examples');
  });
});

describe('No TASKS.md instructions in prompts', () => {
  const allPrompts = [
    { name: 'TEAM_LEAD_PROMPT', prompt: TEAM_LEAD_PROMPT },
    { name: 'CODER_PROMPT', prompt: CODER_PROMPT },
    { name: 'REVIEWER_PROMPT', prompt: REVIEWER_PROMPT },
    { name: 'TESTER_PROMPT', prompt: TESTER_PROMPT },
  ];

  for (const { name, prompt } of allPrompts) {
    it(`${name} does not instruct agents to create/edit/read TASKS.md`, () => {
      // Allow the single "do not create or edit" warning
      const withoutWarning = prompt.replace('Do not create or edit any TASKS.md file.', '');
      assert.ok(!withoutWarning.includes('Edit TASKS.md'), `${name} should not reference editing TASKS.md`);
      assert.ok(!withoutWarning.includes('Read TASKS.md'), `${name} should not reference reading TASKS.md`);
      assert.ok(!withoutWarning.includes('Create and maintain TASKS.md'), `${name} should not reference creating TASKS.md`);
      assert.ok(!withoutWarning.includes('commit TASKS.md'), `${name} should not reference committing TASKS.md`);
      assert.ok(!withoutWarning.includes('## TASKS.md Format'), `${name} should not have TASKS.md Format section`);
    });
  }
});
