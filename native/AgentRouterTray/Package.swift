// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "AgentRouterTray", platforms: [.macOS(.v14)], products: [.executable(name: "AgentRouterTray", targets: ["AgentRouterTray"])], dependencies: [.package(url: "https://github.com/zats/Vortex", revision: "04a5674590dc0f345c9eb11783746e87a358d950")], targets: [.executableTarget(name: "AgentRouterTray", dependencies: [.product(name: "Vortex", package: "Vortex")], resources: [.process("Resources")]), .testTarget(name: "AgentRouterTrayTests", dependencies: ["AgentRouterTray"])])
