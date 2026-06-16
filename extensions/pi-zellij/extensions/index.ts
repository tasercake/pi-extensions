/** Bundles all pi-zellij extension modules into one Pi extension entrypoint. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import zvSplitExtension from "./zv-split.ts";
import zvZoxideExtension from "./zv-zoxide.ts";
import zvContinueExtension from "./zv-continue.ts";
import zvOpenExtension from "./zv-open.ts";
import zvHighlightExtension from "./zv-highlight.ts";

export default function piZellijExtensionBundle(pi: ExtensionAPI) {
	zvSplitExtension(pi);
	zvZoxideExtension(pi);
	zvContinueExtension(pi);
	zvOpenExtension(pi);
	zvHighlightExtension(pi);
}
