/** Registers simple Pi continuation split commands for active zellij sessions. */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildPiCommand,
	formatPaneSuccessMessage,
	openCommandInNewSplit,
	type PaneOpenResult,
	type SplitDirection,
} from "./zv-core.ts";

async function openContinueSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
): Promise<PaneOpenResult> {
	return openCommandInNewSplit(pi, direction, buildPiCommand(ctx.cwd));
}

function registerContinueCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (_args, ctx) => {
			const result = await openContinueSplit(pi, ctx, direction);
			if (result.ok) {
				ctx.ui.notify(formatPaneSuccessMessage(successMessage, result.paneId), "info");
			} else {
				ctx.ui.notify(`continuation split failed: ${result.error}`, "error");
			}
		},
	});
}

export default function zvContinueExtension(pi: ExtensionAPI) {
	registerContinueCommand(
		pi,
		"zcv",
		"right",
		"Open a new right split and start Pi in the same working directory",
		"Opened a Pi split to the right",
	);

	registerContinueCommand(
		pi,
		"zch",
		"down",
		"Open a new lower split and start Pi in the same working directory",
		"Opened a Pi split below",
	);
}
