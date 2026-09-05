//! Screen colour picking — the eyedropper behind the colour picker's
//! "pick from screen" control.
//!
//! **Why this is ours and not the browser's.** It used to be the web
//! `EyeDropper` API. WebView2 runtime 152 (September 2026) stopped presenting
//! the overlay: `open()` rejects in under a millisecond as "The user canceled
//! the selection", no widget is ever created in the browser process, and there
//! is no flag that restores it. The runtime updates itself every two weeks, so
//! a picker control that an engine update can silently remove is not a control
//! we can ship. Taroting samples the screen itself.
//!
//! **The contract the frontend is written against.**
//! `screen_pick_color` resolves `Some("#rrggbb")` (lowercase) on a left click
//! and `None` on a cancel — Escape, a right click, or the app losing the
//! foreground to another process. While the overlay is up it emits
//! `screen-pick-hover` with `{ "hex": "#rrggbb" }`, at most once per
//! [`HOVER_MIN_INTERVAL_MS`] and only when the colour under the cursor actually
//! changed. A second call while one pick is live is refused, never merged into
//! the running one.
//!
//! **The Windows mechanism**, in order, because the order is what makes it
//! correct:
//!
//! 1. Copy the whole virtual screen (`SM_XVIRTUALSCREEN` and friends — the
//!    bounding rectangle of every monitor, whose origin is negative whenever a
//!    monitor sits left of or above the primary one) into a 32-bit top-down DIB
//!    with `BitBlt(… SRCCOPY | CAPTUREBLT)` from `GetDC(NULL)`. `CAPTUREBLT`
//!    "includes any windows that are layered on top of your window in the
//!    resulting image", which is what makes the copy match what the user sees.
//! 2. *Then* show the overlay. Every sample reads the DIB, never the live
//!    screen, so the overlay can never contaminate its own measurement and the
//!    whole pick is taken from one consistent frame. The screen behind may keep
//!    moving; what the user picks is the frame they aimed at.
//! 3. Take the click, tear everything down, return the colour.
//!
//! Nothing here is resident. No hook, no timer, no window and no captured
//! frame exists between picks — the class registration is the only thing that
//! outlives a call, and registering a window class costs nothing to keep.
//!
//! The seam is deliberately per-platform: Linux and macOS get their own
//! implementation when they arrive, behind this same command.

use crate::error::{AppError, Result};

/// Returned on a platform with no implementation. The frontend matches on this
/// exact wording to fall back, so it is a constant rather than a literal spelled
/// out at each site.
// Consumed only by the non-Windows command body (and the wording test), so on
// a Windows build it is otherwise unreferenced — that is the seam working.
#[cfg_attr(windows, allow(dead_code))]
const PLATFORM_UNSUPPORTED: &str = "screen picking is not available on this platform";

/// Returned to the *second* caller while a pick is live. The live pick is not
/// touched — cancelling someone else's overlay from underneath them is worse
/// than refusing.
#[cfg(windows)]
const PICK_IN_PROGRESS: &str = "a screen pick is already in progress";

#[cfg(windows)]
const HOVER_EVENT: &str = "screen-pick-hover";

/// One frame at 60 Hz. The hover preview only has to keep up with the eye, and
/// a moving cursor over a photograph changes colour on nearly every pixel — an
/// ungated emit would push thousands of IPC messages per second for a swatch
/// that can only be looked at sixty times.
#[cfg_attr(not(windows), allow(dead_code))]
const HOVER_MIN_INTERVAL_MS: u64 = 16;

/* ------------------------- pure parts, no desktop ------------------------- */

/// Pack the four bytes a 32-bit `BI_RGB` DIB stores for one pixel into
/// `0x00rrggbb`.
///
/// The byte order is **B, G, R, unused** — a little-endian `0x00RRGGBB` word.
/// Note that this is *not* the `COLORREF` layout, which is `0x00bbggrr` and
/// therefore lands in memory as R, G, B. The two are mirror images of each
/// other, so getting them backwards produces a plausible-looking colour that is
/// simply wrong; `bgra_to_rgb_channel_order` pins it with a pixel whose three
/// channels all differ.
#[cfg_attr(not(windows), allow(dead_code))]
fn rgb_from_bgra(px: [u8; 4]) -> u32 {
    (u32::from(px[2]) << 16) | (u32::from(px[1]) << 8) | u32::from(px[0])
}

/// `0x00rrggbb` to the `#rrggbb` the frontend expects. Lowercase, always six
/// digits.
#[cfg_attr(not(windows), allow(dead_code))]
fn hex_from_rgb(rgb: u32) -> String {
    format!("#{:06x}", rgb & 0x00ff_ffff)
}

/// Byte offset of a virtual-screen point inside the captured DIB, or `None` if
/// the point is outside it.
///
/// The DIB is created top-down (a negative `biHeight`), so row 0 is the topmost
/// row of the virtual screen and the arithmetic needs no vertical flip. The
/// origin subtraction is the part that matters: with a monitor left of or above
/// the primary one, `origin_x`/`origin_y` are negative and the point being
/// converted may be negative too. Done in `i64` so a point far outside a wide
/// virtual screen cannot wrap into a valid-looking offset.
#[cfg_attr(not(windows), allow(dead_code))]
fn dib_offset(x: i32, y: i32, origin_x: i32, origin_y: i32, width: i32, height: i32) -> Option<usize> {
    let col = i64::from(x) - i64::from(origin_x);
    let row = i64::from(y) - i64::from(origin_y);
    if col < 0 || row < 0 || col >= i64::from(width) || row >= i64::from(height) {
        return None;
    }
    Some(((row * i64::from(width) + col) * 4) as usize)
}

/// What was last sent to the frontend, and when.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy)]
struct HoverEmit {
    at_ms: u64,
    rgb: u32,
}

/// Both halves of the hover gate: the colour has to have changed **and** the
/// previous emit has to be at least a frame old. The colour test alone would
/// still fire per mouse report over a gradient; the time test alone would
/// re-send an unchanged swatch sixty times a second while the cursor crawls
/// across one flat surface.
///
/// The first sample of a pick always emits, so the frontend has a swatch to
/// show before the user moves at all.
#[cfg_attr(not(windows), allow(dead_code))]
fn hover_should_emit(last: Option<HoverEmit>, now_ms: u64, rgb: u32) -> bool {
    match last {
        None => true,
        Some(prev) => {
            prev.rgb != rgb && now_ms.saturating_sub(prev.at_ms) >= HOVER_MIN_INTERVAL_MS
        }
    }
}

/* ------------------------------- Windows --------------------------------- */

#[cfg(windows)]
mod win {
    use std::cell::RefCell;
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Once, OnceLock};
    use std::time::Instant;

    use tauri::{AppHandle, Emitter};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
        GdiFlush, GetDC, GetStockObject, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, BLACK_BRUSH, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HBRUSH, HDC, HGDIOBJ, SRCCOPY,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, VK_ESCAPE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
        GetMessageW, GetSystemMetrics, LoadCursorW, PostQuitMessage, RegisterClassW,
        SetForegroundWindow, SetLayeredWindowAttributes, ShowWindow, IDC_CROSS, LWA_ALPHA, MSG,
        SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_SHOW,
        WM_ACTIVATEAPP, WM_KEYDOWN, WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_RBUTTONDOWN, WNDCLASSW,
        WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    use crate::error::{AppError, Result};

    use super::{
        dib_offset, hex_from_rgb, hover_should_emit, rgb_from_bgra, HoverEmit, HOVER_EVENT,
        PICK_IN_PROGRESS,
    };

    /// Alpha 1, not 0. "Hit testing of a layered window is based on the shape
    /// and transparency of the window. This means that the areas of the window
    /// that are color-keyed or **whose alpha value is zero** will let the mouse
    /// messages through." Alpha 0 would make the overlay a hole the clicks fall
    /// straight through; alpha 1 is 1/255 opacity — below anything an eye
    /// resolves — and still hit-tests as solid. `WS_EX_TRANSPARENT` is likewise
    /// never set, because that ignores the shape entirely and hands the mouse to
    /// whatever is underneath.
    const OVERLAY_ALPHA: u8 = 1;

    /// Only one overlay may exist at a time, process-wide. Claimed inside the
    /// blocking task so the guard's `Drop` covers every exit path, and so the
    /// refusal comes from the same place the claim does.
    static PICK_ACTIVE: AtomicBool = AtomicBool::new(false);

    struct PickGate;

    impl Drop for PickGate {
        fn drop(&mut self) {
            PICK_ACTIVE.store(false, Ordering::Release);
        }
    }

    fn claim() -> Result<PickGate> {
        PICK_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| PickGate)
            .map_err(|_| AppError::BadInput(PICK_IN_PROGRESS.into()))
    }

    fn failed(what: &str) -> AppError {
        AppError::BadInput(format!("screen pick failed: {what}"))
    }

    /* ---------------------------- window class ---------------------------- */

    static CLASS_NAME: OnceLock<Vec<u16>> = OnceLock::new();
    static REGISTER: Once = Once::new();
    static REGISTERED: AtomicBool = AtomicBool::new(false);

    /// The class name has to outlive every window made from it, so it lives in a
    /// `OnceLock` rather than on a stack frame.
    fn class_name() -> *const u16 {
        CLASS_NAME
            .get_or_init(|| "TarotingScreenPick\0".encode_utf16().collect())
            .as_ptr()
    }

    /// Registered at most once for the life of the process, from whichever
    /// thread picks first. Windows themselves are created and destroyed per
    /// pick; a registered class holds no resources worth reclaiming.
    fn ensure_class() -> Result<()> {
        REGISTER.call_once(|| {
            // SAFETY: `GetModuleHandleW(NULL)` returns this process's own module
            // and cannot fail; `LoadCursorW(NULL, IDC_CROSS)` loads a system
            // cursor, whose handle is owned by the system and must not be freed.
            let (hinstance, cursor, brush) = unsafe {
                (
                    GetModuleHandleW(null()),
                    LoadCursorW(null_mut(), IDC_CROSS),
                    GetStockObject(BLACK_BRUSH) as HBRUSH,
                )
            };
            let class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: null_mut(),
                // The class cursor is what makes the crosshair appear and, just
                // as usefully, what makes it disappear: destroying the window
                // restores whatever cursor was there before, with nothing to
                // put back by hand.
                hCursor: cursor,
                hbrBackground: brush,
                lpszMenuName: null(),
                lpszClassName: class_name(),
            };
            // SAFETY: `class` is fully initialized and outlives the call; the
            // two pointers inside it are a `'static` UTF-16 string and system
            // handles.
            let atom = unsafe { RegisterClassW(&class) };
            REGISTERED.store(atom != 0, Ordering::Release);
        });
        if REGISTERED.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(failed("could not register the overlay window class"))
        }
    }

    /* ------------------------- the captured frame ------------------------- */

    /// The frozen virtual-screen copy every sample is read from, plus the GDI
    /// objects that back it. Built with null handles first so that a failure
    /// part-way through construction still releases whatever was acquired
    /// before it.
    struct Frame {
        screen_dc: HDC,
        mem_dc: HDC,
        dib: HBITMAP,
        previous: HGDIOBJ,
        bits: *const u8,
        len: usize,
        origin_x: i32,
        origin_y: i32,
        width: i32,
        height: i32,
    }

    impl Drop for Frame {
        fn drop(&mut self) {
            // SAFETY: each handle is either null (never acquired) or one this
            // Frame owns exclusively. The order is the one GDI requires: the
            // bitmap has to be deselected from the DC before it can be deleted,
            // and the DC before the DC it was made compatible with is released.
            unsafe {
                if !self.previous.is_null() {
                    SelectObject(self.mem_dc, self.previous);
                }
                if !self.dib.is_null() {
                    DeleteObject(self.dib);
                }
                if !self.mem_dc.is_null() {
                    DeleteDC(self.mem_dc);
                }
                if !self.screen_dc.is_null() {
                    ReleaseDC(null_mut(), self.screen_dc);
                }
            }
        }
    }

    impl Frame {
        /// The colour at a virtual-screen point, or `None` if the point is off
        /// the captured area.
        fn sample(&self, x: i32, y: i32) -> Option<u32> {
            let off = dib_offset(x, y, self.origin_x, self.origin_y, self.width, self.height)?;
            // `len` is width*height*4 by construction, so this can only fail if
            // that ever stops being true — cheap enough to keep as the backstop
            // for the raw read below.
            if off + 4 > self.len {
                return None;
            }
            // SAFETY: `bits` points at a `len`-byte DIB section owned by this
            // Frame and alive for as long as it is; `off + 4 <= len` was just
            // checked. The section is never written after the BitBlt.
            let px = unsafe { std::slice::from_raw_parts(self.bits.add(off), 4) };
            Some(rgb_from_bgra([px[0], px[1], px[2], px[3]]))
        }
    }

    /// Copy every monitor into one top-down 32-bit DIB.
    ///
    /// This runs BEFORE the overlay exists, which is the whole point: the
    /// overlay cannot appear in a picture taken before it was created.
    fn capture_virtual_screen() -> Result<Frame> {
        // SAFETY: `GetSystemMetrics` reads a system value and takes no pointer.
        let (origin_x, origin_y, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if width <= 0 || height <= 0 {
            return Err(failed("the desktop reported no size"));
        }

        let mut frame = Frame {
            screen_dc: null_mut(),
            mem_dc: null_mut(),
            dib: null_mut(),
            previous: null_mut(),
            bits: null(),
            len: 0,
            origin_x,
            origin_y,
            width,
            height,
        };

        // SAFETY: every call below is given handles this function owns, and the
        // Frame's Drop releases whatever was acquired if we return early.
        unsafe {
            frame.screen_dc = GetDC(null_mut());
            if frame.screen_dc.is_null() {
                return Err(failed("could not read the desktop"));
            }
            frame.mem_dc = CreateCompatibleDC(frame.screen_dc);
            if frame.mem_dc.is_null() {
                return Err(failed("could not allocate a device context"));
            }

            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    // Negative: rows run top-down, so row 0 is the top of the
                    // virtual screen and `dib_offset` needs no vertical flip.
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                },
                bmiColors: [std::mem::zeroed()],
            };
            let mut bits: *mut core::ffi::c_void = null_mut();
            frame.dib =
                CreateDIBSection(frame.screen_dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
            if frame.dib.is_null() || bits.is_null() {
                return Err(failed("could not allocate the screen copy"));
            }
            frame.bits = bits.cast::<u8>();
            frame.len = width as usize * height as usize * 4;

            frame.previous = SelectObject(frame.mem_dc, frame.dib);
            if BitBlt(
                frame.mem_dc,
                0,
                0,
                width,
                height,
                frame.screen_dc,
                origin_x,
                origin_y,
                SRCCOPY | CAPTUREBLT,
            ) == 0
            {
                return Err(failed("could not copy the desktop"));
            }
            // GDI batches drawing; the bits are not guaranteed to be in the
            // section until the batch is flushed, and we read them directly.
            GdiFlush();
        }

        Ok(frame)
    }

    /* ------------------------------ the overlay --------------------------- */

    /// Owns the overlay window. Dropping it is the only path that destroys the
    /// window, so pick, cancel and error all tear down identically.
    struct Overlay(HWND);

    impl Drop for Overlay {
        fn drop(&mut self) {
            // SAFETY: `ReleaseCapture` releases whatever this thread captured
            // and is harmless if it captured nothing; the HWND is ours and is
            // destroyed exactly once, here.
            unsafe {
                ReleaseCapture();
                DestroyWindow(self.0);
            }
        }
    }

    fn create_overlay(origin_x: i32, origin_y: i32, width: i32, height: i32) -> Result<Overlay> {
        // SAFETY: the class is registered, the string is 'static, and every
        // handle argument is either null or this process's own module.
        let hwnd = unsafe {
            CreateWindowExW(
                // TOPMOST so nothing paints over the click target, TOOLWINDOW so
                // it earns no taskbar button or alt-tab entry, LAYERED so it can
                // be made invisible without being made click-through.
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED,
                class_name(),
                null(),
                // Deliberately NOT WS_VISIBLE: the window must be given its
                // alpha before it is shown, or the first frame is an opaque
                // black rectangle over the whole desktop.
                WS_POPUP,
                origin_x,
                origin_y,
                width,
                height,
                null_mut(),
                null_mut(),
                GetModuleHandleW(null()),
                null(),
            )
        };
        if hwnd.is_null() {
            return Err(failed("could not create the overlay"));
        }
        let overlay = Overlay(hwnd);

        // SAFETY: `hwnd` is a live layered window owned by this thread.
        if unsafe { SetLayeredWindowAttributes(hwnd, 0, OVERLAY_ALPHA, LWA_ALPHA) } == 0 {
            return Err(failed("could not make the overlay transparent"));
        }
        Ok(overlay)
    }

    /// Where client (0, 0) sits on the virtual screen. Measured rather than
    /// assumed to equal the position we asked for, so a mouse coordinate is
    /// never silently offset by a window Windows placed somewhere else.
    fn client_origin(hwnd: HWND) -> Result<(i32, i32)> {
        let mut p = POINT { x: 0, y: 0 };
        // SAFETY: `p` is a valid writable POINT for the length of the call.
        if unsafe { ClientToScreen(hwnd, &mut p) } == 0 {
            return Err(failed("could not locate the overlay"));
        }
        Ok((p.x, p.y))
    }

    fn cursor_pos() -> Option<(i32, i32)> {
        let mut p = POINT { x: 0, y: 0 };
        // SAFETY: `p` is a valid writable POINT for the length of the call.
        if unsafe { GetCursorPos(&mut p) } == 0 {
            None
        } else {
            Some((p.x, p.y))
        }
    }

    /* ------------------------------ pick state ---------------------------- */

    #[derive(Clone, Copy)]
    enum Outcome {
        Cancelled,
        Picked(u32),
    }

    struct State {
        app: AppHandle,
        frame: Frame,
        client_origin: (i32, i32),
        started: Instant,
        last: Option<HoverEmit>,
        outcome: Outcome,
    }

    thread_local! {
        /// The live pick, readable by the window procedure on this thread.
        ///
        /// Its presence is also the ARMED flag. It is installed only after the
        /// overlay has been shown and activated, so the `WM_ACTIVATEAPP` that
        /// our own main window may send while activation moves around during
        /// setup finds no state and cancels nothing. A pick that cancelled
        /// itself the instant it opened would look exactly like the WebView2
        /// bug this module exists to replace.
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    }

    /// Client coordinates out of a mouse message's `lParam`, mapped to the
    /// virtual screen.
    ///
    /// Each half is a **signed** 16-bit value — the virtual screen's coordinates
    /// are signed shorts precisely because that is what these messages carry, so
    /// reading them as unsigned turns a point near the left edge of a wide
    /// desktop into one 65536 pixels off to the right.
    fn message_point(origin: (i32, i32), lparam: LPARAM) -> (i32, i32) {
        let x = (lparam & 0xffff) as u16 as i16 as i32;
        let y = ((lparam >> 16) & 0xffff) as u16 as i16 as i32;
        (origin.0 + x, origin.1 + y)
    }

    /// Sample a point and emit a hover if the gate allows it.
    ///
    /// The emit happens after the borrow is released. `emit` does not pump this
    /// thread's message queue today, but a re-entrant window procedure would
    /// panic on the second borrow, and that is not a failure worth leaving one
    /// refactor away.
    fn hover(x: i32, y: i32) {
        let send = STATE.with_borrow_mut(|slot| -> Option<(AppHandle, String)> {
            let st = slot.as_mut()?;
            let rgb = st.frame.sample(x, y)?;
            let now = st.started.elapsed().as_millis() as u64;
            if !hover_should_emit(st.last, now, rgb) {
                return None;
            }
            st.last = Some(HoverEmit { at_ms: now, rgb });
            Some((st.app.clone(), hex_from_rgb(rgb)))
        });
        if let Some((app, hex)) = send {
            let _ = app.emit(HOVER_EVENT, HoverPayload { hex: &hex });
        }
    }

    #[derive(serde::Serialize, Clone)]
    struct HoverPayload<'a> {
        hex: &'a str,
    }

    /// Record the click and end the loop. A point that does not land in the
    /// captured frame cancels rather than guessing a colour.
    fn pick(lparam: LPARAM) {
        STATE.with_borrow_mut(|slot| {
            let Some(st) = slot.as_mut() else { return };
            let (x, y) = message_point(st.client_origin, lparam);
            if let Some(rgb) = st.frame.sample(x, y) {
                st.outcome = Outcome::Picked(rgb);
            }
            // SAFETY: posts WM_QUIT to this thread's own queue. It dispatches
            // nothing, so it cannot re-enter this borrow.
            unsafe { PostQuitMessage(0) };
        });
    }

    /// End the loop with the default outcome. Ignored before the state is
    /// installed — see the note on `STATE`.
    fn cancel() {
        STATE.with_borrow(|slot| {
            if slot.is_some() {
                // SAFETY: as above — a post, not a dispatch.
                unsafe { PostQuitMessage(0) };
            }
        });
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_MOUSEMOVE => {
                let at = STATE.with_borrow(|s| s.as_ref().map(|st| st.client_origin));
                if let Some(origin) = at {
                    let (x, y) = message_point(origin, lparam);
                    hover(x, y);
                }
                return 0;
            }
            WM_LBUTTONDOWN => {
                pick(lparam);
                return 0;
            }
            // The mouse escape hatch. It matters more than it looks: a right
            // click reaches a topmost window whether or not the overlay ever
            // won the keyboard, so the user is never trapped under an invisible
            // full-screen window even if `SetForegroundWindow` was refused.
            WM_RBUTTONDOWN => {
                cancel();
                return 0;
            }
            WM_KEYDOWN if wparam as u16 == VK_ESCAPE => {
                cancel();
                return 0;
            }
            // wParam FALSE means a window belonging to a DIFFERENT application
            // is being activated — an alt-tab, a notification stealing focus, a
            // second app launching. Activation moving between two windows of
            // ours does not send this at all, which is why it is a sound "the
            // user has left" signal and a plain WM_ACTIVATE would not be.
            WM_ACTIVATEAPP if wparam == 0 => {
                cancel();
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Clears the live pick on every exit path, including the error ones.
    struct StateGuard;

    impl Drop for StateGuard {
        fn drop(&mut self) {
            // Taken out first and dropped outside the borrow: dropping `State`
            // drops the `Frame`, which runs GDI teardown.
            let taken = STATE.with_borrow_mut(|slot| slot.take());
            drop(taken);
        }
    }

    /// A message loop of our own, on this thread, for as long as the pick lasts.
    ///
    /// `TranslateMessage` is deliberately absent: it exists to synthesize
    /// `WM_CHAR` from key presses, and the only key this overlay reads is
    /// Escape, straight out of `WM_KEYDOWN`.
    fn pump() {
        let mut msg = unsafe { std::mem::zeroed::<MSG>() };
        loop {
            // SAFETY: `msg` is a valid writable MSG; a null HWND asks for every
            // message belonging to this thread, and this thread owns only the
            // overlay.
            let got = unsafe { GetMessageW(&mut msg, null_mut(), 0, 0) };
            // 0 is WM_QUIT, -1 is a failure we cannot recover from — either way
            // the pick is over.
            if got <= 0 {
                break;
            }
            // SAFETY: `msg` was filled in by the call above.
            unsafe { DispatchMessageW(&msg) };
        }
    }

    /// The whole pick, start to finish, on one thread.
    pub fn run(app: AppHandle) -> Result<Option<String>> {
        let _gate = claim()?;
        ensure_class()?;

        let frame = capture_virtual_screen()?;
        let (origin_x, origin_y, width, height) =
            (frame.origin_x, frame.origin_y, frame.width, frame.height);

        let overlay = create_overlay(origin_x, origin_y, width, height)?;
        let client_origin = client_origin(overlay.0)?;

        // SAFETY: `overlay.0` is a live window owned by this thread.
        unsafe {
            ShowWindow(overlay.0, SW_SHOW);
            // Legitimate here, and permitted: "the calling process is the
            // foreground process" and "the calling process received the last
            // input event" both hold, because the user just clicked the
            // eyedropper in our own window. If it is refused anyway the pick
            // still works by mouse — see WM_RBUTTONDOWN above.
            SetForegroundWindow(overlay.0);
            // Belt and braces. The overlay already covers every monitor, so the
            // pointer is always over it; capture keeps that true even if some
            // other topmost window sits above us.
            SetCapture(overlay.0);
        }

        STATE.with_borrow_mut(|slot| {
            *slot = Some(State {
                app,
                frame,
                client_origin,
                started: Instant::now(),
                last: None,
                outcome: Outcome::Cancelled,
            });
        });
        let _state = StateGuard;

        // Show the colour the pointer is already over, so the frontend has a
        // swatch before the user moves at all.
        if let Some((x, y)) = cursor_pos() {
            hover(x, y);
        }

        pump();

        let outcome = STATE.with_borrow(|slot| {
            slot.as_ref()
                .map(|st| st.outcome)
                .unwrap_or(Outcome::Cancelled)
        });
        Ok(match outcome {
            Outcome::Picked(rgb) => Some(hex_from_rgb(rgb)),
            Outcome::Cancelled => None,
        })
    }
}

/* -------------------------------- command -------------------------------- */

/// Pick a colour off the screen. `Some("#rrggbb")` on a left click, `None` on a
/// cancel.
///
/// The overlay owns a message loop, so it runs on the blocking pool rather than
/// on a runtime worker — the loop blocks for as long as the user takes to aim,
/// which could be a minute.
#[cfg(windows)]
#[tauri::command]
pub async fn screen_pick_color(app: tauri::AppHandle) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || win::run(app))
        .await
        .map_err(|e| AppError::BadInput(format!("screen pick task failed: {e}")))?
}

/// The seam for the platforms that do not have an implementation yet. The
/// frontend matches the message and falls back to a manual hex entry.
#[cfg(not(windows))]
#[tauri::command]
pub async fn screen_pick_color(_app: tauri::AppHandle) -> Result<Option<String>> {
    Err(AppError::BadInput(PLATFORM_UNSUPPORTED.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A DIB pixel whose three channels all differ, so a swapped red/blue — the
    /// one mistake this conversion invites, since `COLORREF` stores the same
    /// three bytes the other way round — cannot produce the right answer by
    /// accident.
    #[test]
    fn bgra_to_rgb_channel_order() {
        // In memory: B=0x12, G=0x34, R=0x56, and an unused fourth byte that
        // must not reach the output.
        assert_eq!(rgb_from_bgra([0x12, 0x34, 0x56, 0xff]), 0x0056_3412);
        assert_eq!(hex_from_rgb(rgb_from_bgra([0x12, 0x34, 0x56, 0xff])), "#563412");
    }

    /// Lowercase, always six digits, and the leading zeros survive.
    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex_from_rgb(0x0000_00ff), "#0000ff");
        assert_eq!(hex_from_rgb(0x00ab_cdef), "#abcdef");
        assert_eq!(hex_from_rgb(0x0000_0000), "#000000");
    }

    /// A virtual screen whose origin is negative on both axes — a monitor left
    /// of and above the primary one. Width and height differ, and so do the two
    /// offsets from the origin, so a swapped x/y, a swapped width/height, or a
    /// dropped origin each land somewhere else.
    #[test]
    fn dib_offset_handles_a_negative_origin() {
        // Origin (-1920, -240), 3840x1440: x spans -1920..1920, y spans
        // -240..1200.
        // (-100, 300) is column 1820, row 540.
        let expected = (540 * 3840 + 1820) * 4;
        assert_eq!(expected, 8_301_680);
        assert_eq!(
            dib_offset(-100, 300, -1920, -240, 3840, 1440),
            Some(expected)
        );
        // The top-left corner is offset zero — the origin subtraction, on its
        // own.
        assert_eq!(dib_offset(-1920, -240, -1920, -240, 3840, 1440), Some(0));
    }

    /// One case per edge, so a failure names the boundary that broke.
    #[test]
    fn dib_offset_rejects_points_outside_the_capture() {
        let inside = |x, y| dib_offset(x, y, -1920, -240, 3840, 1440).is_some();
        assert!(inside(1919, 1199), "the bottom-right pixel is inside");
        assert!(!inside(-1921, 300), "one pixel left of the origin");
        assert!(!inside(-100, -241), "one row above the origin");
        assert!(!inside(1920, 300), "one column past the right edge");
        assert!(!inside(-100, 1200), "one row past the bottom edge");
    }

    /// The gate needs BOTH halves. Each row fails for exactly one reason: the
    /// colour is equal, the interval is short, or neither.
    #[test]
    fn hover_gate_needs_a_new_colour_and_a_new_frame() {
        let prev = HoverEmit {
            at_ms: 1_000,
            rgb: 0x0011_2233,
        };

        assert!(
            hover_should_emit(None, 0, 0x0011_2233),
            "the first sample of a pick always emits"
        );
        assert!(
            !hover_should_emit(Some(prev), 5_000, 0x0011_2233),
            "the same colour never re-emits, however long it has been"
        );
        assert!(
            !hover_should_emit(Some(prev), 1_015, 0x0044_5566),
            "a new colour 15 ms in is inside the frame budget"
        );
        assert!(
            hover_should_emit(Some(prev), 1_016, 0x0044_5566),
            "a new colour a full frame later emits"
        );
    }

    /// The frontend branches on this exact sentence to offer manual hex entry
    /// instead of an eyedropper, so it is pinned here rather than left to a
    /// rewording.
    #[test]
    fn platform_error_wording_is_stable() {
        assert_eq!(
            PLATFORM_UNSUPPORTED,
            "screen picking is not available on this platform"
        );
    }
}
