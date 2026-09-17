import AppKit
import SwiftUI
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
 static func requestQuit() { emit("quit") }
 let viewModel = DashboardViewModel()
 let server = ServerManager()
 let login = LaunchAtLoginManager()
 var status: StatusBarController?
 var pet: DesktopPetWindowController!
 var island: DynamicIslandController!
 var defaultsObserver: NSObjectProtocol?
 var expectedShowStats: Bool?
 func applicationDidFinishLaunching(_ note: Notification) {
  NSApp.setActivationPolicy(.accessory)
  let iconURL = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent(AppBrand.iconFile)
  if let icon = NSImage(contentsOf: iconURL) { NSApp.applicationIconImage = icon }
  if UserDefaults.standard.object(forKey: MenuBarIconStyle.defaultsKey) == nil { MenuBarIconStyle.setCurrent(.static) }
  NativeLocalization.synchronizeSharedPreference()
  pet = DesktopPetWindowController(viewModel: viewModel)
  island = DynamicIslandController(viewModel: viewModel)
  status = StatusBarController(viewModel: viewModel, serverManager: server, launchAtLoginManager: login, desktopPetController: pet, dynamicIslandController: island)
  defaultsObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object:nil, queue:.main) { [weak self] _ in
   guard let delegate = self else { return }
   Task { @MainActor in
    guard let previous=delegate.expectedShowStats else { return }
    let next=UserDefaults.standard.bool(forKey:"MenuBarShowStats")
    if next != previous { delegate.expectedShowStats=next; emit("showStats",next ? "true" : "false") }
   }
  }
  DispatchQueue.global(qos:.utility).async {
   while let line=readLine(),let data=line.data(using:.utf8) { Task { @MainActor in
    if let obj=try? JSONSerialization.jsonObject(with:data) as? [String:Any],let type=obj["type"] as? String {
     if type=="activity" { self.status?.receiveHostActivity() }
     else if type=="hide" { StatusBarController.prepareForSystemAlert() }
     else if type=="preferences" {
      self.login.isEnabled = obj["launchAtLogin"] as? Bool ?? false
      NativeMenuPreferences.shared.petEnabled = obj["petEnabled"] as? Bool ?? true
      if let theme=obj["theme"] as? String { NSApp.appearance = theme=="dark" ? NSAppearance(named:.darkAqua) : theme=="light" ? NSAppearance(named:.aqua) : nil }
      if let show=obj["showStats"] as? Bool { self.expectedShowStats=show; UserDefaults.standard.set(show,forKey:"MenuBarShowStats") }
      NotificationCenter.default.post(name:.nativeSettingsChanged,object:nil)
     }
    } else { await NativeTransport.shared.receive(data) }
   } }
   DispatchQueue.main.async { NSApp.terminate(nil) }
  }
  Task {
   await viewModel.loadAll(); viewModel.startAutoRefresh()
   let summary: [String: Any] = ["today": viewModel.todayTokens, "total": viewModel.totalTokens, "models": viewModel.topModels.count, "daily": viewModel.daily.count, "heatmapWeeks": viewModel.heatmap?.weeks.count ?? 0, "online": viewModel.serverOnline]
   if let data=try? JSONSerialization.data(withJSONObject:summary),let value=String(data:data,encoding:.utf8){emit("loaded",value)}
  }
  emit("ready", Bundle.module.bundlePath)
 }
}
let app=NSApplication.shared
MainActor.assumeIsolated { let delegate=AppDelegate();app.delegate=delegate;app.run() }
