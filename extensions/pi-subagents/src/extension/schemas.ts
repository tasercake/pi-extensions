/** Minimal schemas for recursive Pi subagents. */

import { Type } from "typebox";

export const SpawnSubagentParams = Type.Object(
	{
		task: Type.String({ description: "Task for the child Pi to perform." }),
		async: Type.Boolean({
			description:
				"Run in the background. Spawn multiple concurrent subagents by calling spawn_subagent multiple times with async: true.",
		}),
		timeout: Type.Optional(
			Type.Number({
				minimum: 0.001,
				description:
					"Optional timeout in seconds (default 3600 = 1 hour). When the timeout is reached, the parent is informed that the subagent is still running; the subagent is not killed. Do not kill subagents autonomously to enforce this timeout. Give a healthy timeout margin on top of expected execution time because subagent runtime may be wildly unpredictable.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory for the child Pi. Defaults to the parent cwd.",
			}),
		),
		model: Type.Optional(
			Type.String({ description: "Optional model override for the child Pi." }),
		),
	},
	{ additionalProperties: false },
);

export const GetSubagentStatusParams = Type.Object(
	{
		id: Type.String({ description: "Subagent id returned by spawn_subagent." }),
	},
	{ additionalProperties: false },
);

export const ListSubagentsParams = Type.Object(
	{},
	{ additionalProperties: false },
);

export interface SpawnSubagentParamsLike {
	task: string;
	async: boolean;
	timeout?: number;
	cwd?: string;
	model?: string;
}

export interface GetSubagentStatusParamsLike {
	id: string;
}
