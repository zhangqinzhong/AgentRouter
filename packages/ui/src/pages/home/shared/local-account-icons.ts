// Reuse the native menu bar assets instead of maintaining a second set of logos.
import cursorIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/cursor.svg";
import grokIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/grok.svg";
import copilotIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/copilot.svg";
import zcodeIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/zcode.svg";
import kimiIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/kimi.svg";
import geminiIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/gemini.svg";
import kiroIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/kiro.svg";
import antigravityIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/antigravity.svg";
import opencodeIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/opencode.svg";
import commandcodeIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/commandcode.svg";
import qoderIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/qoder.svg";
import qoder_cnIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/qoder-cn.svg";
import volcano_arkIcon from "../../../../../../native/AgentRouterTray/Sources/AgentRouterTray/Resources/brand-logos/volcano-ark.svg";
import codexIcon from "@/assets/agent-logos/codex.png";
import claudeIcon from "@/assets/agent-logos/claude-code.png";

export const localAccountIcons: Record<string, { url: string; monochrome?: boolean }> = {
  codex: { url: codexIcon },
  claude: { url: claudeIcon },
  cursor: { url: cursorIcon, monochrome: true },
  grok: { url: grokIcon, monochrome: true },
  grokbot: { url: grokIcon, monochrome: true },
  copilot: { url: copilotIcon, monochrome: true },
  zcode: { url: zcodeIcon, monochrome: true },
  kimi: { url: kimiIcon, monochrome: true },
  gemini: { url: geminiIcon },
  kiro: { url: kiroIcon, monochrome: true },
  antigravity: { url: antigravityIcon },
  opencodeGo: { url: opencodeIcon },
  commandCode: { url: commandcodeIcon },
  qoder: { url: qoderIcon, monochrome: true },
  qoderCn: { url: qoder_cnIcon },
  codingPlan: { url: volcano_arkIcon },
  agentPlan: { url: volcano_arkIcon },
};
