import AVFoundation
import CryptoKit
import SwiftUI
import ThreadbearKit
import UIKit

/// A shot on the board: which option (by index) and which of its shots.
struct ShotKey: Hashable {
    var option: Int
    var shot: Int
}

/// The board's colours: the agent's three inks and the phone's own blue.
enum BoardInk {
    static let yellow = Color(red: 1, green: 0xd1 / 255, blue: 0x66 / 255)
    static let green = Color(red: 0x4a / 255, green: 0xde / 255, blue: 0x80 / 255)
    static let rose = Color(red: 0xfb / 255, green: 0x71 / 255, blue: 0x85 / 255)
    static let blue = Color(red: 0x60 / 255, green: 0xa5 / 255, blue: 0xfa / 255)
    static let board = Color(red: 0.055, green: 0.06, blue: 0.075)

    static func of(_ ink: String?) -> Color {
        switch ink {
        case "green": green
        case "rose": rose
        default: yellow
        }
    }

    /// Handwriting for the agent's notes, with a system fallback.
    static func hand(_ size: CGFloat) -> Font {
        for name in ["Noteworthy-Bold", "BradleyHandITCTT-Bold"] where UIFont(name: name, size: size) != nil {
            return .custom(name, size: size)
        }
        return .system(size: size, weight: .semibold, design: .rounded).italic()
    }
}

// MARK: - The agent's marks

/// A box of fractions as a rect in a picture `size` points across. For an
/// arrow the order matters (tail, then head), so this is only for the others.
nonisolated private func rect(_ box: [Double], in size: CGSize) -> CGRect {
    guard box.count == 4 else { return .zero }
    let x0 = min(box[0], box[2]), x1 = max(box[0], box[2]), y0 = min(box[1], box[3]), y1 = max(box[1], box[3])
    return CGRect(x: x0 * size.width, y: y0 * size.height, width: (x1 - x0) * size.width, height: (y1 - y0) * size.height)
}

/// The same small wobble every time a mark is drawn, from its box.
nonisolated private func seed(_ box: [Double]) -> Double {
    box.enumerated().reduce(0.0) { $0 + $1.element * Double($1.offset + 3) * 7.3 }
}

/// A circle drawn by hand: a little out of round, overshooting where it started.
nonisolated struct WobblyEllipse: Shape {
    var seed: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let steps = 72
        let start = -2.2 + seed.truncatingRemainder(dividingBy: 1)
        let sweep = 2 * Double.pi + 0.45
        for i in 0...steps {
            let a = start + sweep * Double(i) / Double(steps)
            let wobble = 1 + 0.04 * sin(3 * a + seed) + 0.025 * sin(5 * a + seed * 2)
            // Spirals in a touch, as a quick hand does.
            let inward = 1 - 0.05 * Double(i) / Double(steps)
            let p = CGPoint(x: rect.midX + rect.width / 2 * wobble * inward * cos(a),
                            y: rect.midY + rect.height / 2 * wobble * inward * sin(a))
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        return path
    }
}

/// An arrow along a gentle curve, from the box's first corner to its second.
nonisolated private struct CurvedArrow: Shape {
    var from: CGPoint
    var to: CGPoint

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let dx = to.x - from.x, dy = to.y - from.y
        let length = max(1, hypot(dx, dy))
        let control = CGPoint(x: (from.x + to.x) / 2 - dy * 0.25, y: (from.y + to.y) / 2 + dx * 0.25)
        path.move(to: from)
        path.addQuadCurve(to: to, control: control)
        let angle = atan2(to.y - control.y, to.x - control.x)
        let head = min(16, length * 0.35)
        for side in [-0.5, 0.5] {
            path.move(to: to)
            path.addLine(to: CGPoint(x: to.x - head * cos(angle + side), y: to.y - head * sin(angle + side)))
        }
        return path
    }
}

/// The agent's marks over a shot's picture, `size` the picture's on the
/// board, so they scale with the board's zoom like the picture does.
struct AgentMarksOverlay: View {
    var marks: [PhoneDesignReview.AgentMark]
    var size: CGSize

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.clear.frame(width: size.width, height: size.height)
            ForEach(Array(marks.enumerated()), id: \.offset) { _, mark in
                shape(mark)
                if let note = mark.note, !note.isEmpty { noteText(note, mark) }
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    @ViewBuilder private func shape(_ mark: PhoneDesignReview.AgentMark) -> some View {
        let ink = BoardInk.of(mark.ink)
        let r = rect(mark.box, in: size)
        let stroke = StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)
        switch mark.kind {
        case "circle":
            WobblyEllipse(seed: seed(mark.box))
                .stroke(ink, style: stroke)
                .frame(width: r.width + 10, height: r.height + 10)
                .offset(x: r.minX - 5, y: r.minY - 5)
                .shadow(color: .black.opacity(0.5), radius: 2)
        case "underline":
            Path { p in
                p.move(to: CGPoint(x: r.minX, y: r.maxY))
                p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.maxY + 2), control: CGPoint(x: r.midX, y: r.maxY + 6))
            }
            .stroke(ink, style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
            .shadow(color: .black.opacity(0.5), radius: 2)
        case "highlight":
            RoundedRectangle(cornerRadius: 3)
                .fill(ink.opacity(0.32))
                .frame(width: r.width + 6, height: r.height + 2)
                .rotationEffect(.degrees(-1))
                .offset(x: r.minX - 3, y: r.minY - 1)
        case "arrow":
            CurvedArrow(from: CGPoint(x: mark.box[0] * size.width, y: mark.box[1] * size.height),
                        to: CGPoint(x: mark.box[2] * size.width, y: mark.box[3] * size.height))
                .stroke(ink, style: stroke)
                .shadow(color: .black.opacity(0.5), radius: 2)
        default:
            EmptyView()
        }
    }

    /// Beside the mark: to its right when there's room, else to its left. An
    /// arrow's note sits by its tail.
    private func noteText(_ note: String, _ mark: PhoneDesignReview.AgentMark) -> some View {
        let r = rect(mark.box, in: size)
        let anchor = mark.kind == "arrow"
            ? CGPoint(x: mark.box[0] * size.width, y: mark.box[1] * size.height)
            : CGPoint(x: r.midX, y: r.midY)
        let tail = mark.kind == "arrow"
        let right = tail ? anchor.x < size.width * 0.6 : r.maxX < size.width * 0.62
        let x = tail ? anchor.x + (right ? 6 : -6) : (right ? r.maxX + 8 : r.minX - 8)
        let y = tail ? anchor.y + (mark.box[3] < mark.box[1] ? 10 : -10) : anchor.y
        return Text(note)
            .font(BoardInk.hand(15))
            .foregroundStyle(BoardInk.of(mark.ink))
            .shadow(color: .black.opacity(0.9), radius: 2)
            .shadow(color: .black.opacity(0.6), radius: 5)
            .multilineTextAlignment(right ? .leading : .trailing)
            .frame(maxWidth: 140, alignment: right ? .leading : .trailing)
            .fixedSize(horizontal: false, vertical: true)
            .alignmentGuide(.leading) { d in right ? -x : -(x - d.width) }
            .alignmentGuide(.top) { d in -(y - d.height / 2) }
    }
}

/// The phone's own mark: a blue ellipse with its number.
struct UserMarkView: View {
    var box: [Double]
    var n: Int?
    var size: CGSize
    var drawing = false

    var body: some View {
        let r = rect(box, in: size)
        ZStack(alignment: .topLeading) {
            Color.clear.frame(width: size.width, height: size.height)
            Ellipse()
                .stroke(BoardInk.blue, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: drawing ? [6, 5] : []))
                .frame(width: max(1, r.width), height: max(1, r.height))
                .offset(x: r.minX, y: r.minY)
                .shadow(color: .black.opacity(0.5), radius: 2)
            if let n {
                Text("\(n)")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(BoardInk.blue, in: Circle())
                    .overlay(Circle().strokeBorder(.white.opacity(0.8), lineWidth: 1.5))
                    .offset(x: r.maxX - 10, y: r.minY - 14)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Video and sound

/// A shot's video or sound, downloaded whole with the pictures' byte cap into
/// a temp file named for its address, as AVPlayer plays files by extension.
actor ReviewMedia {
    static let shared = ReviewMedia()
    private var files: [URL: URL] = [:]

    func file(_ url: URL) async throws -> URL {
        if let file = files[url], FileManager.default.fileExists(atPath: file.path) { return file }
        let data = try await CappedDownload.data(from: url, session: .shared)
        guard let ext = Self.fileExtension(data) else { throw URLError(.cannotDecodeContentData) }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Review media", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        let file = folder.appendingPathComponent(name).appendingPathExtension(ext)
        try data.write(to: file, options: .atomic)
        files[url] = file
        return file
    }

    /// From the first bytes, not the address, which says nothing.
    static func fileExtension(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        guard bytes.count >= 4 else { return nil }
        func ascii(_ range: Range<Int>) -> String { String(decoding: bytes[range], as: UTF8.self) }
        if bytes.count >= 12, ascii(4..<8) == "ftyp" {
            switch ascii(8..<12) {
            case "qt  ": return "mov"
            case "M4A ", "M4B ": return "m4a"
            default: return "mp4"
            }
        }
        if bytes.count >= 12, ascii(0..<4) == "RIFF", ascii(8..<12) == "WAVE" { return "wav" }
        if ascii(0..<3) == "ID3" { return "mp3" }
        if ascii(0..<4) == "caff" { return "caf" }
        if bytes[0] == 0xFF {
            if bytes[1] & 0xF6 == 0xF0 { return "aac" }
            if bytes[1] & 0xE0 == 0xE0 { return "mp3" }
        }
        return nil
    }
}

/// The one video or sound playing on the board: starting another stops it.
@Observable final class BoardPlayback {
    private(set) var current: ShotKey?
    private(set) var player: AVPlayer?
    private(set) var playing = false
    private(set) var progress: Double = 0
    private(set) var loading: ShotKey?
    private(set) var failed: Set<ShotKey> = []
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var endObserver: NSObjectProtocol?
    @ObservationIgnored private var failObserver: NSObjectProtocol?
    @ObservationIgnored private var statusObserver: NSKeyValueObservation?

    func toggle(_ key: ShotKey, url: URL) async {
        if current == key, let player {
            if playing {
                player.pause()
                playing = false
            } else {
                if progress >= 0.999 { player.seek(to: .zero) { _ in }; progress = 0 }
                player.play()
                playing = true
            }
            return
        }
        stop()
        loading = key
        failed.remove(key)
        let file: URL
        do { file = try await ReviewMedia.shared.file(url) } catch {
            if loading == key { loading = nil; failed.insert(key) }
            return
        }
        // Another shot was tapped while this came.
        guard loading == key else { return }
        loading = nil
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        let player = AVPlayer(url: file)
        current = key
        self.player = player
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, let item = self.player?.currentItem else { return }
                let duration = item.duration.seconds
                if duration.isFinite, duration > 0 { self.progress = min(1, max(0, time.seconds / duration)) }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: player.currentItem, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.playing = false
                self?.progress = 1
            }
        }
        // A file AVPlayer can't play: back to the still, saying so, rather
        // than a frame that never moves.
        failObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: player.currentItem, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.playFailed(key) }
        }
        statusObserver = player.currentItem?.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            Task { @MainActor in self?.playFailed(key) }
        }
        player.play()
        playing = true
    }

    private func playFailed(_ key: ShotKey) {
        guard current == key else { return }
        stop()
        failed.insert(key)
    }

    func stop() {
        player?.pause()
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
        statusObserver?.invalidate()
        timeObserver = nil
        endObserver = nil
        failObserver = nil
        statusObserver = nil
        player = nil
        current = nil
        loading = nil
        playing = false
        progress = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// The video's frames, in place of its still once it has played.
struct PlayerLayerView: UIViewRepresentable {
    var player: AVPlayer

    final class LayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = .resizeAspectFill
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }
}

/// Over a sound's still: bars, the place it's got to and a play button.
struct AudioStrip: View {
    var src: String
    var progress: Double
    var playing: Bool
    var loading: Bool

    private var levels: [Double] {
        var h = SHA256.hash(data: Data(src.utf8)).map { Double($0) / 255 }
        h += h
        return h.prefix(48).enumerated().map { i, v in 0.25 + 0.75 * v * (1 - Double(i) / 80) }
    }

    var body: some View {
        GeometryReader { geo in
            let height = min(56, geo.size.height * 0.3)
            ZStack {
                PlayCircle(playing: playing, loading: loading)
                VStack {
                    Spacer()
                    ZStack(alignment: .leading) {
                        HStack(alignment: .center, spacing: 2) {
                            ForEach(Array(levels.enumerated()), id: \.offset) { i, level in
                                Capsule()
                                    .fill(Double(i) / Double(levels.count) < progress ? BoardInk.blue : .white.opacity(0.45))
                                    .frame(height: max(3, height * 0.8 * level))
                            }
                        }
                        .frame(height: height)
                        Rectangle()
                            .fill(.white)
                            .frame(width: 2, height: height + 6)
                            .offset(x: (geo.size.width - 20) * progress)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.black.opacity(0.45))
                }
            }
        }
        .allowsHitTesting(false)
    }
}

struct PlayCircle: View {
    var playing: Bool
    var loading: Bool

    var body: some View {
        Group {
            if loading {
                ProgressView().tint(.white)
            } else {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 52, height: 52)
        .background(.black.opacity(0.55), in: Circle())
        .overlay(Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1))
        .allowsHitTesting(false)
    }
}

// MARK: - Cut-outs

nonisolated enum ReviewCutOut {
    /// The marked part of a still, padded by 0.04 of it each side, as a JPEG
    /// no more than 480 px wide, for the runner to show beside the mark line.
    static func jpeg(_ image: UIImage, box: [Double]) -> Data? {
        guard box.count == 4, let cg = image.cgImage else { return nil }
        let w = Double(cg.width), h = Double(cg.height)
        let x0 = max(0, min(box[0], box[2]) - 0.04), x1 = min(1, max(box[0], box[2]) + 0.04)
        let y0 = max(0, min(box[1], box[3]) - 0.04), y1 = min(1, max(box[1], box[3]) + 0.04)
        let crop = CGRect(x: x0 * w, y: y0 * h, width: (x1 - x0) * w, height: (y1 - y0) * h).integral
        guard crop.width >= 1, crop.height >= 1, let part = cg.cropping(to: crop) else { return nil }
        let scale = min(1, 480 / crop.width)
        let size = CGSize(width: (crop.width * scale).rounded(), height: max(1, (crop.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).jpegData(withCompressionQuality: 0.8) { _ in
            UIImage(cgImage: part).draw(in: CGRect(origin: .zero, size: size))
        }
    }
}

// MARK: - Gestures

/// Two fingers: zoom about the pinch, and pan with it.
struct BoardPinch: UIGestureRecognizerRepresentable {
    var changed: (_ state: UIGestureRecognizer.State, _ location: CGPoint, _ scale: CGFloat, _ touches: Int) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> BoardGestureDelegate { BoardGestureDelegate() }

    func makeUIGestureRecognizer(context: Context) -> UIPinchGestureRecognizer {
        let pinch = UIPinchGestureRecognizer()
        pinch.delegate = context.coordinator
        return pinch
    }

    func handleUIGestureRecognizerAction(_ pinch: UIPinchGestureRecognizer, context: Context) {
        changed(pinch.state, context.converter.localLocation, pinch.scale, pinch.numberOfTouches)
    }
}

/// One finger drags the board; off while marking, when a finger draws.
struct BoardPan: UIGestureRecognizerRepresentable {
    var enabled: Bool
    var changed: (_ state: UIGestureRecognizer.State, _ translation: CGPoint) -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> BoardGestureDelegate { BoardGestureDelegate() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.maximumNumberOfTouches = 1
        pan.delegate = context.coordinator
        return pan
    }

    func updateUIGestureRecognizer(_ pan: UIPanGestureRecognizer, context: Context) {
        pan.isEnabled = enabled
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        changed(pan.state, pan.translation(in: pan.view))
    }
}

final class BoardGestureDelegate: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
