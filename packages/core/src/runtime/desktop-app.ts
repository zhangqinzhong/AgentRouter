export const AR_DESKTOP_APP_ENV = "AR_DESKTOP_APP";

export function markDesktopAppRuntime(): void {
  process.env[AR_DESKTOP_APP_ENV] = "1";
}

export function isDesktopAppRuntime(): boolean {
  return process.env[AR_DESKTOP_APP_ENV] === "1" && Boolean((process.versions as NodeJS.ProcessVersions & { electron?: string }).electron);
}
