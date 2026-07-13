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
only) and away from any `http_proxy`. See the loopback-bind note in
[`../security.md`](../security.md).

## cmux config to check

The relevant settings live in the `com.cmuxterm.app` defaults domain. Read the current values:

```bash
for key in browserDisabledOverride \
           browserInterceptTerminalOpenCommandInCmuxBrowser \
           browserOpenTerminalLinksInCmuxBrowser \
           browserHostWhitelist; do
  printf '%s = %s\n' "$key" "$(defaults read com.cmuxterm.app "$key" 2>/dev/null || echo '<unset>')"
done
```

For `ide browse` to land in the embedded browser you want:

- `browserDisabledOverride`: `0` / false. `1` disables the embedded browser entirely.
- `browserInterceptTerminalOpenCommandInCmuxBrowser`: `1` / true. This is the toggle that makes
  the `open` shim claim URLs.
- `browserOpenTerminalLinksInCmuxBrowser`: `1` / true.
- `browserHostWhitelist`: must include `localhost`. It's a newline-separated list, and
  `localhost` is in cmux's default set, so this usually only bites if you've trimmed the list.

The same options live under Settings → Browser in the cmux UI, which is the friendlier way to set
them. If you'd rather script it, `defaults write com.cmuxterm.app <key> <value>` works, and
`localhost` can be added to the whitelist there too.

## Verify

Run `ide browse .` from a cmux pane. It should open a cmux browser tab on the workspace. Remember
the shim only intercepts inside a cmux terminal, so testing from a non-cmux shell will always use
the system browser regardless of these settings.
