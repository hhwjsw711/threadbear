import CoreGraphics
import Foundation
import ThreadbearKit

// The review as a canvas, as the Mac lays it out: a port of
// desktop/core/src/review_canvas.rs, which is the source of truth. The board
// is in world units, where a picture is 640 wide; the camera maps them to
// the screen (screen = world × s + t).

nonisolated enum CanvasMetrics {
    static let pictureWidth: CGFloat = 640
    /// Between an option's last picture and its words.
    static let gap: CGFloat = 22
    /// Between one of an option's pictures and the next one's caption.
    static let shotGap: CGFloat = 48
    static let captionHeight: CGFloat = 34
    static let wordsSize: CGFloat = 22
    static let noteSize: CGFloat = 36
    static let noteGap: CGFloat = 96
    static let noteWidth: CGFloat = 330
    static let gutter: CGFloat = noteGap + noteWidth + 130
    static let haloPad: CGFloat = 40
    static let titleRow: CGFloat = 52
    static let titleGap: CGFloat = 10
    static let titleSize: CGFloat = 26
    static let letterSize: CGFloat = 230
    static let letterLeft: CGFloat = 0.62
    static let letterAbove: CGFloat = 0.86
    static let leadWidth: CGFloat = 440
    static let stagger: [CGFloat] = [0, 130, 50, 170]
    static let noteSpacing: CGFloat = 30
    static let minZoom: CGFloat = 0.05
    static let maxZoom: CGFloat = 3
    /// The tour never zooms past this.
    static let stopZoom: CGFloat = 1.4
    static let flightSeconds: Double = 0.65

    /// World width remaining beside a fixed screen-space HTML control.
    static func htmlLabelWidth(_ label: CGRect, picture: CGRect, scale: CGFloat) -> CGFloat {
        let top = picture.minY - 32 / scale
        if picture.width * scale >= 160, label.minY < top + 26 / scale, label.maxY > top {
            return min(label.width, max(0, picture.width - 110 / scale))
        }
        return label.width
    }
}

nonisolated extension CGRect {
    /// A point given as fractions of this rect.
    func at(_ fx: Double, _ fy: Double) -> CGPoint { CGPoint(x: minX + CGFloat(fx) * width, y: minY + CGFloat(fy) * height) }

    /// A mark's box on this rect, unnormalised as the Mac's is (an arrow's
    /// box runs tail to head).
    func part(_ box: [Double]) -> CGRect {
        guard box.count == 4 else { return .zero }
        let a = at(box[0], box[1]), b = at(box[2], box[3])
        return CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
    }

    var center: CGPoint { CGPoint(x: midX, y: midY) }
}

/// Text sizes as the phone's fonts set them.
nonisolated struct CanvasMeasure {
    /// The height of words at WORDS_SIZE wrapped to a width.
    var words: (String, CGFloat) -> CGFloat
    /// A handwritten note's size at NOTE_SIZE, wrapped to NOTE_WIDTH.
    var note: (String) -> CGSize
}

nonisolated struct NotePlace: Equatable {
    var mark: Int
    var rect: CGRect
    var target: CGPoint
    var left: Bool
}

nonisolated struct BoardShotLayout: Equatable {
    var option: Int
    var shot: Int
    var picture: CGRect
    var caption: CGRect
    var notes: [NotePlace]

    var extent: CGRect { notes.reduce(picture.union(caption)) { $0.union($1.rect) } }
}

nonisolated struct BoardOptionLayout: Equatable {
    var index: Int
    var frame: CGRect
    var words: CGRect?
    var shots: [BoardShotLayout]
    var halo: CGRect
    var title: CGRect
    var letter: CGRect

    var extent: CGRect { shots.reduce(halo.union(letter)) { $0.union($1.extent) } }
}

nonisolated struct BoardLayout: Equatable {
    var lead: CGRect?
    var options: [BoardOptionLayout]
    var bounds: CGRect

    func shot(_ option: Int, _ shot: Int) -> BoardShotLayout? {
        guard options.indices.contains(option), options[option].shots.indices.contains(shot) else { return nil }
        return options[option].shots[shot]
    }

    func shot(at point: CGPoint) -> BoardShotLayout? {
        options.lazy.flatMap(\.shots).first { $0.picture.contains(point) }
    }

    /// Lays the review out: the lead at the top left, then a column for each
    /// option left to right, its name over its pictures and its words under
    /// them, the agent's notes beside each picture. `aspect` is a shot's
    /// width over height.
    static func layout(_ review: PhoneDesignReview, aspect: (PhoneDesignReview.Shot) -> CGFloat, measure: CanvasMeasure) -> BoardLayout {
        let lead = review.note.flatMap { note -> CGRect? in
            guard !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return CGRect(x: 0, y: 0, width: CanvasMetrics.leadWidth, height: measure.words(note, CanvasMetrics.leadWidth - 48) + 48)
        }
        var x = lead.map { $0.maxX + 140 } ?? 0
        var options: [BoardOptionLayout] = []
        for (index, option) in review.options.enumerated() {
            let top = CanvasMetrics.stagger[index % CanvasMetrics.stagger.count]
            if needsLeftRoom(option) { x += CanvasMetrics.noteGap + CanvasMetrics.noteWidth + 40 }
            let laid = layOption(index, option, x: x, top: top, aspect: aspect, measure: measure)
            x = laid.frame.maxX + CanvasMetrics.gutter
            options.append(laid)
        }
        let rects = options.map(\.extent) + (lead.map { [$0] } ?? [])
        let bounds = rects.dropFirst().reduce(rects.first ?? .zero) { $0.union($1) }
        return BoardLayout(lead: lead, options: options, bounds: bounds)
    }

    private static func layOption(_ index: Int, _ option: PhoneDesignReview.Option, x: CGFloat, top: CGFloat,
                                  aspect: (PhoneDesignReview.Shot) -> CGFloat, measure: CanvasMeasure) -> BoardOptionLayout {
        let w = CanvasMetrics.pictureWidth
        let title = CGRect(x: x, y: top, width: w, height: CanvasMetrics.titleRow)
        var y = title.maxY + CanvasMetrics.titleGap
        var shots: [BoardShotLayout] = []
        for (i, shot) in option.shots.enumerated() {
            // Later pages always have a name over them ("2 of 3" if not their
            // own); the first only when it has its own.
            let captionH = i > 0 || shot.title != nil ? CanvasMetrics.captionHeight : 0
            let caption = CGRect(x: x, y: y, width: w, height: captionH)
            let h = w / max(0.05, aspect(shot))
            let picture = CGRect(x: x, y: caption.maxY + (shot.kind == "page" ? CanvasMetrics.shotGap : 0), width: w, height: h)
            y = picture.maxY + CanvasMetrics.shotGap
            shots.append(BoardShotLayout(option: index, shot: i, picture: picture, caption: caption,
                                         notes: placeNotes(picture, shot.marks ?? [], measure: measure)))
        }
        y += CanvasMetrics.gap - CanvasMetrics.shotGap
        var words: CGRect?
        if let note = option.note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let r = CGRect(x: x, y: y, width: w, height: measure.words(note, w))
            y = r.maxY
            words = r
        }
        let frame = CGRect(x: x, y: top, width: w, height: y - top)
        let pad = CanvasMetrics.haloPad
        let halo = frame.insetBy(dx: -pad, dy: -pad)
        let first = shots.first?.picture ?? frame
        let size = CanvasMetrics.letterSize
        let letter = CGRect(x: first.maxX - size * CanvasMetrics.letterLeft, y: first.minY - size * CanvasMetrics.letterAbove,
                            width: size * 0.8, height: size)
        return BoardOptionLayout(index: index, frame: frame, words: words, shots: shots, halo: halo, title: title, letter: letter)
    }

    /// A note goes left of its picture when its mark is on the picture's left part.
    static func noteGoesLeft(_ mark: PhoneDesignReview.AgentMark) -> Bool {
        (mark.box[0] + mark.box[2]) / 2 < 0.42
    }

    /// Where a mark's pointer lands, on the side its note is.
    static func target(_ picture: CGRect, _ mark: PhoneDesignReview.AgentMark) -> CGPoint {
        let part = picture.part(mark.box)
        let left = noteGoesLeft(mark)
        let edge = left ? part.origin.x : part.origin.x + part.width
        let out: CGFloat = left ? -1 : 1
        switch mark.kind {
        case "circle": return CGPoint(x: edge + out * (part.width * 0.21 + 8), y: part.origin.y + part.height * 0.45)
        case "underline": return CGPoint(x: edge + out * 10, y: part.origin.y + part.height)
        case "highlight": return CGPoint(x: edge + out * 8, y: part.origin.y + part.height / 2)
        default: return CGPoint(x: part.origin.x + part.width / 2, y: part.origin.y + part.height / 2)
        }
    }

    /// Notes in a column each side of their picture, level with their mark,
    /// nudged up so the curl arrives from below, pushed down so none overlap.
    private static func placeNotes(_ picture: CGRect, _ marks: [PhoneDesignReview.AgentMark], measure: CanvasMeasure) -> [NotePlace] {
        let order = marks.indices.filter { !(marks[$0].note ?? "").isEmpty }
            .sorted { target(picture, marks[$0]).y < target(picture, marks[$1]).y }
        var floorLeft = -CGFloat.greatestFiniteMagnitude, floorRight = -CGFloat.greatestFiniteMagnitude
        var placed: [NotePlace] = []
        for i in order {
            let size = measure.note(marks[i].note ?? "")
            let t = target(picture, marks[i])
            let left = noteGoesLeft(marks[i])
            let floor = left ? floorLeft : floorRight
            let y = max(t.y - size.height / 2 - 10, floor)
            let x = left ? picture.minX - CanvasMetrics.noteGap - size.width : picture.maxX + CanvasMetrics.noteGap
            let rect = CGRect(x: x, y: y, width: size.width, height: size.height)
            if left { floorLeft = rect.maxY + CanvasMetrics.noteSpacing } else { floorRight = rect.maxY + CanvasMetrics.noteSpacing }
            placed.append(NotePlace(mark: i, rect: rect, target: t, left: left))
        }
        return placed.sorted { $0.mark < $1.mark }
    }

    private static func needsLeftRoom(_ option: PhoneDesignReview.Option) -> Bool {
        option.shots.flatMap { $0.marks ?? [] }.contains { !($0.note ?? "").isEmpty && noteGoesLeft($0) }
    }
}

// MARK: - The tour

/// What a stop lights; the rest of the board dims while touring.
nonisolated enum CanvasLit: Equatable {
    /// The agent's lead alone (the phone's first stop: on a portrait screen
    /// the Mac's lead-and-first-option opening is too small to read).
    case lead
    /// Where it opens: all of the first option. Nothing dims.
    case start
    case opening(Int)
    case shot(Int, Int)
    case all

    var option: Int? {
        switch self {
        case let .opening(o), let .shot(o, _): o
        default: nil
        }
    }

    /// Whether this stop lights a shot (nil-lit, roaming, lights all).
    func shows(_ option: Int, _ shot: Int) -> Bool {
        switch self {
        case .all, .start: true
        case .lead: false
        case let .opening(o): o == option && shot == 0
        case let .shot(o, s): o == option && s == shot
        }
    }

    func showsWords(_ option: Int) -> Bool {
        switch self {
        case .all, .start: true
        case .lead: false
        default: self.option == option
        }
    }

    var dims: Bool { self != .all && self != .start }
}

nonisolated struct CanvasStop: Equatable {
    var rect: CGRect
    var lit: CanvasLit
}

nonisolated extension BoardLayout {
    /// The agent's order, as the Mac steps it: the lead, the first option
    /// whole, each option's pictures in turn (with its name on the first and
    /// its words on the last), then everything.
    var stops: [CanvasStop] {
        var out: [CanvasStop] = []
        if let lead { out.append(CanvasStop(rect: lead, lit: .lead)) }
        if let first = options.first { out.append(CanvasStop(rect: first.extent, lit: .start)) }
        for option in options {
            let last = option.shots.count - 1
            for shot in option.shots {
                var rect = shot.extent
                if shot.shot == last, let words = option.words { rect = rect.union(words) }
                if shot.shot == 0 {
                    rect = rect.union(option.title)
                    out.append(CanvasStop(rect: rect, lit: .opening(option.index)))
                } else {
                    out.append(CanvasStop(rect: rect, lit: .shot(option.index, shot.shot)))
                }
            }
        }
        out.append(CanvasStop(rect: bounds, lit: .all))
        return out
    }
}

// MARK: - The camera

nonisolated struct CanvasCamera: Equatable {
    var s: CGFloat = 0.4
    var tx: CGFloat = 0
    var ty: CGFloat = 0

    /// Fits `rect` in `area` (screen) with `pad` round it, no closer than `max`.
    static func fit(_ rect: CGRect, in area: CGRect, pad: CGFloat, max top: CGFloat) -> CanvasCamera {
        let s = min((area.width - pad * 2) / max(1, rect.width), (area.height - pad * 2) / max(1, rect.height))
        let clamped = min(top, max(CanvasMetrics.minZoom, s))
        return CanvasCamera(s: clamped, tx: area.midX - rect.midX * clamped, ty: area.midY - rect.midY * clamped)
    }

    func toScreen(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * s + tx, y: p.y * s + ty) }
    func toWorld(_ p: CGPoint) -> CGPoint { CGPoint(x: (p.x - tx) / s, y: (p.y - ty) / s) }
    func rect(_ r: CGRect) -> CGRect { CGRect(origin: toScreen(r.origin), size: CGSize(width: r.width * s, height: r.height * s)) }

    /// Partway to `to` (k already eased): zooming in even steps and moving
    /// the view's centre in a straight line, so a flight neither lurches nor
    /// swings wide.
    func toward(_ to: CanvasCamera, _ k: CGFloat, view: CGSize) -> CanvasCamera {
        func centre(_ c: CanvasCamera) -> CGPoint { CGPoint(x: (view.width / 2 - c.tx) / c.s, y: (view.height / 2 - c.ty) / c.s) }
        let a = centre(self), b = centre(to)
        let s = exp(log(self.s) + (log(to.s) - log(self.s)) * k)
        let c = CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
        return CanvasCamera(s: s, tx: view.width / 2 - c.x * s, ty: view.height / 2 - c.y * s)
    }

    static func ease(_ k: CGFloat) -> CGFloat {
        let k = min(1, max(0, k))
        return k < 0.5 ? 4 * k * k * k : 1 - pow(-2 * k + 2, 3) / 2
    }
}

// MARK: - Doodles

/// A pen stroke: a start and cubic segments (control 1, control 2, end).
nonisolated struct CanvasStroke {
    var start: CGPoint
    var curves: [[CGPoint]]

    /// A smooth stroke through points (Catmull-Rom).
    static func through(_ points: [CGPoint]) -> CanvasStroke {
        guard let start = points.first else { return CanvasStroke(start: .zero, curves: []) }
        var curves: [[CGPoint]] = []
        if points.count > 1 {
            for i in 0..<(points.count - 1) {
                let p0 = points[max(0, i - 1)], p1 = points[i], p2 = points[i + 1]
                let p3 = i + 2 < points.count ? points[i + 2] : p2
                curves.append([
                    CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6),
                    CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6),
                    p2,
                ])
            }
        }
        return CanvasStroke(start: start, curves: curves)
    }

    func add(to path: CGMutablePath) {
        path.move(to: start)
        for c in curves { path.addCurve(to: c[2], control1: c[0], control2: c[1]) }
    }
}

/// The Mac's seeded wobble (mulberry32), so a mark draws the same every time
/// and the same as on the Mac.
nonisolated struct CanvasWobble {
    var state: UInt32
    mutating func next() -> CGFloat {
        state = state &+ 0x6D2B_79F5
        var t = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return CGFloat(Float(t ^ (t >> 14)) / Float(UInt32.max))
    }
}

nonisolated enum CanvasDoodle {
    /// The Mac's seed for a mark's wobble: option × 97 + shot × 13 + mark + 7.
    /// Its own function, typed step by step: inline in the view builder it
    /// took Xcode 26's type checker past its time limit.
    static func seed(option: Int, shot: Int, mark: Int) -> UInt32 {
        let base: Int = option * 97
        let withShot: Int = base + shot * 13
        let total: Int = withShot + mark + 7
        return UInt32(truncatingIfNeeded: total)
    }

    /// A loop round a box, a little more than once round, the ends crossing.
    static func circle(_ part: CGRect, seed: UInt32) -> CanvasStroke {
        var w = CanvasWobble(state: seed)
        let c = CGPoint(x: part.origin.x + part.width / 2, y: part.origin.y + part.height / 2)
        let rx = part.width / 2 * 1.42 + 8, ry = part.height / 2 * 1.42 + 8
        let start = -2.2 + w.next() * 0.6
        let turn = 2 * CGFloat.pi * 1.12
        let n = 22
        let points = (0...n).map { i -> CGPoint in
            let t = start + turn * CGFloat(i) / CGFloat(n)
            let k = 1 + (w.next() - 0.5) * 0.06 + (CGFloat(i) / CGFloat(n)) * 0.05
            return CGPoint(x: c.x + cos(t) * rx * k, y: c.y + sin(t) * ry * k)
        }
        return .through(points)
    }

    /// Two passes under a box's bottom edge, the second a touch lower.
    static func underline(_ part: CGRect, seed: UInt32) -> [CanvasStroke] {
        var w = CanvasWobble(state: seed)
        let bottom = part.origin.y + part.height
        return (0..<2).map { pass in
            let points = (0...6).map { i -> CGPoint in
                let f = CGFloat(i) / 6
                return CGPoint(x: part.origin.x - 6 + (part.width + 18) * f,
                               y: bottom + 4 + CGFloat(pass) * 5 + (w.next() - 0.5) * 3 + sin(f * .pi) * 2)
            }
            return .through(points)
        }
    }

    /// A marker swipe's middle line, a little uphill; drawn as thick as the box.
    static func swipe(_ part: CGRect) -> CanvasStroke {
        let h = part.height, x = part.origin.x, y = part.origin.y
        return .through([CGPoint(x: x - 6, y: y + h * 0.55 + 2), CGPoint(x: x + part.width / 2, y: y + h * 0.5),
                         CGPoint(x: x + part.width + 6, y: y + h * 0.45 - 2)])
    }

    /// The curled pointer from a note to its mark.
    static func curl(from: CGPoint, to: CGPoint) -> CanvasStroke {
        let sx = from.x, sy = from.y, ex = to.x, ey = to.y
        let d: CGFloat = ex < sx ? 1 : -1
        return CanvasStroke(start: from, curves: [
            [CGPoint(x: sx - d * 28, y: sy - 12), CGPoint(x: sx - d * 46, y: sy + 4), CGPoint(x: sx - d * 36, y: sy + 22)],
            [CGPoint(x: sx - d * 24, y: sy + 40), CGPoint(x: sx - d * 10, y: sy + 17), CGPoint(x: sx - d * 32, y: sy + 15)],
            [CGPoint(x: sx - d * 46, y: sy + 13), CGPoint(x: ex + d * 40, y: ey + 10), to],
        ])
    }

    /// An open arrowhead at a stroke's end.
    static func arrowhead(_ stroke: CanvasStroke, size: CGFloat) -> CanvasStroke {
        guard let last = stroke.curves.last else { return CanvasStroke(start: .zero, curves: []) }
        let end = last[2]
        let from = last[1] != end ? last[1] : last[0]
        let len = max(0.001, hypot(end.x - from.x, end.y - from.y))
        let dx = (end.x - from.x) / len, dy = (end.y - from.y) / len
        let b = CGPoint(x: end.x - dx * size, y: end.y - dy * size)
        let wing = size * 0.56
        let one = CGPoint(x: b.x - dy * wing, y: b.y + dx * wing), two = CGPoint(x: b.x + dy * wing, y: b.y - dx * wing)
        return CanvasStroke(start: one, curves: [[one, end, end], [end, two, two]])
    }

    /// One of the agent's marks, before its pointer. An arrow is only its pointer.
    static func strokes(_ picture: CGRect, _ mark: PhoneDesignReview.AgentMark, seed: UInt32) -> [CanvasStroke] {
        let part = picture.part(mark.box)
        switch mark.kind {
        case "circle": return [circle(part, seed: seed)]
        case "underline": return underline(part, seed: seed)
        case "highlight": return [swipe(part)]
        default: return []
        }
    }

    /// The pointer from a note to its mark, with its head.
    static func pointer(_ note: NotePlace) -> [CanvasStroke] {
        let mid = note.rect.midY
        let from = note.left ? CGPoint(x: note.rect.maxX + 12, y: mid) : CGPoint(x: note.rect.minX - 12, y: mid)
        let shaft = curl(from: from, to: note.target)
        return [shaft, arrowhead(shaft, size: 16)]
    }
}
