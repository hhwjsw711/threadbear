package com.mikerosoft.threadbear.android

import com.mikerosoft.threadbear.kit.NewThreadSettings

/** What the new thread screen had in it when Start was tapped, for trying again if it fails (ShellModel.retryStarting). */
class NewThreadDraft(
    /** The words, photos' chips as marks. */
    val text: String,
    val photos: List<PickedPhoto>,
    /** Null when the backend picks (only one runner). */
    val runnerId: String? = null,
    val modelId: String? = null,
    val effort: String? = null,
    val poolId: String? = null,
    val accountId: String? = null,
    val provider: String? = null,
) {
    val settings: NewThreadSettings
        get() = NewThreadSettings(
            model = modelId,
            effort = effort,
            poolId = poolId,
            accountId = accountId,
            provider = provider,
        )
}
