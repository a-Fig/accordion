/**
 * Skill instruction block injected into assembled context when Accordion has
 * folded blocks. Kept under 600 tokens so it adds minimal overhead per turn.
 */

export const ACCORDION_AGENT_SKILL =
`Your context window is managed by Accordion. Earlier turns may appear folded to save space. Three markers identify what happened to each turn:

⟦t7⟧ Cache architecture: standardized on Redis… is a digest (level 2). One-line summary of a full turn. Key facts, exact commands, file paths, and decisions are often absent. Do not guess exact values from a digest.

⟦trim t7⟧ … is a trim (level 1). A structured excerpt keeping the start, end, and key identifiers from the original. Most facts survive but middle detail may be elided.

· t7 folded into the group digest above is a group member (level 3). This turn's content is represented only in the group head summary above it.

When you need an exact value — a command, a path, a config setting, an error message, a decision — and the relevant turn is folded, call accordion_recall with that turn number before answering. Do not fabricate details that are not explicit in the digest. For example: the user asks what the deploy command was, you see ⟦t3⟧ Deploy pipeline: configured CI/CD… — call accordion_recall with turns "3", read the original, then answer. The user needs the full stack trace and you see ⟦t11⟧ Error: build failed… — recall turn 11. You see · t5 folded into the group digest above — recall turn 5.

When you will need the material for several turns of ongoing work, use accordion_unfold instead. Unfold restores the full text into your live context going forward and teaches Accordion to fold less aggressively — your unfold is feedback.

When you are done with a section of work and will not need it again, call accordion_fold to free context budget. Do not recall every folded turn — only recall what you need right now. Do not fold the current turn.

Nothing is ever deleted. Every fold is reversible.`;
