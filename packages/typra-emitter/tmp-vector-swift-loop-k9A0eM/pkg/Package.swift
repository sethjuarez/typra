// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "Proof",
  targets: [
    .target(name: "Proof", path: "Sources/Proof"),
    .testTarget(name: "ProofTests", dependencies: ["Proof"], path: "Tests/ProofTests"),
  ]
)
