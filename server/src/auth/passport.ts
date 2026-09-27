import passport from "passport";
import { Strategy as SteamStrategy } from "passport-steam";
import { config } from "../config";
import { pool } from "../db";

passport.serializeUser((user: Express.User, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
    try {
        const result = await pool.query("select * from users where id = $1", [id]);
        done(null, result.rows[0] ?? false);
    } catch (err) {
        done(err);
    }
});

// What Steam's OpenID page tells us: which Steam account the user proved is
// theirs. Used with passport.authorize, so it lands on req.account and never
// replaces the signed-in local profile (see #393).
export interface SteamIdentity {
    steamId: string;
    displayName: string;
}

// Re-registered whenever the Steam Web API key changes; passport replaces a
// strategy registered under the same name.
export function configureSteamStrategy(apiKey: string): void {
    passport.use(
        new SteamStrategy(
            {
                returnURL: `${config.baseUrl}/auth/steam/return`,
                realm: config.baseUrl,
                apiKey,
            },
            (_identifier, profile, done) => {
                const identity: SteamIdentity = { steamId: profile.id, displayName: profile.displayName };
                done(null, identity);
            }
        )
    );
}

export { passport };
