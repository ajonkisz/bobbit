export interface ProposalParser {
	tag: string;
	fields: string[];
	requiredFields: string[];
	callbackName: string;
}

export const PROPOSAL_PARSERS: ProposalParser[] = [
	{
		tag: "goal_proposal",
		fields: ["title", "spec", "cwd"],
		requiredFields: ["title", "spec"],
		callbackName: "onGoalProposal",
	},
	{
		tag: "role_proposal",
		fields: ["name", "label", "prompt", "tools", "accessory"],
		requiredFields: ["name", "label", "prompt"],
		callbackName: "onRoleProposal",
	},
	{
		tag: "tool_proposal",
		fields: ["tool", "action", "content"],
		requiredFields: ["tool", "action", "content"],
		callbackName: "onToolProposal",
	},
	{
		tag: "artifact_spec_proposal",
		fields: ["id", "name", "description", "kind", "format", "must-have", "should-have", "must-not-have", "requires", "suggested-role"],
		requiredFields: ["id", "name"],
		callbackName: "onArtifactSpecProposal",
	},
	{
		tag: "personality_proposal",
		fields: ["name", "label", "description", "prompt_fragment"],
		requiredFields: ["name", "label", "prompt_fragment"],
		callbackName: "onPersonalityProposal",
	},
];
