import { addCollection, Icon } from "@iconify/react";
import type { IconifyJSON } from "@iconify/types";
import { vscodeToolIconData } from "./vscode-tool-icons";

let registered = false;

function ensureVscodeToolIcons() {
  if (registered) return;
  registered = true;
  addCollection(vscodeToolIconData as unknown as IconifyJSON);
}

export function ToolVscodeMark({ name }: { name: string }) {
  ensureVscodeToolIcons();
  return <Icon aria-hidden="true" height={16} icon={`vscode-icons:${name}`} width={16} />;
}
