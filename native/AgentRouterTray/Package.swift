// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "AgentRouterTray", platforms: [.macOS(.v14)], products: [.executable(name: "AgentRouterTray", targets: ["AgentRouterTray"])], dependencies: [.package(url: "https://github.com/zats/Vortex", revision: "ef5392088d4aeb255c4eee83157dbdafcd31bf07")], targets: [.executableTarget(name: "AgentRouterTray", dependencies: [.product(name: "Vortex", package: "Vortex")], resources: [.process("Resources")]), .testTarget(name: "AgentRouterTrayTests", dependencies: ["AgentRouterTray"])])
