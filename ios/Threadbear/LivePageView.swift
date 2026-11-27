import SwiftUI
import WebKit
import ThreadbearKit

// A live page (the livePages experiment, docs/live-pages-design): one HTML file
// an agent showed in its reply, which the runner put in file storage as plain
// bytes. A card with Run: Run fetches the bytes and runs the page there in the
// card, scripts on, sealed as rich blocks are (RichWebSandbox: no network, a
// fresh store that keeps nothing, no navigation, no windows), with blob:
// allowed for the workers and pictures a page makes for itself. One runs at a
// time; scrolled away or stopped, its view goes.

/// Which card's page is running, so Run on another stops it.
@MainActor @Observable final class LivePages {
    static let shared = LivePages()
    var running: String?
}

struct LivePageCard: View {
    var url: URL
    var title: String

    @State private var page: String?
    @State private var loading = false
    @State private var failed: String?
    @State private var fullScreen = false
    private var live = LivePages.shared

    init(url: URL, title: String) {
        self.url = url
        self.title = title
    }

    private var running: Bool { live.running == url.absoluteString && page != nil }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(title.isEmpty ? "Live page" : title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if running {
                    Button { fullScreen = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                        .accessibilityLabel("Full screen")
                    Button("Stop") { live.running = nil }
                        .buttonStyle(.bordered)
                } else {
                    Button { Task { await run() } } label: {
                        if loading { ProgressView().controlSize(.small) } else { Text("Run") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(loading)
                    .accessibilityHint("Runs this page here, with no internet and no files but its own")
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            Divider()
            if running, let page {
                LiveWebView(page: page)
                    .frame(height: 280)
            } else {
                Text(failed ?? "Runs sealed: no internet, and no files but its own.")
                    .font(.footnote)
                    .foregroundStyle(failed == nil ? Color.secondary : Color.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 80)
                    .padding(.horizontal, 12)
            }
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(.separator), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .onDisappear { if live.running == url.absoluteString { live.running = nil } }
        // The transcript keeps rows it has scrolled past, so out of sight is
        // this, not onDisappear: a page scrolled away stops (Codex's review).
        .onScrollVisibilityChange(threshold: 0.01) { visible in
            if !visible, live.running == url.absoluteString { live.running = nil }
        }
        .fullScreenCover(isPresented: $fullScreen) {
            NavigationStack {
                Group { if let page { LiveWebView(page: page) } }
                    .ignoresSafeArea(edges: .bottom)
                    .navigationTitle(title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { fullScreen = false } } }
            }
        }
    }

    private func run() async {
        if page == nil {
            loading = true
            defer { loading = false }
            do {
                page = try await LivePageLoader.fetch(url)
                failed = nil
            } catch {
                failed = "Couldn't load this page."
                return
            }
        }
        live.running = url.absoluteString
    }
}

enum LivePageLoader {
    /// The runner's limit (share-images.ts SHARE_IMAGE_BYTES).
    static let maxBytes = 10 * 1024 * 1024

    static func fetch(_ url: URL) async throws -> String {
        let data = try await CappedDownload.data(from: url, session: .shared, limit: maxBytes)
        guard let text = String(data: data, encoding: .utf8) else { throw URLError(.cannotDecodeContentData) }
        return text
    }
}

/// The running page. Its own scripts on, and nothing else of the phone's:
/// RichWebSandbox's store, proxy and link guard, a rule list that lets only
/// about:, data: and blob: load, and a policy ahead of the page's markup
/// that a page can only narrow.
struct LiveWebView: UIViewRepresentable {
    let page: String
    var scrolling = false

    static let policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; worker-src blob:; connect-src data: blob:; frame-src 'none'; form-action 'none'; base-uri 'none'"

    static func wrapped(_ page: String) -> String {
        "<!doctype html>\n<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no\">\n" + page
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Before the page's own scripts, in its world: no clipboard, file
    /// picker, share sheet or printing, put beyond the page's reach
    /// (non-configurable), so a page can't fill the clipboard, ask to paste,
    /// read a file Mike picks or put up a sheet that looks like the app's.
    static let guardScript = """
    (() => {
      const lock = (o, k, v) => { try { Object.defineProperty(o, k, { value: v, writable: false, configurable: false }); } catch (e) {} };
      const no = () => Promise.reject(new DOMException('Not allowed here', 'NotAllowedError'));
      if (navigator.clipboard) { lock(navigator.clipboard, 'readText', no); lock(navigator.clipboard, 'read', no); lock(navigator.clipboard, 'writeText', no); lock(navigator.clipboard, 'write', no); }
      lock(Navigator.prototype, 'share', no);
      lock(Navigator.prototype, 'canShare', () => false);
      lock(window, 'print', () => {});
      const exec = Document.prototype.execCommand;
      lock(Document.prototype, 'execCommand', function (c, ...rest) { return /^(copy|cut|paste)$/i.test(String(c)) ? false : exec.call(this, c, ...rest); });
      lock(HTMLInputElement.prototype, 'showPicker', () => {});
      const block = (e) => { const t = e.target; if (t && t.closest && t.closest('input[type=file i]')) { e.preventDefault(); e.stopImmediatePropagation(); } };
      for (const type of ['click', 'copy', 'cut', 'paste']) addEventListener(type, type === 'click' ? block : (e) => e.preventDefault(), true);
    })();
    """

    /// WebRTC goes round the proxy and the rule list, and only WebKit's
    /// private switch turns it off: without that switch a page doesn't run.
    static var canSeal: Bool {
        WKPreferences().responds(to: NSSelectorFromString("_setPeerConnectionEnabled:"))
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = RichWebSandbox.configuration(scripts: true, pele: false)
        config.userContentController.addUserScript(WKUserScript(source: Self.guardScript, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
        // The link guard again in the app's own world, where the page's
        // scripts can't take it apart (its copy in the page's world can be).
        config.userContentController.addUserScript(WKUserScript(source: RichWebSandbox.linkGuard, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .defaultClient))
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = scrolling
        view.backgroundColor = scrolling ? .white : .clear
        view.scrollView.backgroundColor = scrolling ? .white : .clear
        view.scrollView.isScrollEnabled = scrolling
        view.scrollView.bounces = false
        // No long-press preview or menu on a link: its Open Link would take
        // the page's address, and anything in it, out to Safari (Gemini).
        view.allowsLinkPreview = false
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        let coordinator = context.coordinator
        RichWebSandbox.withLiveRules { rules in
            // Stopped while the rules were being made: nothing loads.
            guard !coordinator.dismantled else { return }
            guard let rules, Self.canSeal else {
                coordinator.loading = true
                view.loadHTMLString("<p style=\"font:14px -apple-system;color:gray\">This couldn't be run safely.</p>", baseURL: nil)
                return
            }
            view.configuration.userContentController.add(rules)
            coordinator.loading = true
            view.loadHTMLString(Self.wrapped(page), baseURL: nil)
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.dismantled = true
        view.stopLoading()
        view.loadHTMLString("", baseURL: nil)
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        /// The one navigation allowed: the page loadHTMLString starts.
        var loading = false
        /// Its view has gone (Stop, scrolled away): nothing more loads in it.
        var dismantled = false

        /// No context menu on a link or picture (Open Link, Share, Copy Link).
        func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
                     completionHandler: @escaping @MainActor (UIContextMenuConfiguration?) -> Void) {
            completionHandler(nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            let isPage = loading && action.targetFrame?.isMainFrame == true && action.request.url?.absoluteString == "about:blank"
                && !action.shouldPerformDownload
            if isPage { loading = false }
            decisionHandler(isPage ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
            decisionHandler(response.canShowMIMEType && response.isForMainFrame ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

        // No alert, confirm or prompt: a page can't put up a box that looks
        // like the phone's own.
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) { completionHandler() }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) { completionHandler(false) }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) { completionHandler(nil) }
    }
}


/// Review HTML runs only in the existing sealed live-pages view. The cover
/// owns its bytes and WebView; dismissing it destroys both.
struct ReviewLivePage: View {
    let url: URL
    let title: String
    @Environment(\.dismiss) private var dismiss
    private enum Content { case loading, ready(String), failed }
    @State private var content = Content.loading

    var body: some View {
        NavigationStack {
            Group {
                switch content {
                case let .ready(page): LiveWebView(page: page, scrolling: true)
                case .failed: ContentUnavailableView("Couldn't load this page", systemImage: "exclamationmark.triangle")
                case .loading: ProgressView("Loading page")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Stop") { dismiss() } } }
        }
        .preferredColorScheme(.dark)
        .task(id: url) {
            content = .loading
            LivePages.shared.running = nil
            do {
                let loaded = try await LivePageLoader.fetch(url)
                try Task.checkCancellation()
                content = .ready(loaded)
            } catch { if !Task.isCancelled { content = .failed } }
        }
    }
}
