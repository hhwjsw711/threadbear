import AVFoundation
import CoreText
import CryptoKit
import SwiftUI
import ThreadbearKit
import UIKit

/// A shot on the board: which option (by index) and which of its shots.
struct ShotKey: Hashable {
    var option: Int
    var shot: Int
}

/// The board's colours, the Mac canvas's (desktop/gpui/src/review_window/canvas.rs).
enum BoardInk {
    static let yellow = Color(hex: 0xF3B01C)
    static let green = Color(hex: 0x6FD08C)
    static let rose = Color(hex: 0xF07A9A)
    /// The phone's own marks.
    static let mine = Color(hex: 0x6CB8FF)
    static let mineText = Color(hex: 0x0B1A2A)
    static let board = Color(hex: 0x111114)
    static let dots = Color(hex: 0x2E2E36)
    static let halo = Color(hex: 0x16161B)
    static let haloPicked = Color(hex: 0x131A16)
    /// A ticked option's rings, letter and tick.
    static let picked = Color(hex: 0x4CC38A)
    static let star = Color(red: 0.86, green: 0.70, blue: 0.33)
    static let leadFill = Color(hex: 0x2A2620)
    static let leadEdge = Color(hex: 0x4A4030)
    static let leadText = Color(hex: 0xEFE6D6)
    static let band = Color(hex: 0x18181C)

    static func of(_ ink: String?) -> Color {
        switch ink {
        case "green": green
        case "rose": rose
        default: yellow
        }
    }

    /// Caveat Bold, the Mac's handwriting for the agent's notes, bundled with
    /// its licence (Fonts/Caveat-OFL.txt). Registered on first use.
    static let handName: String = {
        if let url = Bundle.main.url(forResource: "Caveat-Bold", withExtension: "ttf") {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        return UIFont(name: "Caveat-Bold", size: 12) != nil ? "Caveat-Bold" : "Noteworthy-Bold"
    }()

    static func handUIFont(_ size: CGFloat) -> UIFont {
        UIFont(name: handName, size: size) ?? .systemFont(ofSize: size, weight: .bold)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
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
