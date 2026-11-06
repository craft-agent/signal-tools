/** The mirror's `meta` key that holds the account id the mirror's messages belong to. */
export const ACCOUNT_UUID_META = "account_uuid"

/** The mirror's `meta` key recording the sync service status. */
export const STATUS_META = "status"

/** The mirror's `meta` key recording the sync service's error message, if any. */
export const ERROR_META = "error"

/** The mirror's `meta` key recording when the sync service started (ms timestamp). */
export const STARTED_AT_META = "started_at"

/** The mirror's `meta` key recording when the sync service subscribed to incoming messages (ms timestamp). */
export const SUBSCRIBED_AT_META = "subscribed_at"

/** The mirror's `meta` key recording when the sync service last received a message (ms timestamp). */
export const LAST_RECEIVED_AT_META = "last_received_at"

/** The mirror's `meta` key recording when contacts and groups were last refreshed (ms timestamp). */
export const REFRESHED_AT_META = "refreshed_at"

/** Set to 1 when a group changed and the group list needs reading again; 0 once it was. */
export const GROUPS_STALE_META = "groups_stale"
