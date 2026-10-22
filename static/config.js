/* Site-wide defaults for browser mode. Left empty in the repo: the GitHub Pages
 * workflow overwrites this file at deploy time from repo secrets.
 *
 * faceitKeyLocked: a FACEIT key encrypted with a password (made with "Lock a key" in
 *   ⚙ Settings, secret FACEIT_KEY_LOCKED). Safe for any key type: visitors must sign in.
 * faceitApiKey: a plain FACEIT "Client side" key (secret FACEIT_CLIENT_KEY), readable by
 *   every visitor. Never put a Server side key here - lock it instead.
 *
 * A key a visitor saves in ⚙ Settings overrides both. */
window.CS2_CONFIG = { faceitApiKey: "", faceitKeyLocked: "" };
