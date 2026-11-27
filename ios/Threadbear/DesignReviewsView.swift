import SwiftUI
import ThreadbearKit

struct DesignReviewTarget: Identifiable {
    var id: String // Empty opens the pending list.
}

/// The review stays separate from the transcript's folded working.
struct DesignReviewsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let threadId: String
    let reviewId: String
    @State private var entries: [DesignReviewResult.Entry] = []
    @State private var review: PhoneDesignReview?
    @State private var draft = DesignReviewDraft()
    @Binding var drafts: [String: DesignReviewDraft]
    @State private var pictures: [MessageImage] = []
    @State private var loading = true
    @State private var sending = false
    @State private var problem: String?
    @State private var truncated = false
    @State private var imageReload = 0
    @State private var started = false

    var body: some View {
        ZStack {
            if let review { board(review) } else { list }
        }
        // Once: going back to the list mustn't reopen the review it started on.
        .task {
            guard !started else { return }
            started = true
            await load(reviewId.isEmpty ? nil : reviewId)
        }
    }

    private func board(_ review: PhoneDesignReview) -> some View {
        // Worked out first: inline, this call took Xcode 26's type checker
        // past its time limit.
        let runnerMarks: Bool = review.canMark ?? false
        let canMark: Bool = model.hasReviewMarks && runnerMarks
        return ReviewBoard(review: review, draft: $draft, pictures: loadable, canMark: canMark,
                        sending: sending, loading: loading, problem: problem, demo: model.isFake,
                        close: { dismiss() },
                        allReviews: {
                            drafts[review.id] = draft
                            Task { await load(nil) }
                        },
                        reload: { Task { await load(review.id, preserveDraft: true) } },
                        send: { Task { await send(review) } })
                .onChange(of: draft) { _, value in
                    drafts[review.id] = value
                    // Gone once enough marks are removed.
                    if let problem, problem.hasPrefix(Self.overPrefix), Self.overNote(value) != problem { self.problem = Self.overNote(value) }
                }
                .task(id: "\(review.id):\(model.connection):\(imageReload)") { await followPictures() }
    }

    /// The pending reviews, and the wait for the runner before one opens.
    private var list: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if loading {
                        ProgressView("Waiting for the thread's runner…")
                            .frame(maxWidth: .infinity).padding()
                        Text("The runner must be online to read or answer a review.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let problem {
                        Text(problem).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently)
                        Button("Reload review") {
                            Task { await load(reviewId.isEmpty ? nil : reviewId, preserveDraft: true) }
                        }
                        .disabled(loading || sending)
                    }
                    if !loading {
                        if entries.isEmpty && problem == nil {
                            ContentUnavailableView("No pending reviews", systemImage: "checkmark.circle")
                        }
                        ForEach(entries) { entry in
                            Button {
                                Task { await load(entry.id) }
                            } label: {
                                HStack {
                                    Text(entry.title).multilineTextAlignment(.leading)
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                }.padding(.vertical, 8)
                            }
                            .accessibilityHint("Opens the design options")
                        }
                        if truncated { Text("Showing the first 100 reviews. Answer these to see the rest.").font(.footnote) }
                    }
                }
                .padding()
            }
            .navigationTitle("Reviews")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    /// The stills' and media's addresses the phone may load: the backend's
    /// own storage, or the sample data's files.
    private var loadable: [String: MessageImage] {
        var out: [String: MessageImage] = [:]
        for picture in pictures {
            guard let src = picture.src, let url = URL(string: picture.url),
                  ["https", "http"].contains(url.scheme?.lowercased() ?? "") || (model.isFake && url.isFileURL) else { continue }
            out[src] = picture
        }
        return out
    }

    private func load(_ id: String?, preserveDraft: Bool = false) async {
        guard let backend = model.backend else { loading = false; problem = "Reconnect to Threadbear to read reviews."; return }
        guard model.hasDesignReviews else {
            loading = false
            problem = "Update Threadbear's backend on the Mac to read reviews here."
            return
        }
        loading = true
        if !preserveDraft { problem = nil }
        defer { loading = false }
        do {
            let command = try await backend.designReviews(threadId: threadId, reviewId: id)
            let state = await model.commands.outcome(.review(threadId), commandId: command)
            guard !Task.isCancelled else { return }
            if let note = state.timedOutNote { throw TransportError.server(note) }
            guard case let .done(_, status) = state else {
                if state == .idle { return }
                throw TransportError.server(state.failure("Couldn't load the review. Try again.") ?? "Couldn't load the review. Try again.")
            }
            guard let result = status?.designReviews else { throw TransportError.server("Couldn't load the review. Try again.") }
            if let loaded = result.review {
                let kept = preserveDraft && review?.id == loaded.id
                review = loaded
                imageReload += 1
                // The Mac's marks as they are now, whichever draft is kept:
                // the Mac may have added some since.
                draft = DesignReviewDraft.reopening(loaded, kept: kept ? draft : drafts[loaded.id])
                if loaded.pending, let note = Self.overNote(draft) { problem = note }
            } else if let list = result.reviews {
                entries = list
                truncated = result.truncated == true
                review = nil
            } else { throw TransportError.server("Couldn't read the review. Try again.") }
        } catch { problem = error.localizedDescription }
    }

    private func followPictures() async {
        guard let review, let backend = model.backend else { return }
        pictures = []
        do {
            for try await images in backend.reviewImages(threadId: threadId, sources: review.sources) {
                if Task.isCancelled { return }
                pictures = images
            }
        } catch {
            if !Task.isCancelled { problem = "Couldn't load the review pictures. Your answer is still here. \(error.localizedDescription)" }
        }
    }

    private func send(_ review: PhoneDesignReview) async {
        guard !sending, draft.canSend(to: review), let backend = model.backend else { return }
        sending = true
        problem = nil
        defer { sending = false }
        do {
            var outgoing = draft
            // A backend before API 106, or a runner that would drop them, gets
            // none (the Mark button is hidden there too).
            if !model.hasReviewMarks || review.canMark != true { outgoing.marks = nil }
            // Fresh cut-outs every attempt, never kept in the draft: Convex
            // deletes a command's pictures when it fails or lapses, so a kept
            // id would fail every retry. Let go of this attempt's if it fails.
            var uploaded: [String] = []
            let command: String
            do {
                if let marks = outgoing.marks, !marks.isEmpty {
                    outgoing.marks = try await uploadCutOuts(marks, review: review, backend: backend, uploaded: &uploaded)
                }
                command = try await backend.respondReview(threadId: threadId, review: review, draft: outgoing)
            } catch {
                for id in uploaded { try? await backend.discardPhoto(id) }
                throw error
            }
            let state = await model.commands.outcome(.review(threadId), commandId: command)
            if let note = state.timedOutNote {
                // Still on its way: it lands when the Mac is back, so nothing's reloaded over it.
                problem = note
                return
            }
            switch state {
            case .done:
                drafts[review.id] = nil
                dismiss()
            case .idle: return
            case .sending, .queued, .taken, .timedOut, .failed:
                throw TransportError.server(state.failure("The answer wasn't accepted.") ?? "The answer wasn't accepted.")
            }
        } catch {
            problem = "\(error.localizedDescription) Your answer is kept. Reload before sending again."
            // Never retry a write automatically against a newer revision.
            await load(review.id, preserveDraft: true)
        }
    }

    /// Each mark's part of its still, cut out and uploaded, for the runner to
    /// show beside the mark's line. A still the phone can't read leaves the
    /// mark without one: its box still goes.
    private func uploadCutOuts(_ marks: [ReviewUserMark], review: PhoneDesignReview, backend: any Backend, uploaded: inout [String]) async throws -> [ReviewUserMark] {
        var marks = marks
        let stills = loadable
        for i in marks.indices {
            marks[i].storageId = nil
            guard let option = review.options.first(where: { $0.id == marks[i].optionId }),
                  option.shots.indices.contains(marks[i].shot),
                  let still = stills[option.shots[marks[i].shot].src], let url = URL(string: still.url),
                  let picture = try? await PictureLoader.shared.picture(url, maxPixels: ReplyPicture.maxPixels) else { continue }
            let image = picture.image, box = marks[i].box
            // Cropping and encoding off the main thread.
            guard let jpeg = await Task.detached(priority: .userInitiated, operation: { ReviewCutOut.jpeg(image, box: box) }).value else { continue }
            let id = try await backend.uploadPhoto(jpeg)
            uploaded.append(id)
            marks[i].storageId = id
        }
        return marks
    }

    private static let overPrefix = "The Mac added marks"

    /// Says how many of the phone's marks to remove when the Mac's leave too
    /// little room, rather than Send just staying off.
    private static func overNote(_ draft: DesignReviewDraft) -> String? {
        let over = draft.marksOver
        guard over > 0 else { return nil }
        return "\(overPrefix), so remove \(over) of yours to send."
    }
}
