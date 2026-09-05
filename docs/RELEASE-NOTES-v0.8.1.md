# Taroting 0.8.1

One fix, shipped quickly because it takes a feature away from every custom
theme: the screen colour picker works again — and it no longer depends on the
browser engine underneath the app, so an engine update cannot take it away a
second time. Free and open source, as always.

## Fixed

- **The screen eyedropper in Settings → Appearance works again.** Clicking the
  eyedropper next to a colour used to do nothing at all — no picker, no message.

  What happened: the picker relied on the web platform's `EyeDropper` API, which
  the Microsoft Edge WebView2 runtime provides to the app. WebView2 **152**,
  which Windows installed automatically at the end of August, stopped
  presenting that picker: the request is refused instantly, and reported as if
  you had pressed Escape. Nothing in Taroting changed. The app trusted the
  "cancelled" answer and stayed silent, which is why the button simply seemed
  dead. (WebView2 now updates every two weeks, so this can happen to any app
  that leans on it.)

  What changed: Taroting now samples the screen itself. Clicking the eyedropper
  takes a snapshot of every monitor, then puts an invisible layer over the
  screen with a crosshair cursor. As you move, **the whole app previews the
  colour under the cursor live** — you see your theme in that colour before you
  commit to it. Click to pick; Escape or right-click to cancel and put the
  previous colour back exactly. Multiple monitors and monitors positioned left
  of or above the main one are handled; the snapshot is taken before the layer
  appears, so the picker can never sample itself.

  It adds nothing to the app when unused — no background process, no hook,
  nothing resident. If a pick completes after the colour popover has closed
  (a scroll or a resize can close it while you are off choosing), the app now
  says so and names the colour instead of discarding it silently.

## For the curious

The web `EyeDropper` API is kept only as the fallback for a platform where the
native picker isn't built. Its failure is genuinely ambiguous — a refusal and a
real cancel share the same error name — so the fallback now reads the clock: a
"cancel" that arrives faster than a person could have seen the picker was never
a cancel, and is reported as the failure it is.

---

**SmartScreen:** Windows may show "Windows protected your PC" for a newly
downloaded installer until it builds a reputation for the new version. Choose
"More info → Run anyway", or use the portable build.
