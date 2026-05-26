/** Minimal schemas for recursive Pi subagents. */

import { Type } from "typebox";

export const SpawnSubagentParams = Type.Object({
	task: Type.String({ description: "Task for the child Pi to perform." }),
	async: Type.Boolean({ description: "Run in the background. Spawn multiple concurrent subagents by calling spawn_subagent multiple times with async: true." }),
	timeout: Type.Optional(Type.Number({ minimum: 0.001, description: "Optional timeout in seconds (default 3600 = 1 hour). When the timeout is reached, the parent is informed that the subagent is still running; the subagent is not killed. Do not kill subagents autonomously to enforce this timeout. Give a healthy timeout margin on top of expected execution time because subagent runtime may be wildly unpredictable." })),
	keepContext: Type.Boolean({ description: "Fork the current Pi session when true; start a fresh child session when false." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child Pi. Defaults to the parent cwd." })),
	outputMode: Type.String({ enum: ["inline", "file"], description: "Return/store the child result inline or in a generated result file." }),
	model: Type.Optional(Type.String({ description: "Optional model override for the child Pi." })),
}, { additionalProperties: false });

export const GetSubagentStatusParams = Type.Object({
	id: Type.String({ description: "Subagent id returned by spawn_subagent." }),
}, { additionalProperties: false });

export const ListSubagentsParams = Type.Object({}, { additionalProperties: false });

export interface SpawnSubagentParamsLike {
	task: string;
	async: boolean;
	timeout?: number;
	keepContext: boolean;
	cwd?: string;
	outputMode: "inline" | "file";
	model?: string;
}

export interface GetSubagentStatusParamsLike {
	id: string;
}
