import CoreGraphics
import Foundation
import ImageIO

/// An in-memory backend for the simulator, screenshots and previews, so the
/// app can be built and looked at without a runner or a deployment. It
/// plays the runner's part too: a sent message starts a short turn that
/// ends with a canned reply.
public final class FakeBackend: Backend, @unchecked Sendable {
    private let lock = NSLock()
    private var threadsById: [String: PhoneThread]
    private var messagesById: [String: [PhoneMessage]]
    private var runnerList: [PhoneRunner]
    private var scheduleList: [PhoneSchedule]
    private var pocketCards = FakeBackend.samplePocket
    private var commands: [String: CommandStatus] = [:]
    /// Messages sent while the runner's offline (`runnerOnline: false`),
    /// by thread, as phone:waiting lists them.
    private var waitingByThread: [String: [WaitingSend]] = [:]
    private var listeners: [UUID: @Sendable () -> Void] = [:]
    /// How long a fake turn takes. Zero in tests.
    private let turnDelay: Duration
    /// How long a new thread takes to start (AppModel's -ThreadbearSlowStart
    /// makes it long, so the inbox's Starting row stays for a screenshot).
    public var startDelay: Duration = .seconds(1.5)
    /// What a new thread's first turn says, and how long it takes (nil: the
    /// usual turn). AppModel's -ThreadbearNewReply and -ThreadbearNewTurn set
    /// them, so a filmed new thread gets a believable answer.
    public var newThreadReply = "On it. Here's what I found."
    public var newThreadTurn: Duration?
    /// How long an answer to a card waits for the "runner" to take it, to see
    /// the card waiting. Nothing changes until then, as on a real one.
    public var answerDelay: Duration = .zero
    /// And then it refuses them, to see a card coming back.
    public var answersFail = false
    /// Changes (star, wake, archive, rename...), reply buttons and Stop wait
    /// this long for the "runner", to see them on their way.
    public var changeDelay: Duration = .zero
    /// And then it refuses them, to see one put back with why.
    public var changesFail = false
    /// The "runner" never takes changes, reply buttons or Stop, as with the
    /// Mac asleep, to see them time out.
    public var holdsCommands = false
    private var updates = 0
    /// How many changes have been sent, for tests that a second tap sends none.
    public var updateCount: Int { lock.withLock { updates } }
    /// How long the thread lists take to answer the first time, to see the
    /// app's loading rows (`-ThreadbearSlowLoad`). Zero normally.
    private let listDelay: Duration
    private var imagesById: [String: [MessageImage]] = [:]

    /// `runners`: the Mac asleep and two more runners online (`-ThreadbearRunners`),
    /// for the new thread sheet's runner picker. Left out of the usual samples.
    /// `queued`: with the runner offline, a3 already has two messages
    /// waiting for it, for the screenshots.
    public init(now: Date = .now, turnDelay: Duration = .seconds(2), runnerOnline: Bool = true, listDelay: Duration = .zero, pictures: Bool = false, long: Bool = false, secret: Bool = false, diagrams: Bool = false, code: Bool = false, runners: Bool = false, queued: Bool = false, many: Bool = false, loginMoved: Bool = false) {
        let sample = Self.sample(now: now)
        threadsById = Dictionary(uniqueKeysWithValues: sample.threads.map { ($0.threadId, $0) })
        messagesById = sample.messages
        // Left out of the usual samples, which the App Store shots are of.
        if pictures {
            let thread = Self.pictureThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
            imagesById[thread.thread.threadId] = thread.images
        }
        if loginMoved {
            let thread = Self.loginMovedThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
        }
        if long {
            let thread = Self.longThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
            imagesById[thread.thread.threadId] = thread.images
        }
        if diagrams {
            let thread = Self.diagramThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
        }
        if code {
            let thread = Self.codeThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
        }
        if many {
            for thread in Self.manyThreads(now: now) { threadsById[thread.threadId] = thread }
        }
        if secret {
            let thread = Self.secretThread(now: now)
            threadsById[thread.thread.threadId] = thread.thread
            messagesById[thread.thread.threadId] = thread.messages
        }
        scheduleList = sample.schedules
        runnerList = [PhoneRunner(runnerId: "mac", name: "MacBook Pro", version: "0.1.0",
                                  lastSeenAt: runnerOnline && !runners ? now : now.addingTimeInterval(-3 * 3600),
                                  placed: runners ? true : nil, main: true,
                                  usagePools: Self.samplePools, defaults: Self.sampleDefaults)]
        if runners {
            runnerList += [PhoneRunner(runnerId: "mini", name: "Mac mini", version: "0.1.0", lastSeenAt: now, placed: true,
                                       usagePools: Self.samplePools, defaults: Self.sampleDefaults),
                           PhoneRunner(runnerId: "cloud", name: "Cloud", version: "0.1.0", lastSeenAt: now, placed: true,
                                       usagePools: Self.samplePools, defaults: Self.sampleDefaults)]
        }
        self.turnDelay = turnDelay
        self.listDelay = listDelay
        if queued {
            let at = now.timeIntervalSince1970 * 1000
            waitingByThread["a3"] = [
                WaitingSend(commandId: "cmd_q1", state: .pending, text: "Yes, ship it", createdAt: at - 120_000),
                WaitingSend(commandId: "cmd_q2", state: .pending, text: "And check it on the iPad too while you're there", createdAt: at - 60_000),
            ]
            for send in waitingByThread["a3"]! { commands[send.commandId] = CommandStatus(state: .pending) }
        }
    }

    // MARK: A long inbox

    /// `-ThreadbearManyThreads`: a couple more starred, a screenful or two of
    /// inbox and a few more running, for scrolling a long inbox and seeing its
    /// headings stick at the top. Left out of the usual samples.
    static func manyThreads(now: Date) -> [PhoneThread] {
        let site = [ProjectRef(id: "p_site", title: "Website")]
        let garden = [ProjectRef(id: "p_garden", title: "Garden planner")]
        let titles = ["Fix the flaky login test", "Bigger tap targets on the map", "Why is the build slow?",
                      "Move the images to a CDN", "Dark mode for the charts", "Write up the release notes",
                      "Rate limit the signup form", "Sort the plants by season", "Clean up the old migrations",
                      "Typo on the pricing page", "Cache the weather lookups", "Add a sitemap",
                      "Try the new font", "Export the garden as a PDF", "Look into the memory spike",
                      "Shorter onboarding", "Retry failed uploads", "Check the broken links",
                      "Make the footer less shouty", "Speed up the search index", "Tidy the colour tokens",
                      "Watering reminders", "Fix the date on old posts", "Keyboard shortcuts for the editor"]
        var threads: [PhoneThread] = []
        for (i, title) in titles.enumerated() {
            threads.append(PhoneThread(threadId: "m\(i)", title: title, cwd: i % 2 == 0 ? "~/code/website" : "~/code/garden-planner",
                                       unread: i % 5 == 0, preview: "Done.", lastActivityAt: now.addingTimeInterval(-Double(30 + i * 47) * 60),
                                       projects: i % 3 == 0 ? nil : (i % 2 == 0 ? site : garden)))
        }
        for (i, (title, working)) in [("Upgrade the test runner", "Running the tests"), ("Resize the hero images", "Editing images.ts"),
                                       ("Find the slow query", "Reading the logs"), ("Split up the settings page", "Editing Settings.tsx"),
                                       ("Add plant photos", "Downloading samples"),
                                       ("Bump the dependencies", "Running npm install"), ("Fix the RSS feed", "Editing feed.ts"),
                                       ("Profile the startup time", "Running the profiler"), ("Translate the help pages", "Editing help.md")].enumerated() {
            threads.append(PhoneThread(threadId: "mr\(i)", title: title, cwd: "~/code/website", status: .running, preview: "On it.",
                                       lastActivityAt: now.addingTimeInterval(-Double(2 + i * 3) * 60), projects: site, working: working))
        }
        for (i, title) in ["Ideas for the spring update", "Keep an eye on the error rate"].enumerated() {
            threads.append(PhoneThread(threadId: "ms\(i)", title: title, cwd: "~/code/garden-planner", preview: "Noted.",
                                       lastActivityAt: now.addingTimeInterval(-Double(90 + i * 60) * 60),
                                       starredAt: now.addingTimeInterval(-Double(i + 1) * 86_400), projects: garden))
        }
        return threads
    }

    // MARK: A thread asking for a secret

    /// `-ThreadbearSecret`: one thread waiting on a secret card. Left out of
    /// the usual samples, which the App Store shots are of. The key is a
    /// made-up one (the seal test's), so the demo never pins a real runner's.
    static let sampleSecretKey = "pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk="
    /// What the demo keeps as if a pairing link had carried it, so its
    /// secret card can be answered (the thread is on the default "mac").
    public static let sampleRunnerKeys = ["mac": sampleSecretKey]

    private static func secretThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(
            threadId: "secret", title: "Deploy the docs site", cwd: "~/code/website", status: .waiting, needsYou: true,
            preview: "I need a deploy token to go on.", lastActivityAt: ago(1),
            pendingApproval: .secret(id: "sec1", label: "Hosting deploy token",
                                     reason: "To deploy the docs site. Make one under Account, then API tokens, with deploy access.",
                                     placeholder: nil, key: sampleSecretKey))
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "Deploy the docs site when the build's green", at: ago(6)),
            PhoneMessage(seq: 2, role: .tool, text: "Run the docs build", toolKind: "command", at: ago(4)),
            PhoneMessage(seq: 3, role: .assistant, text: "The build's green. I need a deploy token to go on.", at: ago(1)),
        ]
        return (thread, messages)
    }

    // MARK: A thread with a diagram and a page

    /// `-ThreadbearDiagrams`: a reply with a mermaid diagram and an html
    /// block, drawn as what they show (RichBlockView).
    private static func diagramThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "diagrams", title: "Make uploads resume after a crash", cwd: "~/dev/photo-sync",
                                 preview: "Here's how resuming works now.", lastActivityAt: ago(1))
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "How does resuming work now? Draw it for me", at: ago(4)),
            PhoneMessage(seq: 2, role: .assistant, text: """
            Here's how resuming works now. Each chunk saves its offset, so a crash picks up where it left off:

            ```mermaid
            flowchart TD
              A[Upload starts] --> B{Saved offset?}
              B -- yes --> C[Resume from offset]
              B -- no --> D[Start at zero]
              C --> E[Send chunk]
              D --> E
              E --> F{More chunks?}
              F -- yes --> E
              F -- no --> G[Mark done]
            ```

            And the speed difference from the test run:

            ```html
            <div style="font:15px -apple-system;padding:14px;background:#fafafa;color:#222;border-radius:8px">
              <b>Upload time, before and after</b>
              <div style="margin-top:8px">Before</div>
              <div style="height:14px;background:#e5e5e5;border-radius:4px"><div style="width:92%;height:100%;background:#3b82f6;border-radius:4px"></div></div>
              <div style="margin-top:8px">After</div>
              <div style="height:14px;background:#e5e5e5;border-radius:4px"><div style="width:34%;height:100%;background:#22c55e;border-radius:4px"></div></div>
            </div>
            ```
            """, at: ago(1)),
        ]
        return (thread, messages)
    }

    // MARK: A thread with code blocks

    /// `-ThreadbearCode`: a reply with a ```sql, a ```ts and an untagged
    /// block, each under its header strip (CodeBlockView), then one with
    /// ```bash, ```diff, ```python and ```yaml, coloured by language.
    private static func codeThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "code", title: "Find the slow orders query", cwd: "~/code/api",
                                 preview: "Deployed.", lastActivityAt: ago(1))
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "Why is the orders page so slow?", at: ago(5)),
            PhoneMessage(seq: 2, role: .assistant, text: """
            Found it: the orders query scans the whole table. This index fixes it:

            ```sql
            CREATE INDEX orders_customer_created
              ON orders (customer_id, created_at DESC);
            ```

            And the query now asks for one page at a time:

            ```ts
            const orders = await db.query("orders")
              .withIndex("by_customer", (q) => q.eq("customerId", id))
              .order("desc")
              .take(50);
            ```

            Before and after, from the test run:

            ```
            before  1,840 ms
            after      12 ms
            ```
            """, at: ago(3)),
            PhoneMessage(seq: 3, role: .user, text: "Ship it, and check the nightly report still adds up.", at: ago(2)),
            PhoneMessage(seq: 4, role: .assistant, text: """
            Deployed:

            ```bash
            # push the index first, then the code
            npx convex deploy --yes 2>&1 | tail -3
            echo "done at $(date)"
            ```

            The report's total was off by one:

            ```diff
            @@ -12,3 +12,3 @@ def nightly_total(rows):
            -    return sum(r.amount for r in rows[1:])
            +    return sum(r.amount for r in rows)
            ```

            ```python
            def nightly_total(rows: list[Order]) -> float:
                \"\"\"Every order from the last day.\"\"\"
                return sum(r.amount for r in rows if r.paid is not None)  # cents
            ```

            And it runs at 2 am:

            ```yaml
            on:
              schedule:
                - cron: "0 2 * * *"
            jobs:
              report:
                runs-on: ubuntu-latest
                timeout-minutes: 10
            ```
            """, at: ago(1)),
        ]
        return (thread, messages)
    }

    // MARK: A thread whose login ran out

    /// `-ThreadbearLoginNote`: a thread that hit its login's limit part way
    /// through, moved to another login and carried on, with the runner's
    /// line saying so ("moved").
    private static func loginMovedThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "moved", title: "Land the error bar fix", cwd: "~/dev/threadbear", preview: "The fix is on main now.", lastActivityAt: ago(1))
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "Land the error bar fix on main and tell me when it's there.", at: ago(30)),
            PhoneMessage(seq: 2, role: .tool, text: "Land the fix on main", toolKind: "command", turn: "aaaa1111", at: ago(29)),
            PhoneMessage(seq: 3, role: .assistant, text: "The landing is running, behind two others in the queue.", turn: "aaaa1111", at: ago(28)),
            PhoneMessage(seq: 4, role: .assistant, text: "You've hit your 5-hour limit · resets 11:30am", turn: "bbbb2222", at: ago(7)),
            PhoneMessage(seq: 5, role: .note, text: "Moved to alex@home.example: alex@work.example hit its 5-hour limit, back at 11:30 am.", at: ago(7)),
            PhoneMessage(seq: 6, role: .user, text: "Your last login hit its usage limit partway through that turn, so this thread has moved to another one. Carry on from where you left off.", origin: "runner", turn: "cccc3333", at: ago(7)),
            PhoneMessage(seq: 7, role: .tool, text: "Push main", toolKind: "command", turn: "cccc3333", at: ago(6)),
            PhoneMessage(seq: 8, role: .assistant, text: "The fix is on main now.\n\n- **What changed:** a failed action shows in the bar over the thread, which has Dismiss.\n- **Checks:** they passed in 267 s.", turn: "cccc3333", at: ago(5)),
        ]
        return (thread, messages)
    }

    // MARK: A thread with pictures

    /// `-ThreadbearPictures`: one thread with each way a picture can come:
    /// photos sent with Mike's message, wide in a reply, tall in a reply, animated, pinned, and one only on the
    /// Mac.
    private static func pictureThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage], images: [MessageImage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "pics", title: "Back panel screw layout", cwd: "~/dev/workbench", preview: "Here's where the screws go.", lastActivityAt: ago(2))
        let wide = "/Users/you/guide/back-screws.png", tall = "/Users/you/guide/case-side.png", moving = "/Users/you/guide/which-way.gif"
        let messages = [
            PhoneMessage(seq: 1, role: .user, text: "Where do the back screws go? This is the sheet that came with it.\n\n[2 pictures]", origin: "phone", at: ago(9)),
            PhoneMessage(seq: 2, role: .tool, text: "Wrote guide/back-screws.png", toolKind: "write", at: ago(7)),
            PhoneMessage(seq: 3, role: .tool, text: "threadbear: pin", toolKind: "mcp", at: ago(6)),
            PhoneMessage(seq: 4, role: .assistant, text: """
            Here's where the screws go, all round the outside edge:

            ![Back screw layout](\(wide))

            - **Top and bottom:** 5 screws each.
            - **Each side:** 2 screws.

            The side view, which is tall:

            ![Side view](\(tall))

            Which way it turns:

            ![Which way it turns](\(moving))

            And the first go, which I haven't got any more:

            ![First attempt](/Users/you/guide/first-go.png)
            """, at: ago(2)),
        ]
        let images = [
            // The two photos sent with the question, as the runner puts them up.
            MessageImage(seq: 1, src: "picture:1", url: samplePicture("sent-1", width: 1200, height: 1600, hue: 0.12), width: 1200, height: 1600),
            MessageImage(seq: 1, src: "picture:2", url: samplePicture("sent-2", width: 1600, height: 1200, hue: 0.75), width: 1600, height: 1200),
            MessageImage(seq: 3, pinned: true, url: samplePicture("pinned", width: 900, height: 900, hue: 0.33), width: 900, height: 900),
            MessageImage(seq: 4, src: wide, url: samplePicture("wide", width: 1600, height: 900, hue: 0.58), width: 1600, height: 900),
            MessageImage(seq: 4, src: tall, url: samplePicture("tall", width: 800, height: 2000, hue: 0.08), width: 800, height: 2000),
            MessageImage(seq: 4, src: moving, url: sampleAnimation("moving", width: 720, height: 480), width: 720, height: 480),
        ]
        return (thread, messages, images)
    }

    // MARK: A long thread

    /// `-ThreadbearLong`: a build-along thread, "long": hundreds of rows of
    /// long replies, tool lines and pictures, for opening a big thread.
    private static func longThread(now: Date) -> (thread: PhoneThread, messages: [PhoneMessage], images: [MessageImage]) {
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        let thread = PhoneThread(threadId: "long", title: "Drawer build along", cwd: "~/dev/workbench", preview: "On to the runners.", lastActivityAt: ago(1))
        let picture = samplePicture("long", width: 1600, height: 1200, hue: 0.12)
        var messages: [PhoneMessage] = []
        var images: [MessageImage] = []
        var seq = 0
        let turns = 150
        for turn in 0 ..< turns {
            let at = ago(Double(turns - turn))
            seq += 1
            messages.append(PhoneMessage(seq: seq, role: .user, text: "Step \(turn): how does this look?", at: at))
            for tool in 0 ..< 3 {
                seq += 1
                messages.append(PhoneMessage(seq: seq, role: .tool, text: "Read guide/step-\(turn)-\(tool).md", toolKind: "read", at: at))
            }
            seq += 1
            let src = "/Users/you/guide/step-\(turn).png"
            let body = String(repeating: "Keep the pieces clamped tight, then drill until the cone has cut a recess about as wide as the screw head. ", count: 4)
            messages.append(PhoneMessage(seq: seq, role: .assistant, text: """
            **Step \(turn).** \(body)

            ![Step \(turn)](\(src))

            - **Glue:** leave the clamps on for about an hour.
            - **Screws:** evenly spaced and sitting flush.

            \(body)
            """, at: at))
            images.append(MessageImage(seq: seq, src: src, url: picture, width: 1600, height: 1200))
        }
        return (thread, messages, images)
    }

    /// A drawn picture with a grid and a cross, so zooming and fitting show.
    private static func samplePicture(_ name: String, width: Int, height: Int, hue: CGFloat) -> String {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sample-\(name).png")
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return file.absoluteString }
        c.setFillColor(CGColor(red: 0.2 + hue, green: 0.55, blue: 1.1 - hue, alpha: 1))
        c.fill(CGRect(x: 0, y: 0, width: width, height: height))
        c.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.7))
        c.setLineWidth(3)
        for x in stride(from: 0, through: width, by: 100) { c.strokeLineSegments(between: [CGPoint(x: x, y: 0), CGPoint(x: x, y: height)]) }
        for y in stride(from: 0, through: height, by: 100) { c.strokeLineSegments(between: [CGPoint(x: 0, y: y), CGPoint(x: width, y: y)]) }
        c.setLineWidth(12)
        c.strokeLineSegments(between: [.zero, CGPoint(x: width, y: height), CGPoint(x: width, y: 0), CGPoint(x: 0, y: height)])
        if let image = c.makeImage(), let out = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(out, image, nil)
            CGImageDestinationFinalize(out)
        }
        return file.absoluteString
    }

    /// A sound's still as the runner draws one: bars on dark.
    private static func sampleWaveform(_ name: String, width: Int, height: Int) -> String {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sample-\(name).png")
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return file.absoluteString }
        c.setFillColor(CGColor(red: 0.1, green: 0.12, blue: 0.16, alpha: 1))
        c.fill(CGRect(x: 0, y: 0, width: width, height: height))
        c.setFillColor(CGColor(red: 0.55, green: 0.75, blue: 1, alpha: 1))
        let bars = 80, step = CGFloat(width) / CGFloat(bars)
        for i in 0..<bars {
            let t = Double(i) / Double(bars)
            let level = (0.15 + 0.85 * exp(-4 * t)) * (0.6 + 0.4 * abs(sin(Double(i) * 1.7)))
            let h = CGFloat(level) * CGFloat(height) * 0.85
            c.fill(CGRect(x: CGFloat(i) * step + step * 0.2, y: (CGFloat(height) - h) / 2, width: step * 0.6, height: h))
        }
        if let image = c.makeImage(), let out = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(out, image, nil)
            CGImageDestinationFinalize(out)
        }
        return file.absoluteString
    }

    /// A second and a half of a fading two-note chime, as a 16-bit WAV.
    private static func sampleChime(_ name: String) -> String {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sample-\(name).wav")
        let rate = 16_000, count = rate * 3 / 2
        var samples = Data(capacity: count * 2)
        for i in 0..<count {
            let t = Double(i) / Double(rate)
            let tone = t < 0.4 ? sin(2 * .pi * 660 * t) : sin(2 * .pi * 880 * t)
            let value = Int16(max(-1, min(1, tone * exp(-2.5 * t) * 0.6)) * Double(Int16.max))
            withUnsafeBytes(of: value.littleEndian) { samples.append(contentsOf: $0) }
        }
        func le<T: FixedWidthInteger>(_ v: T) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        var wav = Data("RIFF".utf8) + le(UInt32(36 + samples.count)) + Data("WAVEfmt ".utf8)
        wav += le(UInt32(16)) + le(UInt16(1)) + le(UInt16(1)) + le(UInt32(rate)) + le(UInt32(rate * 2)) + le(UInt16(2)) + le(UInt16(16))
        wav += Data("data".utf8) + le(UInt32(samples.count)) + samples
        try? wav.write(to: file, options: .atomic)
        return file.absoluteString
    }

    /// A GIF of a bar crossing the frame, holding longer on its last frame, so
    /// it shows whether a picture plays and keeps each frame's own time.
    private static func sampleAnimation(_ name: String, width: Int, height: Int) -> String {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("sample-\(name).gif")
        let frames = 12
        guard let out = CGImageDestinationCreateWithURL(file as CFURL, "com.compuserve.gif" as CFString, frames, nil) else { return file.absoluteString }
        CGImageDestinationSetProperties(out, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        for frame in 0..<frames {
            guard let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
            c.setFillColor(CGColor(red: 0.16, green: 0.3, blue: 0.5, alpha: 1))
            c.fill(CGRect(x: 0, y: 0, width: width, height: height))
            c.setFillColor(CGColor(red: 1, green: 0.8, blue: 0.2, alpha: 1))
            c.fill(CGRect(x: (width - 80) * frame / (frames - 1), y: 0, width: 80, height: height))
            guard let image = c.makeImage() else { continue }
            let delay = frame == frames - 1 ? 0.8 : 0.1
            CGImageDestinationAddImage(out, image, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary)
        }
        CGImageDestinationFinalize(out)
        return file.absoluteString
    }

    // MARK: Live reads

    private func watch<T: Sendable>(_ read: @escaping @Sendable () -> T) -> AsyncThrowingStream<T, Error> {
        AsyncThrowingStream { continuation in
            let id = UUID()
            let push: @Sendable () -> Void = { continuation.yield(read()) }
            lock.withLock { listeners[id] = push }
            push()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.withLock { _ = self.listeners.removeValue(forKey: id) }
            }
        }
    }

    private func changed() {
        let all = lock.withLock { Array(listeners.values) }
        for push in all { push() }
    }

    private func mutate(_ body: (FakeBackend) -> Void) {
        lock.withLock { body(self) }
        changed()
    }

    /// Only these sample threads, for screenshots of a short inbox.
    public func keepOnly(_ ids: Set<String>) {
        mutate { s in s.threadsById = s.threadsById.filter { ids.contains($0.key) } }
    }

    /// The running sample thread's turn ends by itself after a while, to watch
    /// its row move to the inbox.
    /// Every runner online, the MacBook Pro too (-ThreadbearRunners has it
    /// asleep), so the new thread sheet picks it, for filming.
    public func wakeRunners() {
        mutate { s in for i in s.runnerList.indices { s.runnerList[i].lastSeenAt = .now } }
    }

    public func finishRunningThread(after delay: Duration) {
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.mutate { s in
                s.threadsById["a5"]?.status = .idle
                s.threadsById["a5"]?.working = nil
                s.threadsById["a5"]?.unread = true
                s.threadsById["a5"]?.lastActivityAt = .now
            }
        }
    }

    public func me() async throws -> PhoneIdentity {
        // Always a current backend, so the demo never says the Mac needs updating.
        PhoneIdentity(name: "iphone", expiresAt: Date.now.addingTimeInterval(90 * 86_400),
                      apiVersion: BackendCompatibility.currentAPIVersion, site: "https://example.convex.site")
    }

    public func runners() -> AsyncThrowingStream<[PhoneRunner], Error> {
        watch { [unowned self] in lock.withLock { runnerList } }
    }

    public func pocket() -> AsyncThrowingStream<[PocketCard], Error> {
        watch { [unowned self] in lock.withLock { pocketCards } }
    }

    public func removePocketCard(id: String) async throws {
        mutate { s in s.pocketCards.removeAll { $0.id == id } }
    }

    public func projects() -> AsyncThrowingStream<[PhoneProject], Error> {
        watch { Self.sampleProjects }
    }

    public func inboxChanges() -> AsyncThrowingStream<[PhoneThread], Error> { threads(.inbox) }

    public func threads(_ view: ThreadsView) -> AsyncThrowingStream<[PhoneThread], Error> {
        let live = liveThreads(view)
        guard listDelay > .zero else { return live }
        let delay = listDelay
        return AsyncThrowingStream { continuation in
            let task = Task {
                try? await Task.sleep(for: delay)
                do {
                    for try await value in live { continuation.yield(value) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func search(_ text: String, everywhere: Bool) async throws -> [PhoneThread] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return lock.withLock { Array(threadsById.values) }
            .filter { (everywhere || $0.archivedAt != nil) && ThreadSearch.matches($0, query) }
            .sorted { $0.lastActivityAt > $1.lastActivityAt }
    }

    private func liveThreads(_ view: ThreadsView) -> AsyncThrowingStream<[PhoneThread], Error> {
        watch { [unowned self] in
            let all = lock.withLock { Array(threadsById.values) }
            let now = Date.now
            return all.filter { t in
                switch view {
                case .den: t.archivedAt != nil
                case .hibernating: t.archivedAt == nil && t.coordinatorProjectId == nil && t.starredAt == nil && InboxSections.isSnoozed(t, now: now)
                case .inbox: t.archivedAt == nil && (t.coordinatorProjectId != nil || t.starredAt != nil || !InboxSections.isSnoozed(t, now: now))
                }
            }.sorted { $0.lastActivityAt > $1.lastActivityAt }
        }
    }

    public func schedules() -> AsyncThrowingStream<[PhoneSchedule], Error> {
        watch { [unowned self] in lock.withLock { scheduleList } }
    }

    public func wakes() -> AsyncThrowingStream<[PhoneSchedule], Error> {
        watch { [unowned self] in lock.withLock { scheduleList.filter(\.isActive) } }
    }

    public func counts() -> AsyncThrowingStream<PhoneCounts, Error> {
        watch { [unowned self] in
            let all = lock.withLock { Array(threadsById.values) }
            let now = Date.now
            return PhoneCounts(hibernating: all.filter { $0.archivedAt == nil && $0.coordinatorProjectId == nil && $0.starredAt == nil && InboxSections.isSnoozed($0, now: now) }.count,
                               den: all.filter { $0.archivedAt != nil }.count)
        }
    }

    public func thread(_ threadId: String) -> AsyncThrowingStream<ThreadDetail?, Error> {
        watch { [unowned self] in
            lock.withLock {
                threadsById[threadId].map { thread in
                    let all = messagesById[threadId] ?? []
                    // As phone:thread answers: only the newest text messages.
                    return ThreadDetail(thread: thread, messages: threadId == "long" ? Array(all.filter { $0.role != .tool }.suffix(20)) : all)
                }
            }
        }
    }

    public func olderMessages(_ threadId: String, beforeSeq: Int, limit: Int, notes: Bool) async throws -> MessagePage {
        // As over the network, for the long thread.
        if threadId == "long" { try await Task.sleep(for: .milliseconds(700)) }
        let before = lock.withLock { (messagesById[threadId] ?? []).filter { $0.seq < beforeSeq } }
        let page = Array(before.suffix(limit))
        let from = page.first?.seq ?? beforeSeq
        let images = lock.withLock { (imagesById[threadId] ?? []).filter { $0.seq >= from && $0.seq < beforeSeq } }
        return MessagePage(messages: page, hasMore: before.count > limit, images: images)
    }

    public func images(_ threadId: String, from: Int) -> AsyncThrowingStream<[MessageImage], Error> {
        watch { [unowned self] in lock.withLock { (imagesById[threadId] ?? []).filter { $0.seq >= from } } }
    }

    public func messages(_ threadId: String, limit: Int, notes: Bool) -> AsyncThrowingStream<MessagePage, Error> {
        let page = watch { [unowned self] in
            let all = lock.withLock { messagesById[threadId] ?? [] }
            let images = lock.withLock { imagesById[threadId] ?? [] }
            // At most what the server sends (phone:messages' PAGE_MAX).
            let limit = min(limit, MessageHistory.liveMax)
            return MessagePage(messages: Array(all.suffix(limit)), hasMore: all.count > limit, images: images)
        }
        guard threadId == "long" else { return page }
        // The long thread's page comes after phone:thread's answer, as it
        // does over the network, so the view goes through the same swap.
        return AsyncThrowingStream { continuation in
            let task = Task {
                try? await Task.sleep(for: .milliseconds(700))
                do {
                    for try await value in page { continuation.yield(value) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func command(_ commandId: String) -> AsyncThrowingStream<CommandStatus?, Error> {
        watch { [unowned self] in lock.withLock { commands[commandId] } }
    }

    public func waiting(_ threadId: String) -> AsyncThrowingStream<[WaitingSend], Error> {
        watch { [unowned self] in lock.withLock { waitingByThread[threadId] ?? [] } }
    }

    public func cancel(_ commandId: String) async throws -> Bool {
        var cancelled = false
        mutate { s in
            for (threadId, list) in s.waitingByThread where list.contains(where: { $0.commandId == commandId && $0.canCancel }) {
                s.waitingByThread[threadId] = list.filter { $0.commandId != commandId }
                s.commands[commandId] = CommandStatus(state: .failed, note: "Cancelled")
                cancelled = true
            }
        }
        return cancelled
    }

    public func connectionStates() -> AsyncStream<Bool> {
        AsyncStream { $0.yield(true) }
    }

    // MARK: Commands

    private func newCommand(threadId: String? = nil) -> String {
        let id = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[id] = CommandStatus(state: .done, threadId: threadId) }
        return id
    }

    private func append(_ threadId: String, role: PhoneMessage.Role, text: String, origin: String? = nil, answers: [AskAnswer] = []) {
        var list = messagesById[threadId] ?? []
        list.append(PhoneMessage(seq: (list.last?.seq ?? 0) + 1, role: role, text: text, origin: origin, answers: answers.isEmpty ? nil : answers, at: .now))
        messagesById[threadId] = list
    }

    private func runTurn(_ threadId: String, reply: String, after: Duration? = nil) {
        let delay = after ?? turnDelay
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.mutate { s in
                s.append(threadId, role: .assistant, text: reply)
                s.threadsById[threadId]?.status = .idle
                s.threadsById[threadId]?.working = nil
                s.threadsById[threadId]?.needsYou = true
                s.threadsById[threadId]?.unread = true
                s.threadsById[threadId]?.preview = reply
                s.threadsById[threadId]?.lastActivityAt = .now
            }
        }
    }

    public func uploadPhoto(_ jpeg: Data) async throws -> String { UUID().uuidString }
    public func discardPhoto(_ storageId: String) async throws {}

    /// What the runner's mirror shows for a message with pictures (sync.ts
    /// toMessageDoc): a line for the ones no [Picture N] marker places.
    private static func withPictures(_ text: String, _ images: [String]) -> String {
        let count = InlinePictures.unplaced(text, count: images.count)
        guard count > 0 else { return text }
        let note = count == 1 ? "[1 picture]" : "[\(count) pictures]"
        return text.isEmpty ? note : "\(text)\n\n\(note)"
    }

    public func send(threadId: String, text: String, answers: [AskAnswer], images: [String]) async throws -> String {
        // The runner's offline: it waits, as it would in Convex.
        let runnerId = lock.withLock { threadsById[threadId]?.runnerId }
        if let runnerId, WaitingSends.offlineRunner(runnerId, in: lock.withLock { runnerList }, at: .now) != nil {
            let id = "cmd_" + UUID().uuidString.prefix(8)
            mutate { s in
                s.commands[id] = CommandStatus(state: .pending)
                s.waitingByThread[threadId, default: []].append(WaitingSend(commandId: id, state: .pending, text: text, photos: images.count,
                                                                            createdAt: Date.now.timeIntervalSince1970 * 1000))
            }
            return id
        }
        let text = Self.withPictures(text, images)
        let id = answered { fake in
            fake.mutate { s in
                s.waitingByThread[threadId] = nil
                s.append(threadId, role: .user, text: text, origin: "phone", answers: answers)
                // The next turn closes the card, as on the runner.
                s.threadsById[threadId]?.asks = nil
                s.threadsById[threadId]?.asksSeq = nil
                s.threadsById[threadId]?.next = nil
                s.threadsById[threadId]?.status = .running
                s.threadsById[threadId]?.working = "Bear with me"
                s.threadsById[threadId]?.needsYou = false
                s.threadsById[threadId]?.unread = false
                s.threadsById[threadId]?.lastActivityAt = .now
            }
            fake.runTurn(threadId, reply: "Done. I've made that change and the checks pass.")
        }
        // Slow, it waits faded in the transcript as a real one does.
        if answerDelay > .zero, !answersFail {
            mutate { s in
                s.waitingByThread[threadId, default: []].append(WaitingSend(commandId: id, state: .pending, text: text, photos: images.count,
                                                                            createdAt: Date.now.timeIntervalSince1970 * 1000))
            }
        }
        return id
    }

    /// Marks the button pressed on its message, as the runner's row would
    /// come back, with the first other thread as the one it started.
    public func press(threadId: String, buttonId: String) async throws -> String {
        let started = lock.withLock { threadsById.keys.sorted().first { $0 != threadId } }
        return runnerDoes(threadId: started) { fake in
            fake.mutate { s in
                guard var list = s.messagesById[threadId] else { return }
                for i in list.indices {
                    guard let b = list[i].buttons?.firstIndex(where: { $0.id == buttonId }) else { continue }
                    list[i].buttons![b].pressedThreadId = started
                    list[i].buttons![b].failed = nil
                }
                s.messagesById[threadId] = list
            }
        }
    }

    /// Stops the turn as a runner would: the thread goes idle, its working line gone.
    public func interrupt(threadId: String) async throws -> String {
        runnerDoes { fake in
            fake.mutate { s in
                s.threadsById[threadId]?.status = .idle
                s.threadsById[threadId]?.working = nil
            }
        }
    }

    // Synthetic review data for the simulator, never a real conversation:
    // an option with the agent's marks, a video, a sound and a reference page.
    private static var sampleDesignReview: PhoneDesignReview {
        PhoneDesignReview(id: "sample-review", title: "Choose a layout", note: "Three ways to lay out the list. **A** gives each row more room; **B** animates cards in; **C** adds a chime when it's done. **D** is how it looks today.", recommended: "A", status: "pending", revision: 0, draft: DesignReviewDraft(), options: [
            .init(id: "A", title: "Roomier layout", note: "More air between rows. **Easiest to scan** at a glance.", reference: false, shots: [
                .init(src: "review:sample:a", title: "Overview", kind: "image", marks: [
                    .init(kind: "circle", box: [0.08, 0.12, 0.42, 0.42], note: "bigger tap target", ink: "yellow"),
                    .init(kind: "underline", box: [0.5, 0.62, 0.9, 0.7], note: nil, ink: "green"),
                    .init(kind: "highlight", box: [0.56, 0.42, 0.9, 0.5], note: nil, ink: "yellow"),
                    .init(kind: "arrow", box: [0.3, 0.88, 0.55, 0.72], note: "same gap here", ink: "rose"),
                ]),
                .init(src: "review:sample:a2", title: "Detail", kind: "image"),
            ]),
            .init(id: "B", title: "Card grid", note: "Cards slide in as they load.", reference: false, shots: [
                .init(src: "review:sample:c", title: "Loading", kind: "video", media: "review:sample:c-media"),
            ]),
            .init(id: "C", title: "Soft chime", note: "A short sound when it's done.", reference: false, shots: [
                .init(src: "review:sample:d", title: "Done sound", kind: "audio", media: "review:sample:d-media"),
            ]),
            .init(id: "D", title: "Current layout", reference: true, shots: [.init(src: "review:sample:b", title: "Today", kind: "page")]),
        ], canMark: true)
    }

    public func designReviews(threadId: String, reviewId: String?) async throws -> String {
        let id = UUID().uuidString
        var status = CommandStatus(state: .done)
        status.designReviews = reviewId == nil
            ? DesignReviewResult(reviews: [.init(id: "sample-review", title: "Choose a layout")])
            : DesignReviewResult(review: Self.sampleDesignReview)
        lock.withLock { commands[id] = status }
        return id
    }

    public func respondReview(threadId: String, review: PhoneDesignReview, draft: DesignReviewDraft) async throws -> String {
        let id = UUID().uuidString
        lock.withLock { commands[id] = CommandStatus(state: answersFail ? .failed : .done, note: answersFail ? "The review changed on the Mac." : nil) }
        return id
    }

    public func reviewImages(threadId: String, sources: [String]) -> AsyncThrowingStream<[MessageImage], Error> {
        // `-ThreadbearReviewVideo <path>`: an MP4 for the video option to
        // play (made on the Mac with ffmpeg's software encoder). Without it
        // the video shot shows its still and says it couldn't load.
        let args = ProcessInfo.processInfo.arguments
        let video = args.firstIndex(of: "-ThreadbearReviewVideo").flatMap { args.indices.contains($0 + 1) ? URL(fileURLWithPath: args[$0 + 1]).absoluteString : nil }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("sample-review-none.mp4").absoluteString
        let pictures = [
            MessageImage(seq: 1, src: "review:sample:a", url: Self.samplePicture("review-a", width: 1200, height: 800, hue: 0.33), width: 1200, height: 800),
            MessageImage(seq: 1, src: "review:sample:a2", url: Self.samplePicture("review-a2", width: 1200, height: 900, hue: 0.4), width: 1200, height: 900),
            MessageImage(seq: 1, src: "review:sample:b", url: Self.samplePicture("review-b", width: 1000, height: 1400, hue: 0.58), width: 1000, height: 1400),
            MessageImage(seq: 1, src: "review:sample:c", url: Self.samplePicture("review-c", width: 1280, height: 720, hue: 0.1), width: 1280, height: 720),
            MessageImage(seq: 1, src: "review:sample:c-media", url: video, mediaType: "video/mp4"),
            MessageImage(seq: 1, src: "review:sample:d", url: Self.sampleWaveform("review-d", width: 1200, height: 400), width: 1200, height: 400),
            MessageImage(seq: 1, src: "review:sample:d-media", url: Self.sampleChime("review-d"), mediaType: "audio/wav"),
        ]
        return AsyncThrowingStream { $0.yield(pictures); $0.finish() }
    }

    /// A Claude thread's list, as a runner would send it, for the palette
    /// in the simulator and the screenshots.
    public func slashCommands(threadId: String) async throws -> String {
        let id = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[id] = CommandStatus(state: .done, commands: Self.sampleCommands) }
        return id
    }

    public static let sampleCommands: [SlashCommand] = [
        SlashCommand(name: "model", description: "Switch this thread's model", argumentHint: "[model]", source: "threadbear"),
        SlashCommand(name: "effort", description: "Set this thread's effort level", argumentHint: "[low|medium|high|xhigh|max]", source: "threadbear"),
        SlashCommand(name: "clear", description: "Clear conversation history and free up context", source: "cli", scope: "system"),
        SlashCommand(name: "compact", description: "Clear conversation history but keep a summary in context", argumentHint: "<optional custom summarization instructions>", source: "cli", scope: "system"),
        SlashCommand(name: "context", description: "Show current context usage", source: "cli", scope: "system"),
        SlashCommand(name: "cost", description: "Show the total cost and duration of the current session", source: "cli", aliases: ["usage", "stats"], scope: "system"),
        SlashCommand(name: "code-review", description: "Review the current diff, or a PR number, branch or path, for correctness bugs, at the effort level given first.", argumentHint: "[low|medium|high] [target]", source: "skill", scope: "user"),
        SlashCommand(name: "computercub", description: "Drive Mac apps and the parts of Chrome extensions can't reach, with the `computercub` command.", source: "skill", scope: "user"),
        SlashCommand(name: "deslop", description: "A second-pass cleanup over AI-written code using the repo's style guide.", source: "skill", scope: "user"),
        SlashCommand(name: "ship", description: "Drive a branch to merge-ready: PR, checks, bot comments.", source: "skill", scope: "user"),
    ]

    /// Runs `land` when the runner would take the answer: now, or after
    /// `answerDelay`, or never if it's refusing them.
    private func answered(_ land: @escaping @Sendable (FakeBackend) -> Void) -> String {
        guard answerDelay > .zero else {
            land(self)
            return newCommand()
        }
        let id = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[id] = CommandStatus(state: .pending) }
        let (delay, fails) = (answerDelay, answersFail)
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self else { return }
            if !fails { land(self) }
            self.mutate { s in s.commands[id] = fails ? CommandStatus(state: .failed, note: "the runner refused it") : CommandStatus(state: .done) }
        }
        return id
    }

    public func respond(threadId: String, approvalId: String, decision: ApprovalOption) async throws -> String {
        answered { fake in
            fake.mutate { s in
                s.threadsById[threadId]?.pendingApproval = nil
                s.threadsById[threadId]?.status = decision == .deny ? .idle : .running
                s.threadsById[threadId]?.working = decision == .deny ? nil : "Running the command"
            }
            if decision != .deny { fake.runTurn(threadId, reply: "That ran fine. Everything's green.") }
        }
    }

    public func answer(threadId: String, approvalId: String, answers: [String: String], summary: String) async throws -> String {
        answered { fake in
            fake.mutate { s in
                s.append(threadId, role: .user, text: summary, origin: "phone")
                s.threadsById[threadId]?.pendingApproval = nil
                s.threadsById[threadId]?.status = .running
                s.threadsById[threadId]?.working = "Bear with me"
            }
            fake.runTurn(threadId, reply: "Thanks, going with that.")
        }
    }

    public func secret(threadId: String, approvalId: String, answer: SecretAnswer) async throws -> String {
        let declined = answer == .decline
        mutate { s in
            s.threadsById[threadId]?.pendingApproval = nil
            s.threadsById[threadId]?.status = declined ? .idle : .running
            s.threadsById[threadId]?.working = declined ? nil : "Signing in"
            s.threadsById[threadId]?.needsYou = false
        }
        if !declined { runTurn(threadId, reply: "Thanks, that worked. I'm signed in now.") }
        return newCommand()
    }

    /// A command's row as the backend would have it, nil for gone, for tests.
    public func setCommand(_ id: String, _ status: CommandStatus?) {
        mutate { s in s.commands[id] = status }
    }

    /// Runs `land` as the runner would: now, or after `changeDelay`, or
    /// refuses it, or never takes it (`holdsCommands`).
    private func runnerDoes(threadId: String? = nil, _ land: @escaping @Sendable (FakeBackend) -> Void) -> String {
        guard holdsCommands || changesFail || changeDelay > .zero else {
            land(self)
            return newCommand(threadId: threadId)
        }
        let id = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[id] = CommandStatus(state: .pending) }
        guard !holdsCommands else { return id }
        let (delay, fails) = (changeDelay, changesFail)
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self else { return }
            if !fails { land(self) }
            self.mutate { s in
                s.commands[id] = fails ? CommandStatus(state: .failed, note: "The Mac couldn't do that just now.") : CommandStatus(state: .done, threadId: threadId)
            }
        }
        return id
    }

    public func update(threadId: String, change: ThreadChange) async throws -> String {
        lock.withLock { updates += 1 }
        return runnerDoes { fake in fake.apply(threadId, change) }
    }

    /// As the runner shares: a slug the first time, kept when it stops, and
    /// a fresh one for a new link.
    public func share(threadId: String, request: ShareRequest) async throws -> String {
        lock.withLock { updates += 1 }
        return runnerDoes { fake in
            fake.mutate { s in
                guard var thread = s.threadsById[threadId] else { return }
                let slug = request == .newLink ? nil : thread.share?.slug
                thread.share = ThreadShare(access: request.access, slug: slug ?? Self.newSlug())
                s.threadsById[threadId] = thread
            }
        }
    }

    private static func newSlug() -> String {
        Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func apply(_ threadId: String, _ change: ThreadChange) {
        mutate { s in
            switch change {
            case let .snooze(until): s.threadsById[threadId]?.snoozedUntil = until
            case .snoozeUntilRestart: s.threadsById[threadId]?.snoozedUntilRestart = true
            case .wake:
                s.threadsById[threadId]?.snoozedUntil = nil
                s.threadsById[threadId]?.snoozedUntilRestart = nil
            case .archive, .archiveWithVerdict: s.threadsById[threadId]?.archivedAt = .now
            case .unarchive: s.threadsById[threadId]?.archivedAt = nil
            case .markSeen:
                s.threadsById[threadId]?.unread = false
                s.threadsById[threadId]?.needsYou = false
            case let .rename(title): s.threadsById[threadId]?.title = title
            case let .star(on):
                let starredAt = s.threadsById[threadId]?.starredAt
                s.threadsById[threadId]?.starredAt = on ? (starredAt ?? .now) : nil
            case let .settings(change):
                guard let thread = s.threadsById[threadId] else { return }
                let runner = s.runnerList.first { $0.runnerId == thread.runnerId }
                let ctx = ModelPickerContext.forThread(thread, runner: runner, accounts: Self.sampleAccounts)
                s.threadsById[threadId] = ctx.applyingOptimistic(change, to: thread)
            }
        }
    }

    public func accounts() -> AsyncThrowingStream<[PhoneAccount], Error> {
        watch { Self.sampleAccounts }
    }

    static let samplePools: [PhoneUsagePool] = [
        PhoneUsagePool(id: "main", title: "Main", accountIds: ["claude-main", "claude-backup", "codex-main", "gemini-main", "opencode-main"]),
        PhoneUsagePool(id: "work", title: "Work", accountIds: ["claude-work", "codex-work"]),
    ]

    static let sampleDefaults = PhoneRunnerDefaults(
        poolId: "main",
        accountId: "claude-main",
        models: ["claude": "opus", "codex": "gpt-6-astra", "gemini": "gemini-3-pro", "opencode": "opencode-sonnet"],
        efforts: ["claude": "high", "codex": "high"]
    )

    /// Rich sample logins with usage, descriptions, older Claude IDs and an unpooled login.
    static let sampleAccounts: [PhoneAccount] = {
        let claudeModels = [
            PhoneModelChoice(id: "opus", model: "claude-opus-5-5", title: "Opus 5.5", description: "Most capable for complex work", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high"),
            PhoneModelChoice(id: "sonnet", model: "claude-sonnet-5-5", title: "Sonnet 5.5", description: "Fast and strong for everyday tasks", effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium"),
            PhoneModelChoice(id: "haiku", model: "claude-haiku-5-5", title: "Haiku 5.5", description: "Fastest for quick questions"),
            PhoneModelChoice(id: "claude-opus-4-1-20250805", model: "claude-opus-4-1-20250805", title: "Opus 4.1", description: "Previous flagship release", effortLevels: ["low", "medium", "high", "max"]),
            PhoneModelChoice(id: "claude-sonnet-4-20250514", model: "claude-sonnet-4-20250514", title: "Sonnet 4", description: "Earlier everyday model", effortLevels: ["low", "medium", "high"]),
        ]
        let codexModels = [
            PhoneModelChoice(id: "gpt-6-astra", model: "gpt-6-astra", title: "GPT-6 Astra", description: "Deep reasoning and code changes", effortLevels: ["low", "medium", "high", "xhigh", "ultra"], defaultEffort: "high"),
            PhoneModelChoice(id: "gpt-6-mini", model: "gpt-6-mini", title: "GPT-6 Mini", description: "Fast edits and small lookups", effortLevels: ["low", "medium", "high"]),
        ]
        let geminiModels = [
            PhoneModelChoice(id: "gemini-3-pro", model: "gemini-3-pro", title: "Gemini 3 Pro", description: "Large context and multimodal reasoning"),
            PhoneModelChoice(id: "gemini-3-flash", model: "gemini-3-flash", title: "Gemini 3 Flash", description: "Quick answers and drafts"),
        ]
        let opencodeModels = [
            PhoneModelChoice(id: "opencode-sonnet", model: "opencode-sonnet", title: "OpenCode Sonnet", description: "Balanced coding model"),
        ]
        let soon = Date.now.addingTimeInterval(3 * 3600)
        let later = Date.now.addingTimeInterval(48 * 3600)
        return [
            PhoneAccount(
                id: "claude-main", provider: "claude", title: "alex@acme.example", email: "alex@acme.example",
                defaultModel: "opus", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 100, resetsAt: soon),
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 94, resetsAt: later),
                ]),
                models: claudeModels
            ),
            PhoneAccount(
                id: "claude-backup", provider: "claude", title: "alex@studio.example", email: "alex@studio.example",
                defaultModel: "opus", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 86, resetsAt: soon),
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 72, resetsAt: later),
                ]),
                models: claudeModels
            ),
            PhoneAccount(
                id: "codex-main", provider: "codex", title: "Codex · alex@acme.example", email: "alex@acme.example",
                defaultModel: "gpt-6-astra", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 92, resetsAt: soon),
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 84, resetsAt: later),
                ]),
                models: codexModels
            ),
            PhoneAccount(
                id: "gemini-main", provider: "gemini", title: "alex@acme.example", email: "alex@acme.example",
                defaultModel: "gemini-3-pro",
                models: geminiModels
            ),
            PhoneAccount(
                id: "opencode-main", provider: "opencode", title: "alex@acme.example", email: "alex@acme.example",
                defaultModel: "opencode-sonnet",
                models: opencodeModels
            ),
            PhoneAccount(
                id: "claude-work", provider: "claude", title: "alex@northwind.example", email: "alex@northwind.example",
                defaultModel: "opus", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 18, resetsAt: soon),
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 41, resetsAt: later),
                ]),
                models: claudeModels
            ),
            PhoneAccount(
                id: "codex-work", provider: "codex", title: "Codex · alex@northwind.example", email: "alex@northwind.example",
                defaultModel: "gpt-6-astra", defaultEffort: "high",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 12, resetsAt: soon),
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 35, resetsAt: later),
                ]),
                models: codexModels
            ),
            PhoneAccount(
                id: "claude-solo", provider: "claude", title: "alex@solo.example", email: "alex@solo.example",
                defaultModel: "sonnet", defaultEffort: "medium",
                usage: PhoneAccountUsage(windows: [
                    PhoneUsageWindow(kind: "five_hour", title: "5-hour", remainingPercent: 64, resetsAt: soon),
                    PhoneUsageWindow(kind: "weekly", title: "Weekly", remainingPercent: 58, resetsAt: later),
                ]),
                models: claudeModels
            ),
        ]
    }()

    public func create(text: String, runnerId: String?, cwd: String?, images: [String], settings: NewThreadSettings) async throws -> String {
        let id = UUID().uuidString.lowercased()
        let title = text.isEmpty ? "Untitled" : String(text.prefix(48))
        let text = Self.withPictures(text, images)
        // Pending for a moment, as a real runner takes a second or more to
        // make it, so the demo shows the inbox's Starting row.
        let commandId = "cmd_" + UUID().uuidString.prefix(8)
        lock.withLock { commands[commandId] = CommandStatus(state: .pending) }
        Task {
            try? await Task.sleep(for: startDelay)
            mutate { s in
                let runner = s.runnerList.first { $0.runnerId == (runnerId ?? "mac") }
                let ctx = ModelPickerContext.forNewThread(settings: settings, runner: runner, accounts: Self.sampleAccounts)
                s.threadsById[id] = PhoneThread(
                    threadId: id,
                    runnerId: runnerId ?? "mac",
                    title: title,
                    cwd: cwd ?? "~/code/misc",
                    accountId: ctx.accountId.isEmpty ? "claude-main" : ctx.accountId,
                    provider: ctx.provider,
                    poolId: ctx.poolId,
                    model: settings.model,
                    effort: settings.effort,
                    status: .running,
                    lastActivityAt: .now,
                    working: "Bear with me"
                )
                s.append(id, role: .user, text: text, origin: "phone")
                s.commands[commandId] = CommandStatus(state: .done, threadId: id)
            }
            runTurn(id, reply: newThreadReply, after: newThreadTurn)
        }
        return String(commandId)
    }

    public func quickAsk(_ ask: QuickAskRecord) async throws -> String {
        let id = UUID().uuidString.lowercased()
        mutate { s in
            s.threadsById[id] = PhoneThread(threadId: id, title: String(ask.question.prefix(48)), cwd: "~/code/misc", status: .idle,
                                            lastActivityAt: .now)
            s.append(id, role: .user, text: ask.question, origin: "phone")
            s.append(id, role: .assistant, text: ask.answer)
        }
        return newCommand(threadId: id)
    }

    public func setNotifications(apnsToken: String, notify: NotifyMode) async throws {}
    public func setViewing(apnsToken: String, threadId: String, open: Bool) async throws {}

    public func setRunnerOrder(_ runnerIds: [String]) async throws {
        mutate { s in
            let rank = { (r: PhoneRunner) in runnerIds.firstIndex(of: r.runnerId) ?? runnerIds.count }
            s.runnerList = s.runnerList.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
            for i in s.runnerList.indices { s.runnerList[i].placed = runnerIds.contains(s.runnerList[i].runnerId) ? true : nil }
        }
    }

    public func loadEarlier(threadId: String, beforeSeq: Int) async throws -> String {
        let delay = turnDelay
        Task { [weak self] in
            try? await Task.sleep(for: delay / 4)
            self?.mutate { s in
                let earliest = Int(s.threadsById[threadId]?.earliestSeq ?? 1)
                let seqs = Array(max(earliest, beforeSeq - 50)..<beforeSeq)
                let older = seqs.map { seq in
                    PhoneMessage(seq: seq, role: seq % 2 == 0 ? .assistant : .user,
                                 text: seq % 2 == 0 ? "An earlier reply, number \(seq)." : "An earlier ask, number \(seq).",
                                 at: Date.now.addingTimeInterval(Double(seq - beforeSeq) * 300))
                }
                s.messagesById[threadId] = older + (s.messagesById[threadId] ?? [])
            }
        }
        return newCommand()
    }

    public func registerDevice(apnsToken: String, environment: String, pushKey: String?) async throws {}

    // MARK: Sample data

    /// Made-up threads for the demo (App Review taps "Look around with
    /// sample threads"), the simulator and the screenshots. Nothing in here
    /// is from a real thread, and no real project or app is named:
    /// FakeBackendTests checks for the names that used to be here.
    /// The projects the sample threads are in, with symbols for icons (a
    /// picture would need a URL to fetch; the demo has no backend).
    public static let samplePocket = [
        PocketCard(id: "seeds to pick up", title: "Seeds to pick up", text: "Sweet peas\nRunner beans\nThe small terracotta pots", place: "garden centre", icon: "shopping", source: "Garden planner", updatedAt: "2026-10-20T09:00:00Z"),
        PocketCard(id: "train home", title: "Train home", text: "Booking ABC123\nCoach C, seat 42", icon: "ticket", source: "Trip", updatedAt: "2026-10-21T09:00:00Z"),
        PocketCard(id: "post the parcel", title: "Post the parcel", text: "Sam Taylor\n12 Harbour Street\nBristol BS1 4QA\nUK", icon: "parcel", threadId: "demo_upload", source: "Website", updatedAt: "2026-10-22T09:00:00Z"),
    ]

    public static let sampleProjects = [
        PhoneProject(id: "p_garden", title: "Garden planner", icon: PhoneProjectIcon(symbol: "leaf", by: "librarian")),
        PhoneProject(id: "p_site", title: "Website", icon: PhoneProjectIcon(symbol: "globe", by: "librarian")),
    ]

    static func sample(now: Date) -> (threads: [PhoneThread], messages: [String: [PhoneMessage]], schedules: [PhoneSchedule]) {
        func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
        let garden = [ProjectRef(id: "p_garden", title: "Garden planner")]
        let site = [ProjectRef(id: "p_site", title: "Website")]
        let threads = [
            PhoneThread(threadId: "a1", title: "Release 1.2 of the garden app", cwd: "~/code/garden-planner",
                        poolId: "main", modelInUse: "opus", effortInUse: "high", status: .waiting,
                        needsYou: true, preview: "Everything passes. Ready to tag 1.2.0 and push it.",
                        lastActivityAt: ago(4), projects: garden,
                        pendingApproval: .approval(id: "ap1", name: "Bash", title: "Run a command",
                                                   options: [.allow, .allowAlways, .deny],
                                                   inputSummary: "git tag v1.2.0 && git push origin v1.2.0",
                                                   reason: "Auto mode's safety check couldn't clear this: it pushes a release tag to the shared remote."),
                        links: [PhoneLink(title: "Website", url: "https://example.com/", icon: "safari"),
                                PhoneLink(title: "App Store Connect", url: "https://appstoreconnect.apple.com/apps", icon: "app.badge")]),
            PhoneThread(threadId: "a2", title: "Where should the settings live?", cwd: "~/code/garden-planner",
                        poolId: "main", modelInUse: "opus", effortInUse: "high",
                        status: .waiting, needsYou: true, preview: "Two ways to do this.", lastActivityAt: ago(12),
                        projects: garden,
                        pendingApproval: .question(id: "q1", questions: [
                            Question(question: "Where should each person's settings live?", header: "Settings", options: [
                                .init(label: "In the database", description: "Follows them to a new phone"),
                                .init(label: "On the phone", description: "Simplest, nothing to sync"),
                            ]),
                        ])),
            PhoneThread(threadId: "a3", title: "Date picker on small screens", cwd: "~/code/website",
                        poolId: "main", modelInUse: "opus", effortInUse: "high",
                        needsYou: true, unread: true,
                        preview: "Fixed in 4700e57. The picker fits on the smallest iPhone now.",
                        lastActivityAt: ago(25), costUsd: 1.84, projects: site, earliestSeq: 1,
                        asks: [PhoneAsk(action: "Ship the fix to the website now?",
                                        why: "It's on a preview while you look. I'll merge and deploy once you say so.",
                                        options: ["Ship it", "Not yet"],
                                        optionNotes: ["I merge, deploy and check the live site", "It stays on the preview for now"],
                                        suggested: 0,
                                        links: [PhoneAskLink(title: "See the preview", url: "https://example.com")])],
                        asksSeq: 126),
            PhoneThread(threadId: "a4", title: "Tidy up old feature flags", cwd: "~/code/api",
                        poolId: "main", modelInUse: "sonnet", effortInUse: "medium",
                        preview: "Removed six flags nothing reads any more.", lastActivityAt: ago(190),
                        next: ["Remove the flag helpers too"],
                        looseEnds: [PhoneLooseEnd(kind: "uncommitted", text: "2 files it changed in api aren't committed"),
                                    PhoneLooseEnd(kind: "thread", text: "\"Search box for the docs\", a thread it started, is still working", threadId: "a5")]),
            PhoneThread(threadId: "a5", title: "Search box for the docs", cwd: "~/code/website",
                        poolId: "main", modelInUse: "opus", effortInUse: "high", status: .running,
                        preview: "Adding the index.", lastActivityAt: ago(1), projects: site,
                        working: "Running npm test"),
            PhoneThread(threadId: "a6", title: "Upgrade the router", cwd: "~/code/website",
                        accountId: "claude-work", poolId: "work", modelInUse: "opus", effortInUse: "high",
                        preview: "Picked the next three pages to move.", lastActivityAt: ago(60 * 20),
                        snoozedUntil: now.addingTimeInterval(3600 * 14)),
            PhoneThread(threadId: "a7", title: "Rename the settings screen", cwd: "~/code/garden-planner",
                        poolId: "main", modelInUse: "opus", effortInUse: "high",
                        preview: "Done.", lastActivityAt: ago(60 * 30), archivedAt: ago(60 * 26)),
            // Booked itself a look tomorrow morning: it waits under Waiting.
            PhoneThread(threadId: "a8", title: "Watch the nightly build", cwd: "~/code/api",
                        poolId: "main", modelInUse: "opus", effortInUse: "high",
                        preview: "All green tonight. I'll look again in the morning.", lastActivityAt: ago(45),
                        needs: "nothing"),
        ]
        let schedules = [
            PhoneSchedule(id: "s1", title: "Check the nightly build", whenText: "Every day at 8:00", threadId: "a8",
                          nextRunAt: now.addingTimeInterval(3600 * 9)),
        ]
        let messages: [String: [PhoneMessage]] = [
            "a1": [
                PhoneMessage(seq: 1, role: .user, text: "Get 1.2 ready to release", at: ago(30)),
                PhoneMessage(seq: 2, role: .tool, text: "Read CHANGELOG.md", toolKind: "read", at: ago(29)),
                PhoneMessage(seq: 3, role: .tool, text: "Bump the version to 1.2.0", toolKind: "command", at: ago(28)),
                PhoneMessage(seq: 4, role: .tool, text: "Edited CHANGELOG.md", toolKind: "edit", at: ago(27)),
                PhoneMessage(seq: 5, role: .tool, text: "Run the unit tests", toolKind: "command", at: ago(12)),
                PhoneMessage(seq: 6, role: .assistant, text: "Bumped the version to **1.2.0** and wrote up the changelog. All 214 tests pass.\n\nReady to tag 1.2.0 and push it.", at: ago(4)),
            ],
            "a2": [
                PhoneMessage(seq: 1, role: .user, text: "Let people pick metric or imperial in settings", at: ago(15)),
            ],
            "a3": [
                PhoneMessage(seq: 120, role: .user, text: "The date picker gets cut off on small phones, like this [Picture 1]. Can you fix it?", at: ago(50)),
                PhoneMessage(seq: 121, role: .tool, text: "Read src/DatePicker.tsx", toolKind: "read", at: ago(48)),
                PhoneMessage(seq: 122, role: .tool, text: "Edited src/DatePicker.tsx", toolKind: "edit", at: ago(40)),
                PhoneMessage(seq: 123, role: .assistant, text: "That fits now. Checking the other sizes.", at: ago(38)),
                PhoneMessage(seq: 124, role: .tool, text: "Screenshot at three phone sizes", toolKind: "command", at: ago(30)),
                PhoneMessage(seq: 125, role: .tool, text: "threadbear: end_turn", toolKind: "mcp", at: ago(25)),
                PhoneMessage(seq: 126, role: .assistant, text: "- Fixed in `4700e57`: the [picker fits](work:Edited src/DatePicker.tsx) on the smallest iPhone now\n- [Checked it in the simulator](work:Screenshot at three phone sizes) at three sizes\n- The [nightly build](thread:a8) is still green", summary: true, at: ago(25)),
            ],
            "a4": [
                PhoneMessage(seq: 1, role: .user, text: "Get rid of the feature flags nothing uses", turn: "f1", at: ago(200)),
                PhoneMessage(seq: 2, role: .tool, text: "Searched for isEnabled(", toolKind: "search", turn: "f1", at: ago(199)),
                PhoneMessage(seq: 3, role: .tool, text: "Edited src/flags.ts", toolKind: "edit", turn: "f1", at: ago(198)),
                PhoneMessage(seq: 4, role: .assistant, text: "Removed six flags. The full test run takes a while, so I've left it going and will look when it's done.", turn: "f1", at: ago(197)),
                // A wake-up as the test run finished: the divider marks the wait.
                PhoneMessage(seq: 5, role: .tool, text: "Read the test output", toolKind: "read", turn: "f2", wokeBy: [WokeTask(kind: "shell", description: "Run the full test suite")], at: ago(190)),
                // A reply button, to see one pressed (-ThreadbearDo "press a4 prbtn001").
                PhoneMessage(seq: 6, role: .assistant, text: "All 214 tests pass with the flags gone. [Open a pull request](button:prbtn001)", turn: "f2",
                             buttons: [MessageButton(id: "prbtn001", title: "Open a pull request", kind: .start, target: "api")], at: ago(190)),
            ],
            "a5": [
                PhoneMessage(seq: 1, role: .user, text: "Okay, let's go with it.", at: ago(8)),
            ],
            "a6": [
                PhoneMessage(seq: 1, role: .user, text: "Review: Router upgrade order (0f3c2a9e-5b1d-4e7a-9c64-2d8b1f0a7e35)\n\nPicked B. B: docs pages first.\n\nNotes on B (B: docs pages first): Leave the search page till last.", at: ago(60 * 21)),
                PhoneMessage(seq: 2, role: .assistant, text: "Going with the docs pages first, search last. Picked the next three pages to move.", at: ago(60 * 20)),
            ],
            "a8": [
                PhoneMessage(seq: 1, role: .user, text: "Keep an eye on the nightly build this week", at: ago(50)),
                PhoneMessage(seq: 2, role: .tool, text: "Read the build log", toolKind: "read", at: ago(48)),
                PhoneMessage(seq: 3, role: .assistant, text: "All green tonight. I'll look again in the morning.", at: ago(45)),
                // Another thread's agent writing in: drawn as a card, not Mike's bubble.
                PhoneMessage(seq: 4, role: .user, text: "[Sent by the agent in the thread \"Upgrade the router\" (a6)]\nThe router upgrade lands tonight and changes the build config. Watch for a slower build.", at: ago(44)),
                PhoneMessage(seq: 5, role: .assistant, text: "Noted. I'll compare tonight's build time with last week's.", at: ago(43)),
            ],
        ]
        return (threads, messages, schedules)
    }
}
