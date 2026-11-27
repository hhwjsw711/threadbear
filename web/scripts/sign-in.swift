// Signs a browser in to the Threadbear website (docs/website.md) without its
// token ever being printed, copied, left on disk or put in a link. Issues a
// one-use sign-in code, good for ten minutes, with `npx convex run
// tokens:issueCode` (so only someone logged in to the Convex team can do it)
// and puts it in the link's #fragment, which never reaches a server; the page
// trades it for the browser's token with tokens:claim and wipes it from the
// address bar. A link with the token itself stayed good for 90 days wherever
// it was seen (API 81).
//
//   npm run web:sign-in                       the default browser, prod site
//   npm run web:sign-in -- --qr               a QR code to scan on another device
//   npm run web:sign-in -- --dev              the dev deployment's site
//   npm run web:sign-in -- --local            Vite on localhost:5181 (dev data)
//   npm run web:sign-in -- --name web-work --days 30
//
// Revoke with: npx convex run tokens:revoke '{"name":"web-mac"}' --prod
import AppKit
import CoreImage

// Production uses runner.json's sync.site for a custom domain or a
// self-hosted website. Otherwise use the deployment's .convex.site twin.
// The dev deployment still comes from the repo's .env.local.
func siteOf(_ cloud: String?, site: String? = nil) -> String? {
    if let site = site?.trimmingCharacters(in: .whitespacesAndNewlines), !site.isEmpty {
        return site.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    guard let cloud, cloud.contains(".convex.cloud") else { return nil }
    return cloud.replacingOccurrences(of: ".convex.cloud", with: ".convex.site").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
}
let dataDir = ProcessInfo.processInfo.environment["THREADBEAR_HOME"] ?? (NSHomeDirectory() + "/Library/Application Support/Threadbear")
let runnerJson = (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: dataDir + "/runner.json")))) as? [String: Any]
let sync = runnerJson?["sync"] as? [String: Any]
let prodURL = siteOf(sync?["url"] as? String, site: sync?["site"] as? String)
let envLocal = (try? String(contentsOfFile: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path + "/.env.local", encoding: .utf8)) ?? ""
let devURL = siteOf(envLocal.split(separator: "\n").first { $0.hasPrefix("CONVEX_URL=") }.map { String($0.dropFirst("CONVEX_URL=".count)).components(separatedBy: " ").first ?? "" })

let args = Array(CommandLine.arguments.dropFirst())
let qr = args.contains("--qr")
let local = args.contains("--local")
let prod = !args.contains("--dev") && !local
func value(_ flag: String, _ fallback: String) -> String {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return fallback }
    return args[i + 1]
}
let name = value("--name", qr ? "web-qr" : "web-mac") + (prod ? "" : "-dev")
let days = Int(value("--days", "90")) ?? 90
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
guard let site = local ? "http://localhost:5181" : prod ? prodURL : devURL else {
    fail(prod ? "No website address in \(dataDir)/runner.json. Set sync.site or run ./threadbear setup first." : "No CONVEX_URL in the repo's .env.local.")
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

var issue = ["npx", "convex", "run", "tokens:issueCode", "{\"name\":\"\(name)\",\"days\":\(days),\"kind\":\"browser\"}"]
if prod { issue.append("--prod") }
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
p.arguments = issue
p.currentDirectoryURL = root
let out = Pipe()
p.standardOutput = out
p.standardError = FileHandle.standardError
try! p.run()
let data = out.fileHandleForReading.readDataToEndOfFile()
p.waitUntilExit()
guard p.terminationStatus == 0 else { fail("npx convex run tokens:issueCode failed") }
let output = String(decoding: data, as: UTF8.self)
guard let json = output.range(of: #"\{[\s\S]*\}"#, options: .regularExpression).map({ String(output[$0]) }),
      let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
      let code = object["code"] as? String else { fail("Couldn't read the code from tokens:issueCode") }

let link = "\(site)/#code=\(code)"

if qr {
    let filter = CIFilter(name: "CIQRCodeGenerator")!
    filter.setValue(Data(link.utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    let image = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("threadbear-web-\(UUID().uuidString.prefix(6)).png")
    try! NSBitmapImageRep(ciImage: image).representation(using: .png, properties: [:])!.write(to: file)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    NSWorkspace.shared.open(file)
    // Preview has the picture once it's open, so no copy of the code stays
    // on disk (same as ios/scripts/pair-qr.swift).
    Thread.sleep(forTimeInterval: 3)
    try? FileManager.default.removeItem(at: file)
    print("Showing a sign-in QR for \"\(name)\" (\(site), \(days) days). Scan it with the camera, then close Preview.")
} else {
    // The default browser, as Settings > Phone & browser > Open signed in
    // uses: this once always picked Chrome when it was installed, so someone
    // on Dia or Arc got a signed-in Chrome instead of their own browser.
    let url = URL(string: link)!
    let done = DispatchSemaphore(value: 0)
    NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in done.signal() }
    done.wait()
    print("Opened \(site) signed in as \"\(name)\" (\(days) days).")
}
print("Revoke with: npx convex run tokens:revoke '{\"name\":\"\(name)\"}'\(prod ? " --prod" : "")")
