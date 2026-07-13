# `ide browse` opens my system browser instead of cmux's embedded browser

## Symptom

You run `ide browse .` from a [cmux](https://cmux.io) terminal and the workspace opens in your
system default browser (Chrome, Safari, whatever) instead of cmux's embedded browser pane.

## Why it happens

cmux puts its own `open` shim first on `PATH`
(`/Applications/cmux.app/Contents/Resources/bin/open`), ahead of the system `/usr/bin/open`. When
you run `open <url>` from a cmux pane, that shim decides where the URL goes:

- HTTP(S) URLs route to cmux's embedded browser, but only when interception is enabled **and** the
  URL's host is on cmux's host whitelist.
- Anything the shim doesn't claim falls through to `/usr/bin/open`, which hands the URL to your
  system default browser.
- Outside a cmux terminal (`CMUX_SOCKET_PATH` unset) the shim passes everything straight through,
  so `ide browse` from a plain terminal always uses the system browser.

`ide browse` opens `http://localhost:17877/…`, so for cmux to catch it, `localhost` has to be
whitelisted and interception has to be on. If either isn't, the URL falls through and you get the
system browser.

Only the browser-facing URL uses `localhost`. The internal calls (health-check probes, the MCP
endpoint) stay on `127.0.0.1`, which keeps them off IPv6 `::1` (the server binds IPv4 loopback
only) and avoids a DNS/hosts-file lookup for a name that isn't in `/etc/hosts` on every machine.
That alone doesn't guarantee bypassing an HTTP proxy — a tool that honors `http_proxy` still
needs `127.0.0.1` in its `NO_PROXY`/`--noproxy` list for that. See the loopback-bind note in
[`../security.md`](../security.md).

## cmux config to check

The relevant settings live in `~/.config/cmux/cmux.json`, under the `browser` key:

```jsonc
{
  "browser": {
    "hostsToOpenInEmbeddedBrowser": ["localhost", "127.0.0.1"],
    "insecureHttpHostsAllowedInEmbeddedBrowser": ["localhost", "127.0.0.1"],
    "interceptTerminalOpenCommandInCmuxBrowser": true
  }
}
```

For `ide browse` to route into the embedded browser at all, you want:

- `browser.interceptTerminalOpenCommandInCmuxBrowser`: `true`. This is the toggle that makes the
  `open` shim claim URLs.
- `browser.hostsToOpenInEmbeddedBrowser`: must include `localhost`.

`browser.insecureHttpHostsAllowedInEmbeddedBrowser` is a separate setting — it only controls
whether cmux warns on a plain `http://` open (which is what `ide browse` uses), not whether the
URL routes into the embedded browser in the first place. It's worth adding `localhost` there too
if you're seeing a warning, but it won't fix routing on its own.

The same options live under Settings → Browser in the cmux UI, which is the friendlier way to set
them. If you edit the JSON file by hand, reload it from the app (Settings → Browser, or the
`cmd+shift+,` shortcut) rather than restarting cmux.

## Verify

Run `ide browse .` from a cmux pane. It should open a cmux browser tab on the workspace. Remember
the shim only intercepts inside a cmux terminal, so testing from a non-cmux shell will always use
the system browser regardless of these settings.
