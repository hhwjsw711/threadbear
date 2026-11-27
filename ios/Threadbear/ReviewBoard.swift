import SwiftUI
import ThreadbearKit

/// A design review as a board, as on the Mac: every option a column card, two
/// to a row, on a dark board that one finger drags and two fingers zoom. A
/// tap on a shot brings it to the screen's width; another plays its video or
/// sound. The agent's marks are drawn over the stills; in Mark mode a finger
/// circles part of one, which the reply can point at as "[Mark n]".
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

    // The board's place: screen = offset + board point * scale.
    @State private var scale: CGFloat = 1
    @State private var offset: CGPoint = .zero
    @State private var viewport: CGSize = .zero
    @State private var boardSize: CGSize = .zero
    @State private var topInset: CGFloat = 0
    @State private var bottomEdge: CGFloat = 0
    @State private var shotFrames: [ShotKey: CGRect] = [:]
    @State private var cardFrames: [String: CGRect] = [:]
    /// Once the user has moved the board, it's no longer refitted as pictures load.
    @State private var userMoved = false
    @State private var showNotes = true
    @State private var marking = false
    @State private var focused: ShotKey?
    @State private var tourIndex: Int?
    @State private var drawing: Drawing?
    @State private var drawCancelled = false
    /// A finger is drawing: true from a stroke's start until it ends or is cancelled.
    @GestureState private var stroking = false
    @State private var playback = BoardPlayback()
    @State private var selection: TextSelection?
    @FocusState private var replyFocused: Bool
    @State private var markLimitHit = false

    // Gesture bookkeeping, not drawn.
    @State private var pinchAnchor: CGPoint?
    @State private var pinchStartScale: CGFloat = 1
    @State private var pinchTouches = 0
    @State private var lastPan: CGPoint = .zero

    private struct Drawing {
        var key: ShotKey
        var start: CGPoint
        var end: CGPoint
        var box: [Double] { [start.x, start.y, end.x, end.y].map { Double(min(1, max(0, $0))) } }
    }

    private enum Metrics {
        static let card: CGFloat = 360
        static let inner: CGFloat = 16
        static var picture: CGFloat { card - inner * 2 }
        static let gap: CGFloat = 32
        static let margin: CGFloat = 48
        static let scales: ClosedRange<CGFloat> = 0.15...6
    }

    private var pending: Bool { review.pending }
    private var busy: Bool { sending || loading }

    private var tour: [ShotKey] {
        review.options.indices.flatMap { o in review.options[o].shots.indices.map { ShotKey(option: o, shot: $0) } }
    }

    var body: some View {
        ZStack {
            board.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { topInset = $0 }
                Spacer(minLength: 0)
                replyBar
                    .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).minY } action: { bottomEdge = $0 }
            }
        }
        .environment(\.colorScheme, .dark)
        .background(BoardInk.board.ignoresSafeArea())
        .onChange(of: fitInputs) { _, _ in if !userMoved { fitAll(animated: false) } }
        .onChange(of: marking) { _, on in if !on { drawing = nil } }
        .onChange(of: busy) { _, now in
            if now {
                if drawing != nil { drawing = nil; drawCancelled = true }
            } else if !stroking {
                drawCancelled = false
            }
        }
        // However a stroke ends, ended or cancelled by the system, the next starts clean.
        .onChange(of: stroking) { _, live in if !live { drawing = nil; drawCancelled = false } }
        .onDisappear { playback.stop() }
        .task(id: shotFrames.count + pictures.count * 1000) { pose() }
    }

    /// What the opening fit depends on.
    private var fitInputs: [CGFloat] { [viewport.width, viewport.height, boardSize.width, boardSize.height, topInset, bottomEdge] }

    // MARK: - The board

    private var board: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                DotGrid(scale: scale, offset: offset)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { fitAll(animated: true) }
                    .accessibilityHidden(true)
                content
                    .scaleEffect(scale, anchor: .topLeading)
                    .offset(x: offset.x, y: offset.y)
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            .clipped()
            .gesture(BoardPinch(changed: pinched))
            .gesture(BoardPan(enabled: !marking, changed: panned))
            .onAppear { viewport = geo.size }
            .onChange(of: geo.size) { _, size in viewport = size }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 40) {
            if let note = review.note, !note.isEmpty {
                MarkdownText(note)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(.white.opacity(0.75))
                    .frame(width: Metrics.card * 2 + Metrics.gap, alignment: .leading)
            }
            if !pending {
                Text("This review is \(review.status). Your answer stays here for reference.")
                    .font(.system(size: 17))
                    .foregroundStyle(.white.opacity(0.6))
            }
            ForEach(Array(stride(from: 0, to: review.options.count, by: 2)), id: \.self) { first in
                HStack(alignment: .top, spacing: Metrics.gap) {
                    ForEach(first..<min(first + 2, review.options.count), id: \.self) { index in
                        card(index)
                    }
                }
            }
        }
        .padding(Metrics.margin)
        .fixedSize()
        .coordinateSpace(.named("board"))
        .onGeometryChange(for: CGSize.self) { $0.size } action: { boardSize = $0 }
    }

    private func card(_ index: Int) -> some View {
        let option = review.options[index]
        let picked = draft.picks.contains(option.id)
        let tint = picked ? BoardInk.green : [BoardInk.blue, Color.purple, Color.teal, Color.orange][index % 4]
        let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)
        return VStack(alignment: .leading, spacing: 14) {
            header(option, picked: picked)
            ForEach(Array(option.shots.enumerated()), id: \.offset) { s, shot in
                shotView(ShotKey(option: index, shot: s), option: option, shot: shot, picked: picked)
            }
            if let note = option.note, !note.isEmpty {
                MarkdownText(note)
                    .font(.system(size: 15))
                    .foregroundStyle(.white.opacity(0.8))
            }
        }
        .padding(Metrics.inner)
        .frame(width: Metrics.card, alignment: .leading)
        .background {
            ZStack(alignment: .topTrailing) {
                shape.fill(Color.white.opacity(0.035))
                shape.fill(RadialGradient(colors: [tint.opacity(picked ? 0.28 : 0.14), .clear], center: .top, startRadius: 0, endRadius: 380))
                Text(option.id)
                    .font(.system(size: 220, weight: .black, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.3)
                    .foregroundStyle(.white.opacity(0.05))
                    .frame(maxWidth: Metrics.card * 0.8, alignment: .trailing)
                    .offset(x: -4, y: 6)
                    .accessibilityHidden(true)
            }
            .clipShape(shape)
            .contentShape(shape)
            .onTapGesture(count: 2) { fitAll(animated: true) }
        }
        .overlay(shape.strokeBorder(picked ? BoardInk.green.opacity(0.7) : .white.opacity(0.08), lineWidth: picked ? 2 : 1))
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("board")) } action: { cardFrames[option.id] = $0 }
    }

    private func header(_ option: PhoneDesignReview.Option, picked: Bool) -> some View {
        HStack(spacing: 10) {
            if option.reference == true {
                Text("Reference")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.1), in: Capsule())
            } else {
                Button {
                    draft.pick(option.id, selected: !picked)
                } label: {
                    Image(systemName: picked ? "checkmark" : "")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(width: 30, height: 30)
                        .background(picked ? BoardInk.green : .clear, in: Circle())
                        .overlay(Circle().strokeBorder(picked ? BoardInk.green : .white.opacity(0.5), lineWidth: 2))
                        .contentShape(Circle().inset(by: -8))
                }
                .buttonStyle(.plain)
                .disabled(!pending || busy)
                .accessibilityLabel("Choose \(option.id), \(option.title)")
                .accessibilityAddTraits(picked ? .isSelected : [])
            }
            Text("\(option.id) · \(option.title)")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(2)
            if review.recommended == option.id {
                Image(systemName: "star.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(BoardInk.yellow)
                    .accessibilityLabel("Recommended")
            }
            Spacer(minLength: 0)
        }
    }

    private func pictureSize(_ shot: PhoneDesignReview.Shot) -> CGSize {
        let w = Metrics.picture
        if let p = pictures[shot.src], let pw = p.width, let ph = p.height, pw > 0, ph > 0 {
            return CGSize(width: w, height: (w * CGFloat(ph) / CGFloat(pw)).rounded())
        }
        return CGSize(width: w, height: (w * 0.75).rounded())
    }

    @ViewBuilder private func shotView(_ key: ShotKey, option: PhoneDesignReview.Option, shot: PhoneDesignReview.Shot, picked: Bool) -> some View {
        let size = pictureSize(shot)
        let mediaURL = shot.media.flatMap { pictures[$0] }.flatMap { URL(string: $0.url) }
        VStack(alignment: .leading, spacing: 6) {
            BoardStill(url: pictures[shot.src].flatMap { URL(string: $0.url) }, preview: shot.preview != false)
                .frame(width: size.width, height: size.height)
                .overlay { mediaOverlay(key, shot: shot, size: size, playable: mediaURL != nil) }
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(picked ? BoardInk.green : .white.opacity(0.1), lineWidth: picked ? 3 : 0.5)
                }
                .overlay(alignment: .topLeading) {
                    if showNotes, let marks = shot.marks, !marks.isEmpty {
                        AgentMarksOverlay(marks: marks, size: size)
                    }
                }
                .overlay(alignment: .topLeading) { userMarks(key, option: option, size: size) }
                .contentShape(Rectangle())
                .onTapGesture { if !marking { tapped(key, media: mediaURL) } }
                .gesture(drawGesture(key, size: size, media: mediaURL), including: marking && pending && !busy && option.reference != true ? .all : .subviews)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("board")) } action: { shotFrames[key] = $0 }
                .accessibilityElement()
                .accessibilityLabel(pictureLabel(option, shot))
                .accessibilityHint(mediaURL == nil ? "Fills the screen with it" : "Fills the screen with it, then plays it")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { tapped(key, media: mediaURL) }
            if let title = shot.title, !title.isEmpty {
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
    }

    private func pictureLabel(_ option: PhoneDesignReview.Option, _ shot: PhoneDesignReview.Shot) -> String {
        let kind = shot.isVideo ? ", video" : shot.isAudio ? ", sound" : shot.kind == "page" ? ", page" : ""
        let notes = (shot.marks ?? []).compactMap(\.note)
        let marked = notes.isEmpty ? "" : ". Marked: " + notes.joined(separator: "; ")
        return "\(option.id), \(option.title): \(shot.title ?? "picture")\(kind)\(marked)"
    }

    @ViewBuilder private func mediaOverlay(_ key: ShotKey, shot: PhoneDesignReview.Shot, size: CGSize, playable: Bool) -> some View {
        let current = playback.current == key
        if shot.isVideo {
            ZStack {
                if current, let player = playback.player { PlayerLayerView(player: player) }
                if playable && !(current && playback.playing) {
                    PlayCircle(playing: false, loading: playback.loading == key)
                }
                if !playable || playback.failed.contains(key) { onMacNote("Play the video on the Mac") }
            }
        } else if shot.isAudio {
            if playable && !playback.failed.contains(key) {
                AudioStrip(src: shot.src, progress: current ? playback.progress : 0, playing: current && playback.playing, loading: playback.loading == key)
            } else {
                onMacNote("Play the sound on the Mac")
            }
        }
    }

    private func onMacNote(_ text: String) -> some View {
        VStack {
            Spacer()
            HStack {
                Label(text, systemImage: "desktopcomputer")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.black.opacity(0.6), in: Capsule())
                Spacer()
            }
        }
        .padding(8)
        .allowsHitTesting(false)
    }

    @ViewBuilder private func userMarks(_ key: ShotKey, option: PhoneDesignReview.Option, size: CGSize) -> some View {
        ZStack(alignment: .topLeading) {
            ForEach((draft.marks ?? []).filter { $0.optionId == option.id && $0.shot == key.shot }, id: \.n) { mark in
                UserMarkView(box: mark.box, n: mark.n, size: size)
            }
            if let drawing, drawing.key == key {
                UserMarkView(box: drawing.box, n: nil, size: size, drawing: true)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .allowsHitTesting(false)
    }

    private func drawGesture(_ key: ShotKey, size: CGSize, media: URL?) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($stroking) { _, live, _ in live = true }
            .onChanged { value in
                // Sending started mid-drag, or a second finger came: this circle's off.
                guard !drawCancelled, !busy, pinchAnchor == nil else { drawing = nil; drawCancelled = true; return }
                let a = CGPoint(x: value.startLocation.x / size.width, y: value.startLocation.y / size.height)
                let b = CGPoint(x: value.location.x / size.width, y: value.location.y / size.height)
                drawing = Drawing(key: key, start: a, end: b)
            }
            .onEnded { _ in
                defer { drawing = nil; drawCancelled = false }
                guard !drawCancelled, !busy, let done = drawing else { return }
                let box = done.box
                // A tap, not a circle.
                if abs(box[2] - box[0]) < 0.03 && abs(box[3] - box[1]) < 0.03 { tapped(key, media: media); return }
                addMark(key, box: [min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])])
            }
    }

    // MARK: - Moving the board

    private var available: CGRect {
        let top = topInset
        let bottom = bottomEdge > top ? bottomEdge : viewport.height
        return CGRect(x: 0, y: top, width: viewport.width, height: max(1, bottom - top))
    }

    private func clamp(_ s: CGFloat) -> CGFloat { min(Metrics.scales.upperBound, max(Metrics.scales.lowerBound, s)) }

    /// Shows `rect` (board points) as large as fits between the bars, `margin` round it.
    private func show(_ rect: CGRect, margin: CGFloat, animated: Bool) {
        guard rect.width > 0, rect.height > 0, viewport.width > 0 else { return }
        let area = available
        let s = clamp(min((area.width - margin * 2) / rect.width, (area.height - margin * 2) / rect.height))
        let target = CGPoint(x: area.midX - rect.midX * s, y: area.midY - rect.midY * s)
        if animated {
            withAnimation(.smooth(duration: 0.4)) { scale = s; offset = target }
        } else {
            scale = s
            offset = target
        }
    }

    private func fitAll(animated: Bool) {
        focused = nil
        tourIndex = nil
        show(CGRect(origin: .zero, size: boardSize), margin: 8, animated: animated)
        if animated { userMoved = false }
    }

    private func zoom(to key: ShotKey) {
        guard let frame = shotFrames[key] else { return }
        userMoved = true
        focused = key
        tourIndex = tour.firstIndex(of: key)
        show(frame, margin: 8, animated: true)
    }

    private func isFilling(_ key: ShotKey) -> Bool {
        guard focused == key, let frame = shotFrames[key] else { return false }
        let area = available
        let s = clamp(min((area.width - 16) / frame.width, (area.height - 16) / frame.height))
        return abs(scale - s) / s < 0.05
    }

    private func tapped(_ key: ShotKey, media: URL?) {
        if isFilling(key) {
            if let media { Task { await playback.toggle(key, url: media) } }
        } else {
            zoom(to: key)
        }
    }

    private func step(_ by: Int) {
        let shots = tour
        guard !shots.isEmpty else { return }
        let next = tourIndex.map { ($0 + by + shots.count) % shots.count } ?? (by > 0 ? 0 : shots.count - 1)
        zoom(to: shots[next])
    }

    private func pinched(_ state: UIGestureRecognizer.State, _ location: CGPoint, _ pinch: CGFloat, _ touches: Int) {
        switch state {
        case .began:
            userMoved = true
            focused = nil
            // Only a circle being drawn is given up: two fingers move the board.
            if drawing != nil { drawing = nil; drawCancelled = true }
            pinchTouches = touches
            pinchStartScale = scale / pinch
            pinchAnchor = CGPoint(x: (location.x - offset.x) / scale, y: (location.y - offset.y) / scale)
        case .changed:
            // A finger lifted or landed: the middle point jumps, so start again from here.
            if touches != pinchTouches || pinchAnchor == nil {
                pinchTouches = touches
                pinchStartScale = scale / pinch
                pinchAnchor = CGPoint(x: (location.x - offset.x) / scale, y: (location.y - offset.y) / scale)
            }
            guard let anchor = pinchAnchor else { return }
            let s = clamp(pinchStartScale * pinch)
            scale = s
            offset = CGPoint(x: location.x - anchor.x * s, y: location.y - anchor.y * s)
        default:
            // Not drawCancelled: a finger still down from a cancelled stroke
            // would commit it from where it began. The stroke's end clears it.
            pinchAnchor = nil
        }
    }

    private func panned(_ state: UIGestureRecognizer.State, _ translation: CGPoint) {
        switch state {
        case .began:
            userMoved = true
            lastPan = translation
        case .changed:
            let delta = CGPoint(x: translation.x - lastPan.x, y: translation.y - lastPan.y)
            lastPan = translation
            // The pinch moves the board while two fingers are down.
            guard pinchAnchor == nil else { return }
            if abs(delta.x) + abs(delta.y) > 0 { focused = nil }
            offset = CGPoint(x: offset.x + delta.x, y: offset.y + delta.y)
        default:
            lastPan = .zero
        }
    }

    // MARK: - Marks

    private func addMark(_ key: ShotKey, box: [Double]) {
        guard !busy, review.options[key.option].reference != true else { return }
        guard let n = draft.nextMarkNumber else { markLimitHit = true; return }
        var marks = draft.marks ?? []
        let mark = ReviewUserMark(n: n, optionId: review.options[key.option].id, shot: key.shot, box: box)
        marks.append(mark)
        draft.marks = marks
        insert(mark.token)
    }

    /// At the reply's cursor if it has one, else on the end.
    private func insert(_ token: String) {
        var text = draft.reply ?? ""
        // The cursor only counts while the reply is being typed in: a stale
        // one from before would land mid-word.
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

    // MARK: - Bars

    private var topBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                Button(action: close) { barIcon("xmark") }
                    .accessibilityLabel("Close")
                Menu {
                    if pending {
                        Toggle("None of these", isOn: Binding(get: { draft.none == true }, set: { draft.pickNone($0) }))
                            .disabled(busy)
                    }
                    Button("All reviews", systemImage: "list.bullet", action: allReviews).disabled(busy)
                    Button("Reload review", systemImage: "arrow.clockwise", action: reload).disabled(busy)
                } label: {
                    HStack(spacing: 4) {
                        Text(review.title)
                            .font(.headline)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                }
                .accessibilityLabel("\(review.title), more")
                .accessibilityHint("None of these, all reviews, reload")
                Button { fitAll(animated: true) } label: {
                    Text("All").font(.system(size: 15, weight: .semibold)).frame(minWidth: 40, minHeight: 36)
                }
                .foregroundStyle(.white)
                .background(.white.opacity(0.1), in: Capsule())
                .accessibilityHint("Fits every option on the screen")
            }
            HStack(spacing: 8) {
                toggle("Notes", systemImage: "scribble", on: $showNotes, hint: "Shows or hides the agent's marks")
                if canMark && pending && (marking || draft.nextMarkNumber != nil) {
                    toggle("Mark", systemImage: "pencil.tip", on: $marking, hint: "Drag on a picture to circle part of it")
                        .disabled(busy)
                }
                Spacer()
                Button { step(-1) } label: { barIcon("chevron.left") }
                    .accessibilityLabel("Previous shot")
                Text(tourIndex.map { "\($0 + 1)/\(tour.count)" } ?? "\(tour.count) shots")
                    .font(.system(size: 13, weight: .medium).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.7))
                    .frame(minWidth: 34)
                    .accessibilityLabel(tourIndex.map { "Shot \($0 + 1) of \(tour.count)" } ?? "\(tour.count) shots")
                Button { step(1) } label: { barIcon("chevron.right") }
                    .accessibilityLabel("Next shot")
            }
            if marking {
                Text(markLimitHit ? "That's the most marks one answer can have." : "Drag on a picture to circle part of it. Two fingers move the board.")
                    .font(.footnote)
                    .foregroundStyle(markLimitHit ? BoardInk.rose : .white.opacity(0.7))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .background(BoardInk.board.opacity(0.94), ignoresSafeAreaEdges: .top)
    }

    private func toggle(_ title: String, systemImage: String, on: Binding<Bool>, hint: String) -> some View {
        Button { on.wrappedValue.toggle() } label: {
            Label(title, systemImage: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .padding(.horizontal, 12)
                .frame(minHeight: 34)
                .foregroundStyle(on.wrappedValue ? .black : .white)
                .background(on.wrappedValue ? (title == "Mark" ? BoardInk.blue : .white) : .white.opacity(0.1), in: Capsule())
        }
        .accessibilityAddTraits(on.wrappedValue ? .isSelected : [])
        .accessibilityHint(hint)
    }

    private func barIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 36, height: 36)
            .background(.white.opacity(0.1), in: Circle())
    }

    @ViewBuilder private var replyBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let problem {
                HStack(alignment: .firstTextBaseline) {
                    Text(problem).font(.footnote).foregroundStyle(BoardInk.rose)
                    Spacer()
                    Button("Reload", action: reload).font(.footnote.weight(.semibold)).disabled(busy)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
            }
            if pending {
                chips
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Reply", text: Binding(get: { draft.reply ?? "" }, set: { draft.reply = $0.isEmpty ? nil : $0 }),
                              selection: $selection, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($replyFocused)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .disabled(busy)
                    Button(action: send) {
                        Group {
                            if sending { ProgressView().tint(.black) } else { Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)) }
                        }
                        .foregroundStyle(.black)
                        .frame(width: 40, height: 40)
                        .background(draft.canSend(to: review) || sending ? Color.white : Color.white.opacity(0.3), in: Circle())
                    }
                    .disabled(busy || !draft.canSend(to: review))
                    .accessibilityLabel(sending ? "Sending answer" : "Send answer")
                }
            } else {
                Text("This review is \(review.status). Answer it on the Mac if it's still open there.")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(BoardInk.board.opacity(0.94), ignoresSafeAreaEdges: .bottom)
    }

    @ViewBuilder private var chips: some View {
        let picked = review.options.filter { draft.picks.contains($0.id) }
        let marks = (draft.marks ?? []).sorted { $0.n < $1.n }
        if !picked.isEmpty || !marks.isEmpty || draft.none == true {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if draft.none == true {
                        chip("None of these", color: .white.opacity(0.85)) { draft.pickNone(false) }
                            .disabled(busy)
                            .accessibilityHint("Removes None of these")
                    }
                    ForEach(picked) { option in
                        chip("✓ \(option.id)", color: BoardInk.green) {
                            if let frame = cardFrames[option.id] { userMoved = true; focused = nil; show(frame, margin: 8, animated: true) }
                        }
                        .accessibilityLabel("Chosen: \(option.id), \(option.title)")
                        .accessibilityHint("Shows it on the board")
                    }
                    ForEach(marks, id: \.n) { mark in
                        HStack(spacing: 0) {
                            chip("Mark \(mark.n)", color: BoardInk.blue) {
                                if let o = review.options.firstIndex(where: { $0.id == mark.optionId }) { zoom(to: ShotKey(option: o, shot: mark.shot)) }
                            }
                            .accessibilityHint("Shows the marked shot")
                            Button { remove(mark) } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(BoardInk.blue)
                                    .frame(width: 28, height: 30)
                            }
                            .disabled(busy)
                            .accessibilityLabel("Remove mark \(mark.n)")
                        }
                    }
                }
            }
        }
    }

    private func chip(_ title: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(color)
                .padding(.horizontal, 10)
                .frame(minHeight: 30)
                .background(color.opacity(0.16), in: Capsule())
                .overlay(Capsule().strokeBorder(color.opacity(0.5), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Screenshots

    /// For sim-shots: `-ThreadbearReviewZoom <n>` fills the screen with the
    /// tour's shot n (from 1), `-ThreadbearReviewMark` draws a mark on the first
    /// shot in Mark mode, `-ThreadbearReviewPlay` plays the zoomed shot. The
    /// simulator can't be tapped from a script.
    private func pose() {
        guard demo, !tour.isEmpty, shotFrames.count == tour.count, !pictures.isEmpty else { return }
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-ThreadbearReviewMark"), draft.marks == nil {
            marking = true
            draft.reply = "Tighter, like this"
            addMark(ShotKey(option: 0, shot: 0), box: [0.52, 0.14, 0.92, 0.5])
            draft.pick("A", selected: true)
        }
        if let i = args.firstIndex(of: "-ThreadbearReviewZoom"), i + 1 < args.count, let n = Int(args[i + 1]), tour.indices.contains(n - 1) {
            Task {
                try? await Task.sleep(for: .milliseconds(600))
                zoom(to: tour[n - 1])
                // `-ThreadbearReviewPlay`: then the second tap, playing it.
                guard args.contains("-ThreadbearReviewPlay") else { return }
                try? await Task.sleep(for: .milliseconds(800))
                let key = tour[n - 1]
                let shot = review.options[key.option].shots[key.shot]
                tapped(key, media: shot.media.flatMap { pictures[$0] }.flatMap { URL(string: $0.url) })
            }
        }
    }
}

/// The board's faint dots, moving and spreading with it, thinned out when
/// zoomed far out so they stay faint.
private struct DotGrid: View {
    var scale: CGFloat
    var offset: CGPoint

    var body: some View {
        Canvas { context, size in
            var spacing = 28 * scale
            while spacing < 16 { spacing *= 2 }
            let dot = max(1.2, min(2.4, 1.6 * scale))
            let startX = offset.x.truncatingRemainder(dividingBy: spacing) - spacing
            let startY = offset.y.truncatingRemainder(dividingBy: spacing) - spacing
            var path = Path()
            var y = startY
            while y < size.height + spacing {
                var x = startX
                while x < size.width + spacing {
                    path.addEllipse(in: CGRect(x: x - dot / 2, y: y - dot / 2, width: dot, height: dot))
                    x += spacing
                }
                y += spacing
            }
            context.fill(path, with: .color(.white.opacity(0.09)))
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
            Color.white.opacity(0.06)
            if let image {
                Image(uiImage: image).resizable().interpolation(.high).scaledToFill()
            } else if !preview {
                note("photo", "No preview on the phone. Open it on the Mac.")
            } else if failed {
                note("exclamationmark.triangle", "Couldn't load this picture")
            } else if url == nil {
                note("photo", "The preview is on its way from the Mac.")
            } else {
                ProgressView().tint(.white)
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
            .font(.system(size: 13))
            .foregroundStyle(.white.opacity(0.6))
            .padding()
    }
}
