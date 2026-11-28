package com.mikerosoft.threadbear.android

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import com.mikerosoft.threadbear.kit.BackendApi
import com.mikerosoft.threadbear.kit.CommandKey
import com.mikerosoft.threadbear.kit.PendingCommand
import com.mikerosoft.threadbear.kit.PendingCommands
import com.mikerosoft.threadbear.kit.InboxSections
import com.mikerosoft.threadbear.kit.ModelPickerContext
import com.mikerosoft.threadbear.kit.NewThreadSettings
import com.mikerosoft.threadbear.kit.WaitGuess
import com.mikerosoft.threadbear.kit.Pairing
import com.mikerosoft.threadbear.kit.PairingRequest
import com.mikerosoft.threadbear.kit.PairingSource
import com.mikerosoft.threadbear.kit.PhoneAccount
import com.mikerosoft.threadbear.kit.PhoneBackend
import com.mikerosoft.threadbear.kit.PhoneCounts
import com.mikerosoft.threadbear.kit.PhoneIdentity
import com.mikerosoft.threadbear.kit.PhoneProject
import com.mikerosoft.threadbear.kit.PhoneRunner
import com.mikerosoft.threadbear.kit.PhoneSection
import com.mikerosoft.threadbear.kit.PhoneThread
import com.mikerosoft.threadbear.kit.ScheduleWake
import com.mikerosoft.threadbear.kit.SectionFolds
import com.mikerosoft.threadbear.kit.ShareAsk
import com.mikerosoft.threadbear.kit.ShareLinks
import com.mikerosoft.threadbear.kit.ShareSheet
import com.mikerosoft.threadbear.kit.ThreadChange
import com.mikerosoft.threadbear.kit.ThreadSettingsChange
import com.mikerosoft.threadbear.kit.ThreadsView
import com.mikerosoft.threadbear.kit.TransportError
import com.mikerosoft.threadbear.kit.WaitingSends
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock

/**
 * The app's state, for as long as the process lives (the iPhone's
 * AppModel): the pairing, the backend over it, the live lists every screen
 * reads, and what's on its way (archives, stops) so taps show at once.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AppModel(context: Context, private val scope: CoroutineScope) {
    private val appContext = context.applicationContext
    private val store = PairingStore(context)
    private val prefs = context.getSharedPreferences("app", Context.MODE_PRIVATE)
    private var transport: ConvexFfiTransport? = null

    private val _backend = MutableStateFlow<PhoneBackend?>(null)
    val backend: StateFlow<PhoneBackend?> = _backend
    private val _pairing = MutableStateFlow<Pairing?>(null)
    val pairing: StateFlow<Pairing?> = _pairing
    private val _identity = MutableStateFlow<PhoneIdentity?>(null)
    val identity: StateFlow<PhoneIdentity?> = _identity
    // Compose state as well as the flow, so a menu or button gated on
    // apiVersion redraws when phone:me answers late (an offline launch):
    // reading it while drawing is enough to be told.
    private var knownApi by mutableIntStateOf(0)
    // Above init, which may connect: an initializer after it would set this
    // back to null once askIdentity had started.
    private var identityJob: Job? = null

    /** The API version as a flow, 0 until phone:me has answered (backendAnd). */
    val apiVersions: StateFlow<Int> = _identity.map { it?.apiVersion ?: 0 }.stateIn(scope, SharingStarted.Eagerly, 0)

    /**
     * The backend with what `gate` makes of the API version, again whenever
     * either changes: a subscription that picks its query by version picks
     * again once phone:me answers late, rather than retrying the one it
     * chose at 0 for good (Codex's review, 16 Nov). Only a change in what
     * `gate` says starts it over, not the version arriving as such.
     */
    fun <K> backendAnd(gate: (Int) -> K): Flow<Pair<PhoneBackend?, K>> =
        combine(_backend, apiVersions.map(gate).distinctUntilChanged()) { b, k -> b to k }

    private fun setIdentity(me: PhoneIdentity?) {
        _identity.value = me
        knownApi = me?.apiVersion ?: 0
    }

    /**
     * The website's address, for a shared thread's link: what phone:me says,
     * else a cloud deployment's .convex.site twin (ShareLinks.site).
     */
    val site: StateFlow<String?> = combine(_pairing, _identity) { p, me -> ShareLinks.site(p?.deploymentUrl, me?.site) }
        .stateIn(scope, SharingStarted.Eagerly, null)

    /** A pairing link waiting for a yes. */
    val pendingPair = MutableStateFlow<PairingRequest?>(null)
    /** Checking a pairing with phone:me. */
    val pairingBusy = MutableStateFlow(false)

    private val _notes = MutableSharedFlow<String>(extraBufferCapacity = 8)
    /** Short lines for the snackbar: what failed, or what to know. */
    val notes: SharedFlow<String> = _notes

    val folds = MutableStateFlow(SectionFolds.fromSaved(prefs.getStringSet("folds", null)?.toList()))

    /**
     * Every command sent from here and waited on (archive, hibernate, rename,
     * star, wake, mark read, bring back, Stop, reply buttons, card answers), by
     * what it's about: the one place a control reads whether it's on its way,
     * done, refused or timed out (the kit's PendingCommand). Its rows follow
     * whichever backend is current.
     */
    val commands = PendingCommands<CommandKey>(scope, rows = { id -> _backend.flatMapLatest { it?.command(id) ?: emptyFlow() } })

    /** The inbox's and the shell's own state (ShellModel.kt): Pocket, Settings, row moves. */
    val shell: ShellModel by lazy { ShellModel(this, context, scope) }

    init {
        store.load()?.let { connect(it) }
    }

    /** The backend's API version, 0 until phone:me has answered. */
    val apiVersion: Int get() = knownApi

    private fun connect(pairing: Pairing) {
        transport?.close()
        val t = ConvexFfiTransport(pairing.deploymentUrl)
        transport = t
        _pairing.value = pairing
        val b = PhoneBackend(t, pairing.token)
        _backend.value = b
        askIdentity(b)
    }

    /**
     * phone:me, on connecting and again on every reconnect, as the iPhone's
     * AppModel asks on each fresh connection. It used to be asked once per
     * process, so an offline launch (or one a push started) or a call that
     * failed during a deploy left the API version at 0 until Android killed
     * the app, hiding Stars, photos, slash commands and older search. One
     * that fails tries again, backing off, while `b` is still the backend.
     */
    private fun askIdentity(b: PhoneBackend) {
        identityJob?.cancel()
        identityJob = scope.launch {
            var wait = 2_000L
            while (_backend.value === b) {
                try {
                    val me = b.me()
                    if (_backend.value !== b) return@launch
                    setIdentity(me)
                    registerPush()
                    sendNotifyMode(b)
                    return@launch
                } catch (e: CancellationException) {
                    throw e
                } catch (e: TransportError.Unauthorized) {
                    report(e)
                    return@launch
                } catch (_: Exception) {
                    delay(wait)
                    wait = (wait * 2).coerceAtMost(60_000L)
                }
            }
        }
    }

    /** Every list follows the backend, and starts again after a dropped connection. */
    private fun <T> follow(initial: T, read: (PhoneBackend) -> Flow<T>): StateFlow<T> = follow(initial, { }) { b, _ -> read(b) }

    /** One whose query depends on the API version: `gate` says which (backendAnd). */
    private fun <T, K> follow(initial: T, gate: (Int) -> K, read: (PhoneBackend, K) -> Flow<T>): StateFlow<T> =
        backendAnd(gate).flatMapLatest { (b, k) ->
            if (b == null) flowOf(initial) else read(b, k).retryWhen { cause, _ ->
                if (cause is TransportError.Unauthorized) { report(cause); false } else { delay(2000); true }
            }.catch { }
        }.stateIn(scope, SharingStarted.WhileSubscribed(5000), initial)

    val inbox: StateFlow<List<PhoneThread>?> = follow(null, { it in 1 until BackendApi.THREAD_CHANGES }) { b, older ->
        if (older) b.threads(ThreadsView.INBOX) else b.inboxChanges()
    }
    val runners: StateFlow<List<PhoneRunner>> = follow(emptyList()) { it.runners() }
    val projects: StateFlow<List<PhoneProject>> = follow(emptyList()) { it.projects() }
    val counts: StateFlow<PhoneCounts?> = follow(null) { it.counts() }
    val wakes: StateFlow<List<ScheduleWake>> = follow(emptyList()) { it.wakes() }
    /** Every runner's logins and their models (backend API 20), for the new thread pickers. */
    val accounts: StateFlow<List<PhoneAccount>> = follow(emptyList(), { it in 1 until BackendApi.MODELS }) { b, older ->
        if (older) flowOf(emptyList()) else b.accounts()
    }
    val connected: StateFlow<Boolean> = _backend.flatMapLatest { it?.connected ?: flowOf(false) }
        .stateIn(scope, SharingStarted.Eagerly, false)

    init {
        // Back online, or the socket came back: ask phone:me again (askIdentity).
        scope.launch {
            var was = false
            connected.collect { up ->
                if (up && !was) {
                    _backend.value?.let { askIdentity(it) }
                    // Nothing could be heard while it was down: each command's clock starts again.
                    commands.reconnected()
                }
                was = up
            }
        }
    }

    /** A put-away list, only while its heading is open. */
    fun putAway(section: PhoneSection): StateFlow<List<PhoneThread>?> = sectionLists.getOrPut(section) {
        val view = section.view ?: return@getOrPut MutableStateFlow(emptyList())
        folds.flatMapLatest { f ->
            if (f.isFolded(section)) flowOf(null) else _backend.flatMapLatest { b ->
                b?.threads(view)?.retryWhen { _, _ -> delay(2000); true }?.catch { } ?: emptyFlow()
            }
        }.stateIn(scope, SharingStarted.WhileSubscribed(5000), null)
    }
    private val sectionLists = HashMap<PhoneSection, StateFlow<List<PhoneThread>?>>()

    fun toggle(section: PhoneSection) {
        folds.update { it.toggle(section) }
        prefs.edit().putStringSet("folds", folds.value.saved.toSet()).apply()
    }

    /** The key the Mac's pairing code gave for a runner: the only one a secret is sealed to. */
    fun runnerKey(runnerId: String): String? = _pairing.value?.let { store.runnerKey(it.serverName, runnerId) }

    fun project(id: String): PhoneProject? = projects.value.firstOrNull { it.id == id }

    fun offlineRunner(thread: PhoneThread): String? = WaitingSends.offlineRunner(thread.runnerId, runners.value, Instant.now())

    // Pairing

    /**
     * A pairing code from the app's scanner or the clipboard: asked about
     * first. One another app opened is never taken (Daybreak 127): it says
     * so and is false, as is anything that isn't a pairing.
     */
    fun ask(link: String, source: PairingSource): Boolean {
        if (source.refuses(link, BuildConfig.ALLOW_LOCAL)) {
            note("Threadbear doesn't pair from links other apps open. Scan the code on your Mac from Threadbear's own pairing screen instead.")
            return true
        }
        if (PairingSource.isOldLink(link, BuildConfig.ALLOW_LOCAL)) {
            note("That code is from an older Threadbear on your Mac, which puts the phone's token in it. Update Threadbear on your Mac, then show the code again.")
            return true
        }
        val server = Pairing.parse(link, BuildConfig.ALLOW_LOCAL)?.serverName ?: return false
        val request = PairingRequest.of(link, source, BuildConfig.ALLOW_LOCAL, _pairing.value) { store.runnerKey(server, it) } ?: return false
        if (pendingPair.value == null) pendingPair.value = request
        return true
    }

    fun cancelPair() { pendingPair.value = null }

    /**
     * Debug builds only, as the iPhone's `-ThreadbearPair`: the parity run
     * (scripts/parity/android-shots.sh) pairs an emulator with its throwaway
     * backend on this Mac's loopback, where nothing can scan a code. Only a
     * local http backend, and never in a release build (ALLOW_LOCAL).
     */
    fun pairForParity(url: String, token: String) {
        if (!BuildConfig.ALLOW_LOCAL || token.isEmpty()) return
        val local = Regex("^http://(127\\.0\\.0\\.1|localhost|10\\.0\\.2\\.2)(:\\d+)?$")
        if (!local.matches(url) || _pairing.value?.let { it.deploymentUrl == url && it.token == token } == true) return
        val pairing = Pairing(url, token)
        pairingChanged(forget = _pairing.value != null)
        commands.clear()
        store.save(pairing)
        connect(pairing)
    }

    /** Yes to the request on screen: checked with phone:me before anything is kept. */
    fun acceptPair(shown: PairingRequest) {
        if (pendingPair.value !== shown) return
        pendingPair.value = null
        pairingBusy.value = true
        scope.launch {
            val trial = ConvexFfiTransport(shown.pairing.deploymentUrl)
            try {
                // The Mac's one-use code, traded for the token (tokens:claim).
                val pairing = shown.pairing.claimed(trial)
                val me = PhoneBackend(trial, pairing.token).me()
                // Another server: the old one stops reaching this phone. The
                // same server with a new token keeps the registration, which
                // registerPush moves to the new token.
                val old = _pairing.value
                pairingChanged(forget = old != null && old.deploymentUrl != pairing.deploymentUrl)
                // Nothing on its way to the old pairing is watched on the new one.
                commands.clear()
                store.save(pairing)
                trial.close()
                connect(pairing)
                setIdentity(me)
                note("Paired with ${shown.host}")
                registerPush()
            } catch (e: CancellationException) {
                trial.close()
                throw e
            } catch (e: Exception) {
                trial.close()
                report(e)
            } finally {
                pairingBusy.value = false
            }
        }
    }

    // Push

    /** The push address (Firebase token or UnifiedPush endpoint) the backend has for this phone, once registered (for Notify me). */
    private val _pushToken = MutableStateFlow<String?>(null)
    val pushToken: StateFlow<String?> = _pushToken

    /**
     * Hands the backend this phone's push address and push key, as the
     * iPhone's didRegister: on each connect, after pairing, when the
     * permission's given, and when the transport has a new address
     * ([fresh]: a new Firebase token, a new UnifiedPush endpoint). Not while
     * notifications aren't allowed (nothing would show), nor for a backend
     * that sends none (self-hosted), nor a Web Push address for a backend
     * before API 93. Quiet on failure: the next launch tries again.
     */
    fun registerPush(fresh: PushAddress? = null) {
        val b = _backend.value ?: return
        if (!Push.available(appContext) || !Push.permitted(appContext)) return
        // Already registered this run: the resume check costs nothing then.
        if (fresh == null && _pushToken.value != null) return
        if (!Push.sentBy(_identity.value)) return
        val api = apiVersion
        if (fresh?.platform == PushAddress.WEB_PUSH && api < BackendApi.WEB_PUSH) return
        val cacheKey = _pairing.value?.deploymentUrl ?: return
        val epoch = pairingEpoch
        scope.launch {
            // One at a time with forgetting an old pairing's address (pairingChanged),
            // so a quick re-pair can't register the address being forgotten, and work
            // for a pairing that's since changed is dropped, not finished.
            pushLock.withLock {
                if (epoch != pairingEpoch) return@withLock
                val address = fresh ?: Push.transport.address(appContext, b, api, cacheKey) ?: return@withLock
                val key = PushKeyStore(appContext).loadOrCreate()?.let { android.util.Base64.encodeToString(it, android.util.Base64.NO_WRAP) }
                try {
                    b.registerDevice(address.token, "production", address.platform, key, address.webPush)
                    if (epoch == pairingEpoch) {
                        _pushToken.value = address.token
                        // Settings' Notify me picker shows once there's a token.
                        shell.pushToken.value = address.token
                        // As the iPhone: the phone's own choice goes with each
                        // registration (a backend before the setting notifies every time).
                        if (apiVersion >= BackendApi.NOTIFICATION_SETTING) {
                            runCatching { b.setNotifications(address.token, shell.notifyMode.value) }
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
            }
        }
    }

    /** The distributor dropped this phone's endpoint: registered afresh on the next resume. */
    fun pushUnregistered() {
        scope.launch {
            pushLock.withLock {
                _pushToken.value = null
                shell.pushToken.value = null
            }
        }
    }

    private val pushLock = kotlinx.coroutines.sync.Mutex() // fair: queued work runs in order

    /**
     * The phone's Notify me choice, once phone:me has answered: a
     * registration made before it had (an offline launch, a new Firebase
     * token) couldn't tell whether the backend takes it, so it went without
     * (Codex's review, 16 Nov). Sent again on each reconnect; it's one row.
     */
    private fun sendNotifyMode(b: PhoneBackend) {
        if (apiVersion < BackendApi.NOTIFICATION_SETTING) return
        val epoch = pairingEpoch
        scope.launch {
            pushLock.withLock {
                val token = _pushToken.value ?: return@withLock
                if (epoch != pairingEpoch || _backend.value !== b) return@withLock
                runCatching { b.setNotifications(token, shell.notifyMode.value) }
            }
        }
    }
    @Volatile private var pairingEpoch = 0

    /**
     * The thread open on screen with the app in front, or left ([open]
     * false): no push for it comes to this phone meanwhile (phone:setViewing).
     * In order with registering, quiet on failure: at worst a push comes.
     */
    fun viewing(threadId: String, open: Boolean) {
        val b = _backend.value ?: return
        val epoch = pairingEpoch
        scope.launch {
            pushLock.withLock {
                val token = _pushToken.value ?: return@withLock
                if (epoch != pairingEpoch || _backend.value !== b) return@withLock
                runCatching { b.setViewing(token, threadId, open) }
            }
        }
    }

    /**
     * The pairing changed (unpaired, or paired with something else): what's
     * queued for the old one is dropped, and with [forget] the old backend
     * loses this phone (Push.forget: the transport forgets its address) and
     * the push key is made anew, so the old backend's sealed notifications
     * can't be opened.
     */
    private fun pairingChanged(forget: Boolean) {
        // Another server (or none): its notifications come down and any being
        // opened are dropped, before anything else of the new pairing's.
        Push.pairingChanged(appContext, forget = forget)
        pairingEpoch++
        _pushToken.value = null
        shell.pushToken.value = null
        if (forget) scope.launch { pushLock.withLock { Push.forget(appContext) } }
    }

    fun unpair() {
        store.clear()
        pairingChanged(forget = true)
        commands.clear()
        pendingSettings.clear()
        shell.clear()
        transport?.close()
        transport = null
        _backend.value = null
        _pairing.value = null
        identityJob?.cancel()
        setIdentity(null)
    }

    // Model, effort, pool & login settings

    /** Whether this backend accepts live thread settings changes and pool/account picks (API 107). */
    val canChangeThreadSettings: Boolean get() = apiVersion >= BackendApi.MOBILE_PICKER

    /** Optimistic settings changes in flight, keyed by threadId, paired with CommandKey.Settings(threadId). */
    private val pendingSettings = HashMap<String, ThreadSettingsChange>()

    fun runner(runnerId: String?, list: List<PhoneRunner> = runners.value): PhoneRunner? {
        if (!runnerId.isNullOrEmpty()) return list.firstOrNull { it.runnerId == runnerId }
        return list.firstOrNull { it.main == true } ?: list.firstOrNull()
    }

    /** Accounts scoped to a runner (falling back to all accounts if unscoped on older backends). */
    private fun accountsForRunner(runnerId: String?, all: List<PhoneAccount> = accounts.value): List<PhoneAccount> {
        if (runnerId.isNullOrEmpty()) return all
        val scoped = all.filter { it.runnerId == runnerId }
        return scoped.ifEmpty { all }
    }

    fun modelPickerContext(
        thread: PhoneThread,
        runnerList: List<PhoneRunner> = runners.value,
        accountList: List<PhoneAccount> = accounts.value,
    ): ModelPickerContext {
        val r = runner(thread.runnerId, runnerList)
        val scoped = accountsForRunner(thread.runnerId, accountList)
        return ModelPickerContext(
            pools = r?.usagePools.orEmpty(),
            accounts = scoped,
            defaults = r?.defaults,
            accountId = thread.accountId,
            provider = thread.provider,
            poolId = thread.poolId,
            model = thread.model,
            modelInUse = thread.modelInUse,
            effort = thread.effort,
            effortInUse = thread.effortInUse,
            isNew = false,
        )
    }

    fun newThreadPickerContext(
        settings: NewThreadSettings,
        runnerId: String?,
        runnerList: List<PhoneRunner> = runners.value,
        accountList: List<PhoneAccount> = accounts.value,
    ): ModelPickerContext {
        val r = runner(runnerId, runnerList)
        val scoped = accountsForRunner(r?.runnerId ?: runnerId, accountList)
        val defaults = r?.defaults
        val effectiveAccountId = settings.accountId ?: defaults?.accountId.orEmpty()
        val effectivePoolId = if (settings.accountId != null) null else (settings.poolId ?: defaults?.poolId)
        val effectiveProvider = settings.provider
            ?: scoped.firstOrNull { it.id == effectiveAccountId }?.provider
            ?: scoped.firstOrNull()?.provider
            ?: "claude"
        return ModelPickerContext(
            pools = r?.usagePools.orEmpty(),
            accounts = scoped,
            defaults = defaults,
            accountId = effectiveAccountId,
            provider = effectiveProvider,
            poolId = effectivePoolId,
            model = settings.model,
            modelInUse = null,
            effort = settings.effort,
            effortInUse = null,
            isNew = true,
        )
    }

    fun changingSettings(threadId: String, pending: Map<CommandKey, PendingCommands.Entry>): Boolean =
        pending[CommandKey.Settings(threadId)]?.state?.locked == true

    fun updateSettings(threadId: String, change: ThreadSettingsChange) {
        val b = _backend.value ?: return
        if (change.isEmpty || !canChangeThreadSettings) return
        val key = CommandKey.Settings(threadId)
        commands.forget(key)
        pendingSettings[threadId] = change
        commands.start(key, send = { b.update(threadId, ThreadChange.Settings(change)) }) { state ->
            if (!state.holdsChange && pendingSettings[threadId] == change) {
                pendingSettings.remove(threadId)
            }
            said(state, "The runner couldn't update that thread's model.")
        }
    }

    // Changes, each showing at once

    /**
     * A star, wake, mark read or bring back, from a row, its menu or the
     * thread's: shown at once ([shown]), put back with why if the runner
     * refuses it, and said if the Mac hasn't picked it up in a while.
     */
    fun change(threadId: String, change: ThreadChange) {
        val (key, value, verb) = when (change) {
            // Archive and hibernate take the row off the inbox (ShellModel).
            ThreadChange.Archive, is ThreadChange.ArchiveWithVerdict -> return shell.archive(threadId, change)
            is ThreadChange.Snooze, ThreadChange.SnoozeUntilRestart -> return shell.hibernate(threadId, change)
            is ThreadChange.Rename -> return rename(threadId, change.title)
            is ThreadChange.Settings -> return updateSettings(threadId, change.settings)
            is ThreadChange.Star -> Triple(CommandKey.Star(threadId), if (change.on) "on" else "off", if (change.on) "star" else "unstar")
            ThreadChange.Wake -> Triple(CommandKey.Wake(threadId), null, "wake")
            ThreadChange.MarkSeen -> Triple(CommandKey.MarkSeen(threadId), null, "mark as read")
            ThreadChange.Unarchive -> Triple(CommandKey.Unarchive(threadId), null, "bring back")
        }
        val b = _backend.value ?: return
        // Brought back: an archive of it from here that's done but not yet let go mustn't hide it.
        if (key is CommandKey.Unarchive) commands.forget(CommandKey.Archive(threadId))
        // Starring again while one's on its way: the newest tap wins.
        if (key is CommandKey.Star && commands[key].holdsChange) commands.forget(key)
        commands.start(key, value, send = { b.update(threadId, change) }) { said(it, "The runner couldn't $verb that thread.") }
    }

    /**
     * A thread as this phone shows it: with the changes tapped here that the
     * runner hasn't made yet (a star, read, woken, back from the archive, a
     * new title, or model/effort/pool/login), at once and until it's done or refused.
     * [pending] is [commands]' entries as the screen collected them, so it redraws.
     */
    fun shown(thread: PhoneThread, pending: Map<CommandKey, PendingCommands.Entry>): PhoneThread {
        val id = thread.threadId
        fun held(key: CommandKey) = pending[key]?.takeIf { it.state.holdsChange }
        var t = thread
        held(CommandKey.Star(id))?.let { t = t.copy(starredAt = if (it.value == "on") t.starredAt ?: Instant.now() else null) }
        if (held(CommandKey.MarkSeen(id)) != null) t = WaitGuess.seen(t)
        if (held(CommandKey.Wake(id)) != null) t = WaitGuess.woken(t.copy(snoozedUntil = null, snoozedUntilRestart = null))
        if (held(CommandKey.Unarchive(id)) != null) t = WaitGuess.unarchived(t.copy(archivedAt = null))
        held(CommandKey.Rename(id))?.value?.let { t = t.copy(title = it) }
        if (held(CommandKey.Settings(id)) != null) {
            pendingSettings[id]?.let { change ->
                t = modelPickerContext(t).applyingOptimistic(change, t)
            }
        }
        return t
    }

    /** A thread's title as shown here: one just typed on this phone, else its own. */
    fun title(thread: PhoneThread, pending: Map<CommandKey, PendingCommands.Entry>) =
        shown(thread, pending).title.ifEmpty { "Untitled" }

    /** Woken or brought back from here and not refused: gone from its put-away list at once. */
    fun bringingBack(pending: Map<CommandKey, PendingCommands.Entry>): Set<String> = pending.mapNotNullTo(HashSet()) { (key, entry) ->
        when (key) {
            is CommandKey.Wake -> key.threadId
            is CommandKey.Unarchive -> key.threadId
            else -> null
        }?.takeIf { entry.state.holdsChange }
    }

    /**
     * Where a command ended, said where he's looking: a refusal always, and a
     * time-out only while a runner looks online (asleep, the inbox says so already).
     */
    fun said(state: PendingCommand, fallback: String) {
        val failure = state.failure(fallback)
        when {
            failure != null -> note(failure)
            // The phone not reaching the server is always news; the Mac not picking it up only while a runner looks online.
            state is PendingCommand.TimedOut && (state.id == null || runners.value.any { it.isOnline(Instant.now()) }) -> state.timedOutNote?.let(::note)
        }
    }

    /** Renames a thread, the new title at once; a second rename replaces one still on its way. */
    private fun rename(threadId: String, title: String) {
        val b = _backend.value ?: return
        val words = title.trim()
        if (words.isEmpty()) return
        commands.forget(CommandKey.Rename(threadId))
        commands.start(CommandKey.Rename(threadId), words, send = { b.update(threadId, ThreadChange.Rename(words)) }) {
            said(it, "The runner couldn't rename that thread.")
        }
    }

    /**
     * Shares a thread by link, stops sharing it, or gives it a new link: the
     * share sheet shows it at once (ShareSheet.view) and takes no more taps
     * until the runner's done it or refused.
     */
    fun share(threadId: String, ask: ShareAsk) {
        val b = _backend.value ?: return
        commands.start(CommandKey.Share(threadId), ask.value, send = { b.share(threadId, ask) }) { said(it, ShareSheet.REFUSED) }
    }

    /** Stop is on its way: a spinner taking no more taps until the turn ends, it's refused, or the Mac hasn't picked it up. */
    fun stopping(threadId: String, pending: Map<CommandKey, PendingCommands.Entry>) =
        pending[CommandKey.Stop(threadId)]?.state?.locked == true

    fun stop(threadId: String) {
        val b = _backend.value ?: return
        // Ten seconds after it's done at most, in case the thread's screen has gone.
        commands.start(CommandKey.Stop(threadId), settleMs = 10_000, send = { b.interrupt(threadId) }) { said(it, "That Mac couldn't stop it.") }
    }

    /** The thread's turn is over: its Stop is done. */
    fun stopped(threadId: String) {
        // However far Stop got (the turn may end before its command says done): a refusal stays, to be said.
        if (commands[CommandKey.Stop(threadId)] !is PendingCommand.Failed) commands.forget(CommandKey.Stop(threadId))
    }

    fun needsYouCount(threads: List<PhoneThread>) =
        InboxSections.build(threads, Instant.now(), InboxSections.wakes(wakes.value)).needsYouCount

    fun note(text: String) { _notes.tryEmit(text) }

    fun report(e: Throwable) {
        val text = when (e) {
            is TransportError -> e.message ?: "Something went wrong"
            else -> e.message ?: "Something went wrong"
        }
        note(text)
    }
}

