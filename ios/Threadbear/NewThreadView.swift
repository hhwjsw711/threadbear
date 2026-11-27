import SwiftUI
import ThreadbearKit

/// A new thread from the phone. It starts in the runner's default folder
/// (Mike didn't want a folder picker on the phone, 31 Oct); the runner, pool,
/// provider, model, effort and login can be picked via desktop-style chips
/// under the prompt box (Option A).
/// The runner starts on the first one online in Mike's order (Settings), so
/// the Mac asleep doesn't leave the phone nowhere to start one (6 Nov).
/// It closes as soon as the backend has the request (7 Nov, Mike: waiting on
/// the runner's answer left the spinner up for ages); a row in the inbox
/// stands in for the thread until the runner's made it (AppModel.starting).
struct NewThreadView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    /// With the create command's id, as the sheet closes.
    var onStarted: (String) -> Void
    @State private var text: String

    init(text: String = "", onStarted: @escaping (String) -> Void) {
        self.init(draft: NewThreadDraft(text: text, photos: []), onStarted: onStarted)
    }

    /// A failed start's sheet again, as it was.
    init(draft: NewThreadDraft, onStarted: @escaping (String) -> Void) {
        _text = State(initialValue: draft.text)
        _photos = State(initialValue: draft.photos)
        _runnerId = State(initialValue: draft.runnerId)
        _settings = State(initialValue: draft.settings)
        self.onStarted = onStarted
    }
    /// Nil until the runners are in, then the first online in Mike's order.
    @State private var runnerId: String?
    @State private var settings: NewThreadSettings
    @State private var modelPickerShown = false
    /// From the tap on Start until the command's queued. Without it Start
    /// looks dead (and can be tapped again, for a second thread) while the
    /// photos finish going up.
    @State private var starting: Task<Void, Never>?
    @State private var photos: [PickedPhoto]
    @State private var adding = 0
    @State private var cursor = TextCursor()
    @State private var dictation = Dictation()

    /// Each photo a chip in the words where it was put in, as on the Mac.
    private var words: PhotoWords { PhotoWords(text: $text, photos: $photos, adding: $adding, cursor: cursor) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    promptCard
                        // The words are taken as Start is tapped: anything typed or
                        // added while it goes would be lost (Mike, 7 Nov). The chips
                        // below stay live, as start() reads them once the photos are up.
                        .disabled(starting != nil)

                    if model.canChooseRunner || !models.isEmpty {
                        chipBar
                    }

                    if let offline = offlineText {
                        Label("\(offline). It'll start when it's back.", systemImage: "moon.zzz")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(.systemGroupedBackground).ignoresSafeArea())
            .navigationTitle("New thread")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear(perform: pickRunner)
            .onChange(of: model.runners) { pickRunner() }
            // The backend's API version can come after the sheet's up.
            .onChange(of: model.canChooseRunner) { pickRunner() }
            .onChange(of: runnerId) {
                // Switching runners resets pool/account/model if they don't exist on the new runner.
                let runner = chosenRunner
                if let poolId = settings.poolId, !(runner?.usagePools ?? []).contains(where: { $0.id == poolId }) {
                    settings.poolId = nil
                }
                if let accountId = settings.accountId,
                   !model.accounts.contains(where: { $0.id == accountId && ($0.runnerId == nil || $0.runnerId == runner?.runnerId) }) {
                    settings.accountId = nil
                }
                if let modelId = settings.model, !models.contains(where: { $0.id == modelId || $0.model == modelId }) {
                    settings.model = nil
                }
                if models.isEmpty { settings.effort = nil }
            }
            .sheet(isPresented: $modelPickerShown) {
                ModelPickerSheet(
                    context: pickerContext,
                    now: model.now,
                    initiallyExpandedLogin: model.expandsLoginAtLaunch,
                    onPickModel: { row, column, provider in
                        settings = pickerContext.draftForPickingModel(settings, row: row, column: column, provider: provider)
                    },
                    onPickEffort: { level in
                        settings = pickerContext.draftForEffort(settings, level: level)
                    },
                    onPickLogin: { accountId, column in
                        settings = pickerContext.draftForLogin(settings, accountId: accountId, column: column)
                    }
                )
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        starting?.cancel()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if starting != nil { ProgressView() } else {
                        // Not with a photo still on its way, which would be left behind.
                        // Nor with Whisper still to type out what was said.
                        Button("Start", action: start)
                            .fontWeight(.semibold)
                            .disabled((words.message.isEmpty && photos.isEmpty) || adding > 0
                                      || dictation.holdsWords)
                    }
                }
            }
            .onAppear { Dictation.prepare() }
            .onDisappear { dictation.close() }
            #if DEBUG
            .onChange(of: model.clipTyped) { if let typed = model.clipTyped { text = typed } }
            .onChange(of: model.clipStartTaps) { start() }
            #endif
            .task {
                if photos.isEmpty, let load = model.loadSamplePhoto { words.add([load], model: model) }
                if model.opensModelPickerAtLaunch, !models.isEmpty {
                    model.opensModelPickerAtLaunch = false
                    modelPickerShown = true
                }
            }
        }
    }

    private var promptCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            PastableTextField(text: $text, placeholder: "What should it do?", lines: 4...12,
                              onPasteImages: model.canSendPhotos ? { words.addPasted($0, model: model) } : nil,
                              photos: $photos, cursor: cursor, threadReference: { model.threadReference(pasted: $0) })
                .padding(.horizontal, 14)
                .padding(.top, 13)
                .padding(.bottom, 8)
                .frame(minHeight: 112, alignment: .topLeading)

            Rectangle()
                .fill(Color.primary.opacity(0.07))
                .frame(height: 0.5)

            HStack {
                if model.canSendPhotos {
                    PhotoMenu(words: words) {
                        Label("Add a photo", systemImage: "photo")
                            .font(.subheadline)
                    }
                }
                Spacer()
                DictateButton(text: $text, dictation: dictation) {
                    Label("Dictate", systemImage: "mic")
                        .font(.subheadline)
                }
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 14)
            .padding(.top, 8)
            .padding(.bottom, 12)

            DictationNotes(dictation: dictation)
                .padding(.horizontal, 14)
            if model.canSendPhotos, !photos.isEmpty || adding > 0 {
                PhotoStrip(words: words)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var chipBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if model.canChooseRunner {
                    runnerChip
                }
                if !models.isEmpty {
                    ModelChip(context: pickerContext) {
                        modelPickerShown = true
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollClipDisabled()
    }

    private var runnerChip: some View {
        Menu {
            if runnerId == nil {
                Button {
                    runnerId = nil
                } label: {
                    Label("Automatic", systemImage: "checkmark")
                }
            }
            ForEach(model.runners) { runner in
                let online = runner.isOnline(at: model.now)
                let label = online ? runner.name : "\(runner.name), offline"
                Button {
                    runnerId = runner.runnerId
                } label: {
                    if runnerId == runner.runnerId {
                        Label(label, systemImage: "checkmark")
                    } else {
                        Text(label)
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "laptopcomputer")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(chosenRunner?.name ?? "Automatic")
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .foregroundStyle(colorScheme == .dark ? Color.white.opacity(0.86) : .primary)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 34)
            .background(Color.primary.opacity(colorScheme == .dark ? 0.08 : 0.07), in: Capsule())
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Runner: \(chosenRunner?.name ?? "Automatic")")
    }

    private var models: [PhoneModelChoice] { model.newThreadModels(on: model.canChooseRunner ? runnerId : nil) }
    private var chosenRunner: PhoneRunner? { model.runners.first { $0.runnerId == runnerId } }
    private var pickerContext: ModelPickerContext {
        model.newThreadPickerContext(settings: settings, runnerId: model.canChooseRunner ? runnerId : nil)
    }

    /// With a runner picked, whether that one's asleep; otherwise whether they all are.
    private var offlineText: String? {
        guard model.canChooseRunner, let runner = chosenRunner else { return model.offlineText }
        guard !runner.isOnline(at: model.now) else { return nil }
        return "\(runner.name) offline since \(RelativeTime.clock(runner.lastSeenAt, now: model.now))"
    }

    /// The first runner online in Mike's order, once the runners are in.
    /// Kept once picked, unless it's gone from the list.
    private func pickRunner() {
        // Down to one runner (one revoked meanwhile, say): back to the
        // backend's choice, and to a model that one has.
        guard model.canChooseRunner else {
            runnerId = nil
            return
        }
        if let runnerId, model.runners.contains(where: { $0.runnerId == runnerId }) { return }
        // Gone from the list: picked afresh, or the backend's choice.
        runnerId = NewThreadChoices.runner(model.runners, now: model.now)?.runnerId
    }

    private func start() {
        guard let backend = model.backend else { return }
        dictation.stop()
        let message = words.message
        let typed = text
        let photos = photos
        starting = Task {
            defer { starting = nil }
            do {
                let images = try await model.upload(photos)
                // Cancelled while the photos were going up: no thread after all.
                try Task.checkCancellation()
                // Picked now if the sheet never got to (the runners or the
                // API version came in as Start was tapped).
                if model.canChooseRunner, runnerId == nil { pickRunner() }
                // Taken once: the chips can still change while the request goes.
                let wireSettings = model.canChangeThreadSettings
                    ? settings
                    : NewThreadSettings(model: settings.model, effort: settings.effort)
                let draft = NewThreadDraft(
                    text: typed,
                    photos: photos,
                    runnerId: model.canChooseRunner ? runnerId : nil,
                    poolId: wireSettings.poolId,
                    accountId: wireSettings.accountId,
                    provider: wireSettings.provider,
                    modelId: wireSettings.model,
                    effort: wireSettings.effort
                )
                let commandId = try await backend.create(text: message, runnerId: draft.runnerId, cwd: nil, images: images,
                                                         settings: wireSettings)
                model.sent(photos)
                model.started(commandId: commandId, message: message, draft: draft)
                onStarted(commandId)
                dismiss()
            } catch is CancellationError {
            } catch {
                model.report(error)
            }
        }
    }
}
