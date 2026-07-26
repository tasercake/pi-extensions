/** Minimal schemas for recursive Pi subagents. */

import { Type } from "typebox";

export const SpawnSubagentParams = Type.Object(
	{
		task: Type.String({ description: "Task for the child Pi to perform." }),
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
	cwd?: string;
	model?: string;
}

export interface GetSubagentStatusParamsLike {
	id: string;
}
