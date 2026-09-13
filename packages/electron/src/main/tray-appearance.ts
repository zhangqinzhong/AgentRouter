export function layeredTrayAssetName(platform: NodeJS.Platform, dark: boolean): string {
  if (platform === "darwin") {
    return "tray-layeredTemplate.png";
  }
  return dark ? "tray-layered-dark.png" : "tray-layered-light.png";
}

export function trayUsageTitle(title: string, showTokenUsage: boolean): string {
  return showTokenUsage ? title : "";
}
