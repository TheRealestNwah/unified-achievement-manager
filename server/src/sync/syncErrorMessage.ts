// Turns a stored sync error into something a user can act on (see #389).
// Applied when the error is read, not when it's recorded, so errors already
// in the database read better too, and the raw text stays available as the
// detail. Every platform client phrases HTTP failures as "... failed: <status>",
// which is what the status is read back out of.

export interface ExplainedSyncError {
    message: string;
    // The original error, when the message above replaced it.
    detail: string | null;
    // Whether reconnecting or changing something in Settings could fix it.
    // Rate limits, outages, and connection drops fix themselves.
    actionable: boolean;
}

const PLATFORM_NAMES: Record<string, string> = {
    steam: "Steam",
    xbox: "Xbox",
    psn: "PlayStation Network",
    retroachievements: "RetroAchievements",
    gog: "GOG",
    rpcs3: "RPCS3",
};

// Xbox is reached through OpenXBL, and it's OpenXBL's limits and outages the
// user runs into, so that's the name that means something in these messages.
function serviceName(platformId: string): string {
    return platformId === "xbox" ? "OpenXBL, the service the app uses to reach Xbox," : PLATFORM_NAMES[platformId] ?? platformId;
}

const NETWORK_ERROR = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|fetch failed|socket hang up/i;

export function explainSyncError(platformId: string, raw: string): ExplainedSyncError {
    const status = Number(/failed: (\d{3})\b/.exec(raw)?.[1]);
    const service = serviceName(platformId);
    const platform = PLATFORM_NAMES[platformId] ?? platformId;
    const explained = (message: string, actionable: boolean): ExplainedSyncError => ({ message, detail: raw, actionable });

    // The PSN and GOG clients say this when a saved refresh token is refused (see #424).
    if (/\blogin expired\b/i.test(raw)) {
        return explained(`Your ${platform} login has expired. Use Update login… in Settings to reconnect.`, true);
    }
    if (status === 429) {
        return platformId === "xbox"
            ? explained(
                  `${service} is limiting requests from your API key for now. Free keys get a set number of requests an hour. Your account is fine, and the next sync picks up where this one stopped.`,
                  false
              )
            : explained(`${platform} is limiting how many requests the app can make for now. Your account is fine, and the next sync will try again.`, false);
    }
    if (status === 401 || status === 403) {
        return explained(`${platform} didn't accept the saved login or API key. Reconnect ${platform} in Settings.`, true);
    }
    if (status >= 500 && status <= 599) {
        return explained(`${service} had a server problem (error ${status}). This is usually temporary, and the next sync will try again.`, false);
    }
    if (NETWORK_ERROR.test(raw)) {
        return explained(`Couldn't reach ${platform}. Check your internet connection. The next sync will try again.`, false);
    }
    return { message: raw, detail: null, actionable: true };
}
