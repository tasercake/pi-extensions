/** Minimal schemas for recursive Pi subagents. */

import { Type } from "typebox";

export const SpawnSubagentParams = Type.Object(
	{
		task: Type.String({ description: "Task for the child Pi to perform." }),
		timeout: Type.Optional(
			Type.Number({
				minimum: 0.001,
				description:
					"Optional timeout in seconds (default 600 = 10 minutes). When the timeout is reached, the parent is informed that the subagent is still running; the subagent is not killed. Do not kill subagents autonomously to enforce this timeout. Give a healthy timeout margin on top of expected execution time because subagent runtime may be wildly unpredictable.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory for the child Pi. Defaults to the parent cwd.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Explicit model override for the child Pi. Omitting it inherits the active parent provider/model.",
			}),
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
	timeout?: number;
	cwd?: string;
	model?: string;
}

export interface GetSubagentStatusParamsLike {
	id: string;
}
