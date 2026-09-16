import { nativeMenuData } from "./native-menu-data";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import { loadAppConfig, saveAppConfig } from "@agentrouter/core/config/config";
import { onUsageRecorded } from "@agentrouter/core/usage/store";
import type { AppConfig } from "@agentrouter/core/contracts/app";

// Dedicated AppKit/SwiftUI status item. Only aggregate display data crosses
// this private pipe; configuration credentials and request bodies never do.
export class NativeTrayController {
  private child?: ChildProcessWithoutNullStreams;
  private timer?: NodeJS.Timeout;
  private readyTimeout?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private stopped = false;
  constructor(private readonly open: (settings: boolean, update?: boolean) => void, private readonly failed: () => void) {}
  start(): boolean {
    const binary = app.isPackaged ? path.join(process.resourcesPath, "native", "AgentRouterTray") : path.join(__dirname, "native", "AgentRouterTray");
    if (!existsSync(binary)) return false;
    const child = spawn(binary, [path.join(path.dirname(binary), "tray-layeredTemplate.png")], { stdio: ["pipe", "pipe", "pipe"], env: {...process.env, AR_APP_VERSION: app.getVersion()} });
    this.child = child;
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", () => undefined);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.length > 4096) return;
      try {
        const event = JSON.parse(line) as { event?: string; value?: string; id?: string; path?: string; query?: Record<string,string> };
        if (event.event === "request" && event.id && event.path) {
          void nativeMenuData(event.path, event.query ?? {}).then(data => this.send({id:event.id,data})).catch(error => this.send({id:event.id,error:error instanceof Error ? error.message : "Data unavailable"}));
          return;
        }
        if (event.event === "open" || event.event === "settings") { this.hide(); this.open(event.event === "settings"); }
        else if (event.event === "showStats") { void loadAppConfig().then(config=>saveAppConfig({...config,trayShowTokenUsage:event.value === "true"})); }
        else if (event.event === "update") { this.hide(); this.open(false, true); }
        else if (event.event === "about") { app.showAboutPanel(); }
        else if (event.event === "launchAtLogin") { const enabled = event.value === "true"; app.setLoginItemSettings({openAtLogin:enabled}); void loadAppConfig().then(config=>saveAppConfig({...config,launchAtLogin:enabled})).then(config=>this.refresh(config)); }
        else if (event.event === "quit") app.quit();

        else if (event.event === "ready" || event.event === "refresh") { if (this.readyTimeout) clearTimeout(this.readyTimeout); void this.refresh(); }
      } catch { /* Ignore incomplete or unknown native messages. */ }
    });
    const exited = () => {
      if (this.child !== child) return;
      this.stop();
      if (!this.stopped) this.failed();
    };
    child.once("error", exited);
    child.once("exit", exited);
    this.readyTimeout = setTimeout(exited, 10000);
    this.unsubscribe = onUsageRecorded(() => { this.send({type:"activity"}); });
    this.timer = setInterval(() => { void this.refresh(); }, 15000);
    return true;
  }
  hide(): void { this.send({ type: "hide" }); }
  destroy(): void { this.stopped = true; this.stop(); }
  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    const child = this.child; this.child = undefined;
    child?.stdin.end();
    child?.kill();
  }
  private send(value: unknown): void {
    if (this.child?.stdin.writable && this.child.stdin.writableLength < 2 * 1024 * 1024) this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  async refresh(config?: AppConfig): Promise<void> {
    const current=config ?? await loadAppConfig();
    this.send({type:"preferences",launchAtLogin:current.launchAtLogin,petEnabled:current.trayPetEnabled !== false,showStats:current.trayShowTokenUsage,theme:current.theme});
  }
}
