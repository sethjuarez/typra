// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "TypraFixturesFeaturesFieldIdentifiers",
  platforms: [.macOS(.v12), .iOS(.v15)],
  products: [.library(name: "TypraFixturesFeaturesFieldIdentifiers", targets: ["TypraFixturesFeaturesFieldIdentifiers"])],
  dependencies: [
    .package(url: "https://github.com/jpsim/Yams.git", from: "5.1.3")
  ],
  targets: [
    .target(name: "TypraFixturesFeaturesFieldIdentifiers", dependencies: [.product(name: "Yams", package: "Yams")], path: "Sources/TypraFixturesFeaturesFieldIdentifiers")
  ]
)
