import SwiftUI
import ThreadbearKit

/// A design review as the Mac's comparison canvas (desktop/gpui/src/
/// review_window/canvas.rs and band.rs are the source of truth): the agent's
/// lead as a sticky, then the options in one row left to right, staggered,
/// each a column with a soft glow, its big letter, its pictures and the
/// agent's handwritten notes beside them. One finger drags, two zoom; ‹ ›
/// flies along the agent's tour. A shot's Play pill plays it where it is;
/// the tools circle, highlight or pin part of a picture, which the reply can
/// point at as "[Mark n]".
struct ReviewBoard: View {
    let review: PhoneDesignReview
    @Binding var draft: DesignReviewDraft
    /// The stills' and media's addresses by src, only ones the phone may load.
    let pictures: [String: MessageImage]
    let canMark: Bool
    let sending: Bool
    let loading: Bool
    let problem: String?
    /// Sample data: launch arguments may pose the board for screenshots.
    let demo: Bool
    var close: () -> Void
    var allReviews: () -> Void
    var reload: () -> Void
    var send: () -> Void

    enum Tool: CaseIterable { case move, circle, highlight, pin }

    private struct Flight {
        var from: CanvasCamera
        var to: CanvasCamera
        var start: Date
        var id = UUID()
    }

    /// A mark being drawn, in world units.
    private struct Drawing {
        var tool: Tool
        var points: [CGPoint]
    }

    @State private var camera = CanvasCamera()
    @State private var flight: Flight?
    @State private var viewport: CGSize = .zero
    @State private var topInset: CGFloat = 0
    @State private var bottomEdge: CGFloat = 0
    @State private var board: BoardLayout?
    @State private var stops: [CanvasStop] = []
    @State private var stop = 0
    /// Moved by hand: nothing's dimmed, and the camera isn't refitted.
    @State private var roaming = false
    @State private var placedFor: CGSize?
    @State private var showNotes = true
    @State private var tool: Tool = .move
    @State private var drawing: Drawing?
    @State private var drawCancelled = false
    /// A finger is drawing: true from a stroke's start until it ends or is cancelled.
    @GestureState private var stroking = false
    @State private var playback = BoardPlayback()
    private struct LiveOption: Identifiable {
        let id = UUID()
        let url: URL
        let title: String
    }
    @State private var liveOption: LiveOption?
    @State private var selection: TextSelection?
    @FocusState private var replyFocused: Bool
    @State private var markLimitHit = false
    @State private var posed = false

    // Gesture bookkeeping, not drawn.
    @State private var pinchAnchor: CGPoint?
    @State private var pinchStartScale: CGFloat = 1
    @State private var pinchTouches = 0
    @State private var lastPan: CGPoint = .zero

    private var pending: Bool { review.pending }
    private var busy: Bool { sending || loading }
    private var drawingOn: Bool { tool != .move && canMark && pending && !busy }
    /// The pen on screen, as the Mac's; a highlight is wider.
    private static let pen: CGFloat = 3
    private static let marker: CGFloat = 22
    private static let accent = Color(hex: 0x0A84FF)

    var body: some View {
        ZStack {
            TimelineView(.animation(paused: flight == nil)) { context in
                let cam = camera(at: context.date)
                ZStack(alignment: .topLeading) {
                    boardLayer(cam)
                    overlay(cam)
                }
            }
            .ignoresSafeArea()
            VStack(spacing: 0) {
                topChrome
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { topInset = $0 }
                Spacer(minLength: 0)
                band
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { bottomEdge = $0 }
            }
        }
        .environment(\.colorScheme, .dark)
        .background(BoardInk.board.ignoresSafeArea())
        .onAppear(perform: relayout)
        .onChange(of: layoutKey) { _, _ in relayout() }
        .onChange(of: placeKey) { _, _ in place() }
        .onChange(of: busy) { _, now in
            if now {
                if drawing != nil { drawing = nil; drawCancelled = true }
            } else if !stroking {
                drawCancelled = false
            }
        }
        // However a stroke ends, ended or cancelled by the system, the next starts clean.
        .onChange(of: stroking) { _, live in if !live { drawing = nil; drawCancelled = false } }
        .onChange(of: draft.nextMarkNumber == nil) { _, full in if full && tool != .move && drawing == nil { tool = .move } }
        .onDisappear { playback.stop() }
        .onChange(of: review.id) { _, _ in liveOption = nil }
        .onChange(of: review.options) { _, _ in liveOption = nil }
        .fullScreenCover(item: $liveOption) { option in
            ReviewLivePage(url: option.url, title: option.title)
        }
        .task(id: poseKey) { await pose() }
    }

    // MARK: - Layout and camera

    /// What the board's layout depends on: the review and its pictures' sizes.
    private var layoutKey: String {
        "\(review.id):\(review.revision):\(review.options.count):" + pictures.values
            .map { "\($0.src ?? ""):\($0.width ?? 0)x\($0.height ?? 0)" }.sorted().joined(separator: ",")
    }

    private var placeKey: [CGFloat] { [viewport.width, viewport.height, topInset, bottomEdge, CGFloat(stops.count)] }

    private func aspect(_ shot: PhoneDesignReview.Shot) -> CGFloat {
        if let p = pictures[shot.src], let w = p.width, let h = p.height, w > 0, h > 0 { return CGFloat(w) / CGFloat(h) }
        return 4 / 3
    }

    private static let measure = CanvasMeasure(
        words: { text, width in
            let font = UIFont.systemFont(ofSize: CanvasMetrics.wordsSize)
            let plain = text.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            let h = (plain as NSString).boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude),
                                                     options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil).height
            return max(1, (h / font.lineHeight).rounded()) * CanvasMetrics.wordsSize * 1.5
        },
        note: { text in
            let font = BoardInk.handUIFont(CanvasMetrics.noteSize)
            let r = (text as NSString).boundingRect(with: CGSize(width: CanvasMetrics.noteWidth, height: .greatestFiniteMagnitude),
                                                    options: [.usesLineFragmentOrigin], attributes: [.font: font], context: nil)
            let lines = max(1, (r.height / font.lineHeight).rounded())
            return CGSize(width: min(CanvasMetrics.noteWidth, ceil(r.width)), height: lines * max(CanvasMetrics.noteSize * 1.1, font.lineHeight))
        })

    private func relayout() {
        let laid = BoardLayout.layout(review, aspect: aspect, measure: Self.measure)
        guard laid != board else { return }
        board = laid
        let fresh = laid.stops
        if stops.isEmpty { stop = fresh.firstIndex { $0.lit == .start } ?? 0 }
        stops = fresh
        stop = min(stop, max(0, fresh.count - 1))
        placedFor = nil
        place()
    }

    /// The screen between the top tools and the bottom band.
    private var area: CGRect {
        let top = topInset
        let bottom = bottomEdge > top + 40 ? bottomEdge : viewport.height
        return CGRect(x: 0, y: top, width: viewport.width, height: max(1, bottom - top))
    }

    /// The opening stop once the screen's size is known, and again when it
    /// changes, unless the board's been moved by hand.
    private func place() {
        guard viewport.width > 0, bottomEdge > topInset, stops.indices.contains(stop) else { return }
        guard placedFor != viewport || !roaming else { return }
        let first = placedFor == nil
        placedFor = viewport
        if first || !roaming {
            flight = nil
            camera = cameraFor(stops[stop])
        }
    }

    private func cameraFor(_ s: CanvasStop) -> CanvasCamera {
        CanvasCamera.fit(s.rect, in: area, pad: 12, max: CanvasMetrics.stopZoom)
    }

    private func camera(at date: Date) -> CanvasCamera {
        guard let flight else { return camera }
        let k = date.timeIntervalSince(flight.start) / CanvasMetrics.flightSeconds
        if k >= 1 { return flight.to }
        return flight.from.toward(flight.to, CanvasCamera.ease(CGFloat(k)), view: viewport)
    }

    /// Flies there in 650 ms, easing in and out, as the Mac's tour does.
    private func fly(to target: CanvasCamera) {
        let from = camera(at: .now)
        let f = Flight(from: from, to: target, start: .now)
        flight = f
        camera = target
        Task {
            try? await Task.sleep(for: .seconds(CanvasMetrics.flightSeconds))
            if flight?.id == f.id { flight = nil }
        }
    }

    /// A hand on the board stops any flight where it is.
    private func land() {
        guard flight != nil else { return }
        camera = camera(at: .now)
        flight = nil
    }

    private func go(_ index: Int) {
        guard stops.indices.contains(index) else { return }
        stop = index
        roaming = false
        fly(to: cameraFor(stops[index]))
    }

    private func stopIndex(_ option: Int, _ shot: Int) -> Int? {
        stops.firstIndex { $0.lit == (shot == 0 ? .opening(option) : .shot(option, shot)) }
    }

    /// A tap on a picture: to its stop, and if already there, closer, to the
    /// picture alone.
    private func lookCloser(_ option: Int, _ shot: Int) {
        guard let i = stopIndex(option, shot) else { return }
        if stop == i && !roaming, let picture = board?.shot(option, shot)?.picture {
            roaming = true
            fly(to: CanvasCamera.fit(picture, in: area, pad: 8, max: CanvasMetrics.maxZoom))
        } else {
            go(i)
        }
    }

    private var lit: CanvasLit? {
        guard !roaming, stops.indices.contains(stop), stops[stop].lit.dims else { return nil }
        return stops[stop].lit
    }

    private func alpha(_ on: Bool) -> Double { on ? 1 : 0.2 }

    // MARK: - The board

    private func boardLayer(_ cam: CanvasCamera) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                DotGrid(camera: cam)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { if let all = stops.indices.last { go(all) } }
                    .accessibilityHidden(true)
                if let board {
                    world(board, cam: cam)
                        .scaleEffect(cam.s, anchor: .topLeading)
                        .offset(x: cam.tx, y: cam.ty)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .clipped()
            .contentShape(Rectangle())
            .highPriorityGesture(drawGesture, including: drawingOn ? .all : .subviews)
            .gesture(BoardPinch(changed: pinched))
            .gesture(BoardPan(enabled: tool == .move || !drawingOn, changed: panned))
            .onAppear { viewport = geo.size }
            .onChange(of: geo.size) { _, size in viewport = size }
        }
    }

    private func world(_ board: BoardLayout, cam: CanvasCamera) -> some View {
        let lit = lit
        return ZStack(alignment: .topLeading) {
            Color.clear.frame(width: max(1, board.bounds.maxX), height: max(1, board.bounds.maxY))
            ForEach(board.options, id: \.index) { laid in backdrop(laid, lit: lit) }
            if let lead = board.lead, let note = review.note { leadNote(note, lead, on: lit == nil || lit == .lead, s: cam.s) }
            ForEach(board.options, id: \.index) { laid in column(laid, lit: lit, s: cam.s) }
            if showNotes { agentInk(board, lit: lit, s: cam.s) }
            userInk(board, s: cam.s)
        }
    }

    /// No box: a soft glow the column's shape, a touch green once ticked, and
    /// the option's big letter that its first picture mostly hides.
    @ViewBuilder private func backdrop(_ laid: BoardOptionLayout, lit: CanvasLit?) -> some View {
        let option = review.options[laid.index]
        let picked = draft.picks.contains(option.id)
        let mine = lit.map { $0.option == laid.index } ?? true
        RoundedRectangle(cornerRadius: CanvasMetrics.haloPad, style: .continuous)
            .fill(picked ? BoardInk.haloPicked : BoardInk.halo)
            .blur(radius: CanvasMetrics.haloPad * 0.75)
            .placed(laid.halo)
            .opacity(mine ? 1 : 0.55)
            .allowsHitTesting(false)
        Text(option.id)
            .font(.system(size: CanvasMetrics.letterSize, weight: .heavy))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(picked ? BoardInk.picked.opacity(0.22) : Color.white.opacity(0.065))
            .offset(x: laid.letter.minX, y: laid.letter.minY - CanvasMetrics.letterSize * 0.1)
            .opacity(mine ? 1 : 0.55)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private func leadNote(_ note: String, _ rect: CGRect, on: Bool, s: CGFloat) -> some View {
        MarkdownText(note)
            .font(.system(size: CanvasMetrics.wordsSize))
            .lineSpacing(Self.wordsSpacing)
            .foregroundStyle(BoardInk.leadText)
            .padding(24)
            .frame(width: rect.width, height: rect.height, alignment: .topLeading)
            .background(BoardInk.leadFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(BoardInk.leadEdge, lineWidth: 1 / s))
            .offset(x: rect.minX, y: rect.minY)
            .opacity(alpha(on))
    }

    private static let wordsSpacing = CanvasMetrics.wordsSize * 1.5 - UIFont.systemFont(ofSize: CanvasMetrics.wordsSize).lineHeight

    @ViewBuilder private func column(_ laid: BoardOptionLayout, lit: CanvasLit?, s: CGFloat) -> some View {
        let option = review.options[laid.index]
        let picked = draft.picks.contains(option.id)
        titleRow(laid, option: option, picked: picked, s: s)
        ForEach(laid.shots, id: \.shot) { shotLaid in
            shot(shotLaid, option: option, picked: picked, on: lit?.shows(laid.index, shotLaid.shot) ?? true, s: s)
        }
        if let words = laid.words, let note = option.note {
            MarkdownText(note)
                .font(.system(size: CanvasMetrics.wordsSize))
                .lineSpacing(Self.wordsSpacing)
                .foregroundStyle(.white.opacity(0.88))
                .frame(width: words.width, alignment: .topLeading)
                .fixedSize(horizontal: false, vertical: true)
                .offset(x: words.minX, y: words.minY)
                .opacity(alpha(lit?.showsWords(laid.index) ?? true))
        }
    }

    /// The tick (while the review can be answered), "A. Title" and the
    /// agent's star; sized with the board but never under 12 pt on screen.
    private func titleRow(_ laid: BoardOptionLayout, option: PhoneDesignReview.Option, picked: Bool, s: CGFloat) -> some View {
        let size = CanvasMetrics.titleSize
        // Never under 12 pt, unless the column itself is too small on screen
        // for that, when names would run into the next column's.
        let floor = min(12, CanvasMetrics.pictureWidth * s / 18)
        let shrink = min(size, max(floor, size * s)) / (size * s)
        let label = CGRect(x: laid.title.minX, y: laid.title.minY, width: laid.title.width, height: max(laid.title.height, size * shrink * 1.4))
        let width = option.shots.first?.kind == "page" ? laid.shots.first.map { CanvasMetrics.htmlLabelWidth(label, picture: $0.picture, scale: s) } ?? label.width : label.width
        return HStack(spacing: size * 0.45) {
            if option.reference != true && pending {
                Button { draft.pick(option.id, selected: !picked) } label: {
                    Group {
                        if picked {
                            RoundedRectangle(cornerRadius: 3.5).fill(Self.accent)
                                .overlay(Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white))
                        } else {
                            RoundedRectangle(cornerRadius: 3.5).strokeBorder(.white.opacity(0.6), lineWidth: 1.2)
                        }
                    }
                    .frame(width: 14, height: 14)
                    .scaleEffect(size / 14 * 0.62)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle().inset(by: -22))
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .accessibilityLabel("Choose \(option.id), \(option.title)")
                .accessibilityAddTraits(picked ? .isSelected : [])
            }
            Text(Self.label(option))
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .onTapGesture { if let i = stopIndex(laid.index, 0) { go(i) } }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Shows it on the board")
            if review.recommended == option.id {
                HStack(spacing: 5) {
                    Image(systemName: "star.fill").font(.system(size: 15)).foregroundStyle(BoardInk.star)
                    Text("Recommended").font(.system(size: 17)).foregroundStyle(.white.opacity(0.55))
                }
            }
            if option.reference == true {
                Text("Reference").font(.system(size: 17)).foregroundStyle(.white.opacity(0.55))
            }
        }
        .frame(width: width / shrink, alignment: .leading)
        .scaleEffect(shrink, anchor: .leading)
        .frame(width: width, height: label.height, alignment: .leading)
        .clipped()
        .offset(x: laid.title.minX, y: laid.title.minY)
    }

    private static func label(_ option: PhoneDesignReview.Option) -> String {
        let t = option.title
        return t.hasPrefix("\(option.id).") || t.hasPrefix("\(option.id) ") || t == option.id ? t : "\(option.id). \(t)"
    }

    @ViewBuilder private func shot(_ laid: BoardShotLayout, option: PhoneDesignReview.Option, picked: Bool, on: Bool, s: CGFloat) -> some View {
        let shot = option.shots[laid.shot]
        let key = ShotKey(option: laid.option, shot: laid.shot)
        let ring: CGFloat = 6
        if picked {
            RoundedRectangle(cornerRadius: 8 + ring, style: .continuous)
                .strokeBorder(BoardInk.picked, lineWidth: 2.5 / s)
                .placed(laid.picture.insetBy(dx: -ring, dy: -ring))
                .opacity(alpha(on))
                .allowsHitTesting(false)
        }
        BoardStill(url: pictures[shot.src].flatMap { URL(string: $0.url) }, preview: shot.preview != false)
            .overlay {
                if playback.current == key, shot.isVideo, let player = playback.player { PlayerLayerView(player: player) }
            }
            .overlay(alignment: .bottom) {
                if playback.current == key, shot.isAudio {
                    GeometryReader { g in
                        Rectangle().fill(BoardInk.mine).frame(width: g.size.width * playback.progress, height: 4 / s)
                            .frame(maxHeight: .infinity, alignment: .bottom)
                    }
                }
            }
            .background(Color(hex: 0x0D0D0F))
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.white.opacity(0.12), lineWidth: 1 / s))
            .placed(laid.picture)
            .opacity(alpha(on))
            .onTapGesture { lookCloser(laid.option, laid.shot) }
            .accessibilityElement()
            .accessibilityLabel(pictureLabel(option, shot))
            .accessibilityHint("Shows it closer")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { lookCloser(laid.option, laid.shot) }
        if laid.caption.height > 0 {
            Text(shot.title ?? "\(laid.shot + 1) of \(option.shots.count)")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.55))
                .lineLimit(1)
                .frame(width: shot.kind == "page" ? CanvasMetrics.htmlLabelWidth(laid.caption, picture: laid.picture, scale: s) : laid.caption.width, height: laid.caption.height, alignment: .topLeading)
                .offset(x: laid.caption.minX, y: laid.caption.minY)
                .opacity(alpha(on))
                .allowsHitTesting(false)
        }
    }

    private func pictureLabel(_ option: PhoneDesignReview.Option, _ shot: PhoneDesignReview.Shot) -> String {
        let kind = shot.isVideo ? ", video" : shot.isAudio ? ", sound" : shot.kind == "page" ? ", page" : ""
        let notes = (shot.marks ?? []).compactMap(\.note)
        let marked = notes.isEmpty ? "" : ". Marked: " + notes.joined(separator: "; ")
        return "\(option.id), \(option.title): \(shot.title ?? "picture")\(kind)\(marked)"
    }

    /// The agent's marks as the Mac draws them: a looping circle, a double
    /// underline, a marker swipe, and from each note a curled pointer with an
    /// open head; the notes in Caveat in the margin beside the picture.
    @ViewBuilder private func agentInk(_ board: BoardLayout, lit: CanvasLit?, s: CGFloat) -> some View {
        let line = 3.2 * max(s, 0.5) / s
        let size = CGSize(width: max(1, board.bounds.maxX), height: max(1, board.bounds.maxY))
        ForEach(board.options, id: \.index) { laidOption in
            let option = review.options[laidOption.index]
            ForEach(laidOption.shots, id: \.shot) { laid in
                let marks = option.shots[laid.shot].marks ?? []
                let on = lit?.shows(laid.option, laid.shot) ?? true
                ForEach(marks.indices, id: \.self) { m in
                    let mark = marks[m]
                    let ink = BoardInk.of(mark.ink)
                    let seed = CanvasDoodle.seed(option: laid.option, shot: laid.shot, mark: m)
                    let strokes = CanvasDoodle.strokes(laid.picture, mark, seed: seed)
                    if mark.kind == "highlight" {
                        StrokesShape(strokes: strokes)
                            .stroke(ink.opacity(0.3), style: StrokeStyle(lineWidth: abs(laid.picture.part(mark.box).height) * 1.05, lineCap: .butt, lineJoin: .round))
                            .frame(width: size.width, height: size.height, alignment: .topLeading)
                            .opacity(alpha(on))
                    } else if !strokes.isEmpty {
                        StrokesShape(strokes: strokes)
                            .stroke(ink, style: StrokeStyle(lineWidth: line, lineCap: .round, lineJoin: .round))
                            .frame(width: size.width, height: size.height, alignment: .topLeading)
                            .opacity(alpha(on))
                    }
                }
                ForEach(laid.notes, id: \.mark) { place in
                    if marks.indices.contains(place.mark) {
                        let ink = BoardInk.of(marks[place.mark].ink)
                        StrokesShape(strokes: CanvasDoodle.pointer(place))
                            .stroke(ink, style: StrokeStyle(lineWidth: line, lineCap: .round, lineJoin: .round))
                            .frame(width: size.width, height: size.height, alignment: .topLeading)
                            .opacity(alpha(on))
                        Text(marks[place.mark].note ?? "")
                            .font(.custom(BoardInk.handName, size: CanvasMetrics.noteSize))
                            .foregroundStyle(ink)
                            .frame(width: place.rect.width + 4, alignment: .topLeading)
                            .fixedSize(horizontal: false, vertical: true)
                            .offset(x: place.rect.minX, y: place.rect.minY)
                            .opacity(alpha(on))
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// The phone's own marks, drawn as they were, and the one being drawn.
    @ViewBuilder private func userInk(_ board: BoardLayout, s: CGFloat) -> some View {
        let size = CGSize(width: max(1, board.bounds.maxX), height: max(1, board.bounds.maxY))
        ForEach(draft.marks ?? [], id: \.n) { mark in
            if let where_ = place(of: mark, on: board), mark.kind != "pin" {
                let part = where_.0, points = where_.1
                let stroke = points.count > 1 ? CanvasStroke.through(points) : nil
                Group {
                    if mark.kind == "highlight" {
                        StrokesShape(strokes: stroke.map { [$0] } ?? [CanvasDoodle.swipe(part)])
                            .stroke(BoardInk.mine.opacity(0.38), style: StrokeStyle(lineWidth: max(part.height * 0.85, 4 / s), lineCap: .round, lineJoin: .round))
                    } else if let stroke {
                        StrokesShape(strokes: [stroke])
                            .stroke(BoardInk.mine, style: StrokeStyle(lineWidth: Self.pen / s, lineCap: .round, lineJoin: .round))
                    } else {
                        Path(ellipseIn: part).stroke(BoardInk.mine, lineWidth: Self.pen / s)
                    }
                }
                .frame(width: size.width, height: size.height, alignment: .topLeading)
            }
        }
        if let drawing, drawing.points.count > 1 {
            let marker = drawing.tool == .highlight
            StrokesShape(strokes: [.through(drawing.points)])
                .stroke(marker ? BoardInk.mine.opacity(0.38) : BoardInk.mine,
                        style: StrokeStyle(lineWidth: (marker ? Self.marker : Self.pen) / s, lineCap: .round, lineJoin: .round))
                .frame(width: size.width, height: size.height, alignment: .topLeading)
        }
    }

    /// Where one of the phone's marks is on the board: its box and stroke.
    private func place(of mark: ReviewUserMark, on board: BoardLayout) -> (CGRect, [CGPoint])? {
        guard let o = review.options.firstIndex(where: { $0.id == mark.optionId }), let laid = board.shot(o, mark.shot) else { return nil }
        let p = laid.picture
        let part = p.part(mark.box).standardized
        let points = (mark.path ?? []).compactMap { $0.count == 2 ? p.at($0[0], $0[1]) : nil }
        return (part, points)
    }

    // MARK: - On the screen, not zoomed: badges and play pills

    /// In a GeometryReader, which takes the space it's given: a fixed size
    /// here made the whole screen taller than the phone's and moved the bars.
    private func overlay(_ cam: CanvasCamera) -> some View {
        GeometryReader { _ in overlayContent(cam) }
    }

    private func overlayContent(_ cam: CanvasCamera) -> some View {
        ZStack(alignment: .topLeading) {
            Color.clear.allowsHitTesting(false)
            if let board {
                ForEach(draft.marks ?? [], id: \.n) { mark in
                    if let where_ = place(of: mark, on: board) {
                        let part = where_.0, points = where_.1
                        let pin = mark.kind == "pin"
                        let spot = cam.toScreen(pin ? (points.first ?? part.origin) : part.origin)
                        badge(mark.n, pin: pin)
                            .offset(x: spot.x - 13, y: pin ? spot.y - 26 : spot.y - 13)
                            .allowsHitTesting(false)
                    }
                }
                ForEach(board.options, id: \.index) { laidOption in
                    ForEach(laidOption.shots, id: \.shot) { laid in
                        playPill(laid, cam: cam)
                    }
                }
            }
        }
    }

    private func badge(_ n: Int, pin: Bool) -> some View {
        Text("\(n)")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(BoardInk.mineText)
            .frame(width: 26, height: 26)
            .background(BoardInk.mine, in: UnevenRoundedRectangle(topLeadingRadius: 13, bottomLeadingRadius: pin ? 3 : 13, bottomTrailingRadius: 13, topTrailingRadius: 13))
            .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
            .accessibilityHidden(true)
    }

    /// The Mac's pill at a video or sound's top right corner: Play, or Stop
    /// while it plays. It plays the shot where it is, at any zoom.
    @ViewBuilder private func playPill(_ laid: BoardShotLayout, cam: CanvasCamera) -> some View {
        let option = review.options[laid.option]
        let shot = option.shots[laid.shot]
        let key = ShotKey(option: laid.option, shot: laid.shot)
        let url = shot.media.flatMap { pictures[$0] }.flatMap { URL(string: $0.url) }
        let r = cam.rect(laid.picture)
        if (shot.isVideo || shot.isAudio || shot.kind == "page"), r.width >= (shot.kind == "page" ? 160 : 90), r.maxX > 0, r.minX < viewport.width, r.maxY > 0, r.minY < viewport.height {
            let playing = playback.current == key && playback.playing
            let failed = url == nil || playback.failed.contains(key)
            let top = topInset + 8
            let (right, y): (CGFloat, CGFloat) = shot.kind == "page" ? (r.maxX, r.minY - 32) : !playing
                ? (r.maxX - 8, max(r.minY + 8, min(top, r.maxY - 34)))
                : (r.minY - 34 >= top ? (r.maxX, r.minY - 34) : (r.maxX, r.maxY + 8))
            Button {
                guard let url else { return }
                if shot.kind == "page" {
                    playback.stop()
                    liveOption = LiveOption(url: url, title: option.title)
                } else {
                    Task { await playback.toggle(key, url: url) }
                }
            } label: {
                HStack(spacing: 6) {
                    if playback.loading == key {
                        ProgressView().controlSize(.mini).tint(.white)
                    } else {
                        Image(systemName: failed ? "desktopcomputer" : shot.kind == "page" ? "hand.tap" : playing ? "stop.fill" : shot.isAudio ? "music.note" : "play.fill")
                            .font(.system(size: 12, weight: .semibold))
                    }
                    Text(failed ? "Open on the Mac" : shot.kind == "page" ? "Interact" : playing ? "Stop" : "Play")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .frame(height: 26)
                .background(.black.opacity(0.72), in: Capsule())
                .contentShape(Capsule().inset(by: -8))
            }
            .buttonStyle(.plain)
            .disabled(failed)
            .fixedSize()
            // Offset, not alignment guides, which grew the overlay's own size
            // and pushed the whole screen sideways.
            .frame(width: 220, alignment: .trailing)
            .offset(x: right - 220, y: y)
            .accessibilityLabel(failed ? "\(shot.kind == "page" ? "Page" : shot.isAudio ? "Sound" : "Video") opens on the Mac" : "\(shot.kind == "page" ? "Interact with" : playing ? "Stop" : "Play") \(option.id), \(shot.title ?? (shot.kind == "page" ? "page" : shot.isAudio ? "sound" : "video"))")
        }
    }

    // MARK: - Moving the board

    private func pinched(_ state: UIGestureRecognizer.State, _ location: CGPoint, _ pinch: CGFloat, _ touches: Int) {
        switch state {
        case .began:
            land()
            roaming = true
            // Only a mark being drawn is given up: two fingers move the board.
            if drawing != nil { drawing = nil; drawCancelled = true }
            pinchTouches = touches
            pinchStartScale = camera.s / pinch
            pinchAnchor = camera.toWorld(location)
        case .changed:
            // A finger lifted or landed: the middle point jumps, so start again from here.
            if touches != pinchTouches || pinchAnchor == nil {
                pinchTouches = touches
                pinchStartScale = camera.s / pinch
                pinchAnchor = camera.toWorld(location)
            }
            guard let anchor = pinchAnchor else { return }
            let s = min(CanvasMetrics.maxZoom, max(CanvasMetrics.minZoom, pinchStartScale * pinch))
            camera = CanvasCamera(s: s, tx: location.x - anchor.x * s, ty: location.y - anchor.y * s)
        default:
            // Not drawCancelled: a finger still down from a cancelled stroke
            // would commit it from where it began. The stroke's end clears it.
            pinchAnchor = nil
        }
    }

    private func panned(_ state: UIGestureRecognizer.State, _ translation: CGPoint) {
        switch state {
        case .began:
            land()
            roaming = true
            lastPan = translation
        case .changed:
            let dx = translation.x - lastPan.x, dy = translation.y - lastPan.y
            lastPan = translation
            // The pinch moves the board while two fingers are down.
            guard pinchAnchor == nil else { return }
            camera.tx += dx
            camera.ty += dy
        default:
            lastPan = .zero
        }
    }

    // MARK: - Marks

    private var drawGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($stroking) { _, live, _ in live = true }
            .onChanged { value in
                // Sending started mid-drag, or a second finger came: this one's off.
                guard !drawCancelled, !busy, pinchAnchor == nil else { drawing = nil; drawCancelled = true; return }
                land()
                let p = camera.toWorld(value.location)
                if var d = drawing {
                    if tool != .pin, let last = d.points.last, hypot(p.x - last.x, p.y - last.y) * camera.s >= 3, d.points.count < 400 {
                        d.points.append(p)
                        drawing = d
                    }
                } else {
                    drawing = Drawing(tool: tool, points: [camera.toWorld(value.startLocation)] + (tool == .pin ? [] : [p]))
                }
            }
            .onEnded { _ in
                defer { drawing = nil; drawCancelled = false }
                guard !drawCancelled, !busy, let done = drawing else { return }
                finish(done)
            }
    }

    /// Where a drawing ends up: the picture under its middle, its box and
    /// stroke as fractions of that picture. Nothing off a picture or on a
    /// reference, nor a circle or highlight too small to mean anything.
    private func finish(_ d: Drawing) {
        guard let board, let first = d.points.first else { return }
        if d.tool != .pin && d.points.count < 3 { return }
        let xs = d.points.map(\.x), ys = d.points.map(\.y)
        let middle = d.tool == .pin ? first : CGPoint(x: (xs.min()! + xs.max()!) / 2, y: (ys.min()! + ys.max()!) / 2)
        guard let laid = board.shot(at: middle), review.options[laid.option].reference != true else { return }
        let p = laid.picture
        func frac(_ q: CGPoint) -> [Double] {
            [Double(min(1, max(0, (q.x - p.minX) / p.width))), Double(min(1, max(0, (q.y - p.minY) / p.height)))]
        }
        let grow = d.tool == .highlight ? Self.marker / 2 / camera.s : 0
        let a = frac(CGPoint(x: xs.min()! - grow, y: ys.min()! - grow)), b = frac(CGPoint(x: xs.max()! + grow, y: ys.max()! + grow))
        let kind = d.tool == .highlight ? "highlight" : d.tool == .pin ? "pin" : "circle"
        let box = d.tool == .pin ? frac(first) + frac(first) : [a[0], a[1], b[0], b[1]]
        addMark(option: laid.option, shot: laid.shot, kind: kind, box: box, path: d.points.prefix(200).map(frac))
    }

    private func addMark(option: Int, shot: Int, kind: String, box: [Double], path: [[Double]]?) {
        guard !busy, review.options[option].reference != true else { return }
        guard let n = draft.nextMarkNumber else { markLimitHit = true; return }
        var marks = draft.marks ?? []
        let mark = ReviewUserMark(n: n, kind: kind, optionId: review.options[option].id, shot: shot, box: box, path: path)
        marks.append(mark)
        draft.marks = marks
        insert(mark.token)
    }

    /// At the reply's cursor while it's being typed in, else on the end.
    private func insert(_ token: String) {
        var text = draft.reply ?? ""
        // A stale cursor from before would land mid-word.
        if replyFocused, let selection, case let .selection(range) = selection.indices,
           range.lowerBound >= text.startIndex, range.upperBound <= text.endIndex {
            let before = text[..<range.lowerBound].last
            let after = text[range.upperBound...].first
            let piece = (before == nil || before == " " || before == "\n" ? "" : " ") + token + (after == " " ? "" : " ")
            let start = text.distance(from: text.startIndex, to: range.lowerBound)
            text.replaceSubrange(range, with: piece)
            let end = text.index(text.startIndex, offsetBy: start + piece.count)
            draft.reply = text
            self.selection = TextSelection(insertionPoint: end)
        } else {
            let gap = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " "
            draft.reply = text + gap + token + " "
        }
    }

    private func remove(_ mark: ReviewUserMark) {
        guard !busy else { return }
        draft.marks?.removeAll { $0.n == mark.n }
        if draft.marks?.isEmpty == true { draft.marks = nil }
        if let reply = draft.reply {
            draft.reply = reply.replacingOccurrences(of: mark.token + " ", with: "").replacingOccurrences(of: mark.token, with: "")
        }
        selection = nil
    }

    // MARK: - Top: close, the title, and the Mac's floating tools

    private var topChrome: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(.white.opacity(0.1), in: Circle())
                }
                .accessibilityLabel("Close")
                Spacer(minLength: 0)
                Menu {
                    Button("All reviews", systemImage: "list.bullet", action: allReviews).disabled(busy)
                    Button("Reload review", systemImage: "arrow.clockwise", action: reload).disabled(busy)
                } label: {
                    HStack(spacing: 4) {
                        Text(review.title).font(.headline).lineLimit(1)
                        Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(.secondary)
                    }
                    .foregroundStyle(.white)
                }
                .accessibilityLabel("\(review.title), more")
                .accessibilityHint("All reviews, reload")
                Spacer(minLength: 0)
                Color.clear.frame(width: 34, height: 34)
            }
            .padding(.horizontal, 12)
            tools
            if drawingOn || markLimitHit {
                Text(markLimitHit && draft.nextMarkNumber == nil ? "That's the most marks one answer can have."
                     : tool == .pin ? "Tap a picture to drop a pin." : tool == .highlight ? "Drag over part of a picture to highlight it." : "Drag round part of a picture to circle it.")
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.75))
                    .shadow(color: .black, radius: 3)
            }
        }
        .padding(.bottom, 6)
        .background(alignment: .top) {
            BoardInk.board.opacity(0.94).ignoresSafeArea(edges: .top).frame(height: 50).frame(maxHeight: .infinity, alignment: .top)
        }
    }

    private var tools: some View {
        let marking = canMark && pending && (tool != .move || draft.nextMarkNumber != nil)
        return HStack(spacing: 2) {
            if marking {
                toolButton(.move, "hand.raised", "Move and zoom")
                toolButton(.circle, "circle", "Circle a part")
                toolButton(.highlight, "highlighter", "Highlight a part")
                toolButton(.pin, "mappin", "Drop a pin")
                Rectangle().fill(.white.opacity(0.15)).frame(width: 1, height: 20).padding(.horizontal, 4)
            }
            Button { showNotes.toggle() } label: {
                HStack(spacing: 7) {
                    Capsule().fill(showNotes ? BoardInk.yellow : .white.opacity(0.2))
                        .frame(width: 28, height: 16)
                        .overlay(alignment: showNotes ? .trailing : .leading) { Circle().fill(.white).frame(width: 12, height: 12).padding(2) }
                    Text("Notes").font(.system(size: 13))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .frame(height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Notes")
            .accessibilityValue(showNotes ? "On" : "Off")
            .accessibilityHint("Shows or hides the agent's notes")
            Button { if let all = stops.indices.last { go(all) } } label: {
                Text("See all").font(.system(size: 13)).foregroundStyle(.white)
                    .padding(.horizontal, 10).frame(height: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Fits everything on the screen")
        }
        .padding(4)
        .background(Color(hex: 0x1E1E22).opacity(0.94), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(.white.opacity(0.1), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.4), radius: 8, y: 3)
    }

    private func toolButton(_ t: Tool, _ symbol: String, _ name: String) -> some View {
        let on = tool == t
        return Button { tool = t; markLimitHit = false } label: {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(on ? BoardInk.mine : .white)
                .frame(width: 36, height: 32)
                .background(on ? BoardInk.mine.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy && t != .move)
        .accessibilityLabel(name)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: - The bottom band: the tour, the reply, None of them, Send

    private var band: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let problem {
                HStack(alignment: .firstTextBaseline) {
                    Text(problem).font(.footnote).foregroundStyle(BoardInk.rose)
                    Spacer()
                    Button("Reload", action: reload).font(.footnote.weight(.semibold)).disabled(busy)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
            tour
            if pending {
                markChips
                TextField("Add a reply", text: Binding(get: { draft.reply ?? "" }, set: { draft.reply = $0.isEmpty ? nil : $0 }),
                          selection: $selection, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($replyFocused)
                    .font(.system(size: 15))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 9)
                    .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(replyFocused ? Self.accent : .white.opacity(0.12), lineWidth: replyFocused ? 1 : 0.5))
                    .disabled(busy)
                HStack(spacing: 8) {
                    let none = draft.none == true
                    Button { draft.pickNone(!none) } label: {
                        Text("None of them")
                            .font(.system(size: 14))
                            .foregroundStyle(none ? Self.accent : .white)
                            .padding(.horizontal, 14)
                            .frame(height: 34)
                            .background(none ? Self.accent.opacity(0.25) : .white.opacity(0.08), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityAddTraits(none ? .isSelected : [])
                    .accessibilityHint(none ? "Takes back none of them" : "None of them will do")
                    let can = draft.canSend(to: review)
                    Button(action: send) {
                        HStack(spacing: 6) {
                            if sending { ProgressView().controlSize(.small).tint(can ? .white : .gray) }
                            Text(sendLabel).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                        }
                        .foregroundStyle(can && !sending ? .white : .white.opacity(sending ? 0.85 : 0.35))
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .background(can && !sending ? Self.accent : .white.opacity(sending ? 0.08 : 0.04), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy || !can)
                }
            } else {
                Text("This review is \(review.status). Answer it on the Mac if it's still open there.")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(BoardInk.band.opacity(0.97), ignoresSafeAreaEdges: .bottom)
        .overlay(alignment: .top) { Rectangle().fill(.white.opacity(0.08)).frame(height: 0.5) }
    }

    /// What Send will send, as the Mac's button says it.
    private var sendLabel: String {
        if sending { return "Sending…" }
        let picks = review.options.map(\.id).filter { draft.picks.contains($0) }
        if !picks.isEmpty { return "Send " + picks.joined(separator: " + ") }
        if draft.none == true { return "Send none of them" }
        let reply = !(draft.reply ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return reply || !(draft.marks ?? []).isEmpty || draft.notes.values.contains { !$0.isEmpty } ? "Send reply" : "Send"
    }

    private var tour: some View {
        let at = stop + 1, of = max(1, stops.count)
        return HStack(spacing: 12) {
            tourStep("chevron.left", "Back", by: -1, enabled: stop > 0)
            Text("\(at) of \(of)")
                .font(.system(size: 14).monospacedDigit())
                .foregroundStyle(.white.opacity(0.6))
                .accessibilityLabel("Stop \(at) of \(of)")
            tourStep("chevron.right", "Next", by: 1, enabled: stop < of - 1)
            Spacer(minLength: 0)
        }
    }

    private func tourStep(_ symbol: String, _ name: String, by: Int, enabled: Bool) -> some View {
        Button { go(stop + by) } label: {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(enabled ? .white : .white.opacity(0.25))
                .frame(width: 36, height: 36)
                .background(.white.opacity(0.08), in: Circle())
                .overlay(Circle().strokeBorder(.white.opacity(0.12), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(name)
    }

    /// The Mac's mark chips: the number in the phone's blue, what it's on.
    @ViewBuilder private var markChips: some View {
        let marks = (draft.marks ?? []).sorted { $0.n < $1.n }
        if !marks.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(marks, id: \.n) { mark in
                        HStack(spacing: 0) {
                            Button {
                                if let o = review.options.firstIndex(where: { $0.id == mark.optionId }) { lookCloser(o, mark.shot) }
                            } label: {
                                HStack(spacing: 5) {
                                    Text("\(mark.n)")
                                        .font(.system(size: 10, weight: .bold))
                                        .foregroundStyle(BoardInk.mineText)
                                        .frame(width: 15, height: 15)
                                        .background(BoardInk.mine, in: Circle())
                                    Text("on \(mark.optionId)")
                                        .font(.system(size: 13))
                                        .foregroundStyle(.white.opacity(0.7))
                                }
                                .padding(.leading, 3)
                                .padding(.trailing, 4)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Mark \(mark.n) on \(mark.optionId)")
                            .accessibilityHint("Shows the marked shot")
                            Button { remove(mark) } label: {
                                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white.opacity(0.6))
                                    .frame(width: 22, height: 26)
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                            .accessibilityLabel("Remove mark \(mark.n)")
                        }
                        .frame(height: 26)
                        .background(BoardInk.mine.opacity(0.14), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(BoardInk.mine.opacity(0.5), lineWidth: 0.5))
                    }
                }
            }
        }
    }

    // MARK: - Screenshots

    private var poseKey: String { "\(board != nil):\(!pictures.isEmpty):\(placedFor != nil)" }

    /// For screenshots, as a script can't tap the simulator:
    /// `-ThreadbearReviewStop <n>` flies to tour stop n (from 1),
    /// `-ThreadbearReviewAll` to everything, `-ThreadbearReviewMark` draws a
    /// circle on the first picture, `-ThreadbearReviewPlay` plays the first video.
    private func pose() async {
        guard demo, !posed, board != nil, !pictures.isEmpty, placedFor != nil else { return }
        posed = true
        let args = ProcessInfo.processInfo.arguments
        try? await Task.sleep(for: .milliseconds(500))
        if args.contains("-ThreadbearReviewMark"), draft.marks == nil {
            tool = .circle
            draft.reply = "Tighter, like this"
            let path = (0...24).map { i -> [Double] in
                let t = Double(i) / 24 * 2.15 * .pi - 2
                return [0.72 + cos(t) * 0.2 * (1 + 0.04 * Double(i) / 24), 0.32 + sin(t) * 0.2]
            }
            addMark(option: 0, shot: 0, kind: "circle", box: [0.52, 0.12, 0.93, 0.53], path: path)
            draft.pick(review.options[0].id, selected: true)
        }
        if let i = args.firstIndex(of: "-ThreadbearReviewStop") ?? args.firstIndex(of: "-ThreadbearReviewZoom"),
           i + 1 < args.count, let n = Int(args[i + 1]) {
            go(n - 1)
        } else if args.contains("-ThreadbearReviewAll"), let all = stops.indices.last {
            go(all)
        }
        if args.contains("-ThreadbearReviewPlay"),
           let o = review.options.firstIndex(where: { $0.shots.contains { $0.isVideo && $0.media != nil } }),
           let s = review.options[o].shots.firstIndex(where: { $0.isVideo }),
           let src = review.options[o].shots[s].media, let url = pictures[src].flatMap({ URL(string: $0.url) }) {
            if let stop = stopIndex(o, s) { go(stop) }
            try? await Task.sleep(for: .milliseconds(900))
            await playback.toggle(ShotKey(option: o, shot: s), url: url)
        }
    }
}

private extension View {
    /// At a rect of the board, in world units.
    func placed(_ r: CGRect) -> some View {
        frame(width: r.width, height: r.height).offset(x: r.minX, y: r.minY)
    }
}

/// Pen strokes as one shape, in the board's own units.
nonisolated private struct StrokesShape: Shape {
    var strokes: [CanvasStroke]

    func path(in rect: CGRect) -> Path {
        let path = CGMutablePath()
        for s in strokes { s.add(to: path) }
        return Path(path)
    }
}

/// The Mac's dot grid: 2 px squares on a 48-unit grid that stays 18 to 36
/// px apart on screen, moving and zooming with the board.
private struct DotGrid: View {
    var camera: CanvasCamera

    var body: some View {
        Canvas { context, size in
            var step: CGFloat = 48
            while step * camera.s < 18 { step *= 2 }
            while step * camera.s > 36 { step /= 2 }
            let gap = step * camera.s
            func rem(_ a: CGFloat) -> CGFloat { let r = a.truncatingRemainder(dividingBy: gap); return r < 0 ? r + gap : r }
            var path = Path()
            var y = rem(camera.ty)
            while y < size.height {
                var x = rem(camera.tx)
                while x < size.width {
                    path.addRect(CGRect(x: x - 1, y: y - 1, width: 2, height: 2))
                    x += gap
                }
                y += gap
            }
            context.fill(path, with: .color(BoardInk.dots))
        }
        .background(BoardInk.board)
    }
}

/// A shot's still on the board, at the size the board gives it.
private struct BoardStill: View {
    var url: URL?
    var preview: Bool
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color.white.opacity(0.04)
            if let image {
                Image(uiImage: image).resizable().interpolation(.high)
            } else if !preview {
                note("photo", "No preview on the phone. Open it on the Mac.")
            } else if failed {
                note("exclamationmark.triangle", "Couldn't load this picture")
            } else if url == nil {
                note("photo", "The preview is on its way from the Mac.")
            } else {
                ProgressView().tint(.white).scaleEffect(3)
            }
        }
        .task(id: url) {
            guard let url, preview else { return }
            failed = false
            do { image = try await PictureLoader.shared.picture(url, maxPixels: ReplyPicture.maxPixels).image } catch is CancellationError {
            } catch { failed = true }
        }
    }

    private func note(_ symbol: String, _ text: String) -> some View {
        Label(text, systemImage: symbol)
            .font(.system(size: 24))
            .foregroundStyle(.white.opacity(0.6))
            .padding(24)
    }
}
