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
//! 3. Follow the cursor with a small round **loupe** that magnifies a
//!    [`LOUPE_CELLS`]-square neighbourhood of that same frozen frame. Aiming at
//!    one exact pixel is the whole job of an eyedropper, and a bare crosshair
//!    cannot do it — the cursor hotspot covers the pixel it is pointing at.
//!    The loupe magnifies the DIB, so it can never show itself, and it is
//!    click-through and never activates, so the overlay keeps both the capture
//!    and the click even while the loupe sits under the pointer.
//! 4. Take the click, tear everything down, return the colour.
//!
//! Nothing here is resident. No hook, no timer, no window and no captured
//! frame exists between picks — the class registrations are the only thing that
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

/* --------------------------- loupe geometry ------------------------------ */

/// Source pixels across the magnified neighbourhood. **Odd**, so exactly one
/// cell is the centre — the pixel the click will return.
#[cfg_attr(not(windows), allow(dead_code))]
const LOUPE_CELLS: i32 = 15;

/// Cells from the centre to an edge. `LOUPE_CELLS / 2` by definition, named
/// because every offset in here is measured from the middle outwards.
#[cfg_attr(not(windows), allow(dead_code))]
const LOUPE_RADIUS: i32 = LOUPE_CELLS / 2;

/// How many device pixels one source pixel occupies at 96 dpi. 15 cells of 10
/// gives a 150 px loupe: big enough to aim inside, small enough that it never
/// becomes the thing you are looking at.
#[cfg_attr(not(windows), allow(dead_code))]
const LOUPE_CELL_96: i32 = 10;

/// The gap between the cursor and the near corner of the loupe, in cells, so
/// that it scales with everything else. Two cells is 20 px at 96 dpi — clear of
/// the crosshair without putting the magnified view out at arm's length.
#[cfg_attr(not(windows), allow(dead_code))]
const LOUPE_GAP_CELLS: i32 = 2;

/// Device pixels per source pixel at `dpi`.
///
/// The loupe is sized in *physical* pixels so it is the same size on the
/// desk whatever the monitor is scaled to — 150 px at 100%, 225 px at 150%.
/// Every other coordinate in this module is physical too (the DIB, the overlay
/// and `GetCursorPos` are all in virtual-screen pixels), so this is the only
/// place a scale factor appears.
///
/// Rounding to a whole number of pixels per cell is not cosmetic: the whole
/// loupe is `cell * LOUPE_CELLS` wide, which makes the nearest-neighbour
/// `StretchBlt` an exact integer magnification and puts every cell boundary on
/// an integer that the grid lines and the centre marker can be drawn against.
/// A fractional cell would leave the drawn grid and the stretched pixels
/// disagreeing by up to a pixel, which is exactly the disagreement that would
/// make the user aim at the wrong cell.
#[cfg_attr(not(windows), allow(dead_code))]
fn loupe_cell_px(dpi: u32) -> i32 {
    let scaled = (LOUPE_CELL_96 as i64 * i64::from(dpi) + 48) / 96;
    // A cell below ~6 px cannot carry a grid line, a centre marker and still
    // show its colour; a cell above ~40 px is a magnifier nobody asked for.
    scaled.clamp(6, 40) as i32
}

/// The part of the magnified neighbourhood that actually exists in the captured
/// frame, in source pixels plus the cell it starts at.
///
/// `cell_x`/`cell_y` are the offsets *into the grid*, so a neighbourhood
/// clipped by the left edge of the virtual screen is drawn shifted right, with
/// the missing cells left as the placeholder the caller filled first. The
/// centre cell stays the centre cell either way, which is what the
/// `loupe_centre_cell_*` test pins.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct LoupePatch {
    src_col: i32,
    src_row: i32,
    cols: i32,
    rows: i32,
    cell_x: i32,
    cell_y: i32,
}

/// The rectangle analogue of [`dib_offset`]: the neighbourhood centred on a
/// virtual-screen point, clipped to the captured DIB, or `None` when the whole
/// neighbourhood is outside it.
///
/// Reading a row that is off the edge of the DIB would either read another
/// row's pixels (they are contiguous) or read past the section entirely, so the
/// clip is done here and the caller paints the missing cells rather than
/// magnifying whatever happened to be next in memory.
#[cfg_attr(not(windows), allow(dead_code))]
fn loupe_patch(
    x: i32,
    y: i32,
    origin_x: i32,
    origin_y: i32,
    width: i32,
    height: i32,
) -> Option<LoupePatch> {
    // In i64 for the same reason `dib_offset` is: a point far outside a wide
    // virtual screen must not wrap into a plausible column.
    let left = i64::from(x) - i64::from(origin_x) - i64::from(LOUPE_RADIUS);
    let top = i64::from(y) - i64::from(origin_y) - i64::from(LOUPE_RADIUS);

    let src_col = left.max(0);
    let src_row = top.max(0);
    let cols = (left + i64::from(LOUPE_CELLS)).min(i64::from(width)) - src_col;
    let rows = (top + i64::from(LOUPE_CELLS)).min(i64::from(height)) - src_row;
    if cols <= 0 || rows <= 0 {
        return None;
    }
    Some(LoupePatch {
        src_col: src_col as i32,
        src_row: src_row as i32,
        cols: cols as i32,
        rows: rows as i32,
        cell_x: (src_col - left) as i32,
        cell_y: (src_row - top) as i32,
    })
}

/// Top-left corner of a `size`-square loupe for a cursor at
/// (`cursor_x`, `cursor_y`), given the **monitor** rectangle
/// `(left, top, right, bottom)` the cursor is on.
///
/// The loupe hangs below-right of the cursor so the pointer never covers it,
/// and flips to the other side of the cursor on whichever axis would otherwise
/// run off the monitor. The monitor is the right boundary, not the virtual
/// screen: on a two-monitor desktop the virtual screen keeps going, so a loupe
/// placed by the virtual bounds would sail off the edge of the display the user
/// is actually looking at and land on the next one.
///
/// The final clamp only matters for a display narrower or shorter than the
/// loupe itself, where neither side fits; being pinned to the edge beats
/// hanging half off it.
#[cfg_attr(not(windows), allow(dead_code))]
fn loupe_origin(
    cursor_x: i32,
    cursor_y: i32,
    size: i32,
    gap: i32,
    monitor: (i32, i32, i32, i32),
) -> (i32, i32) {
    let (left, top, right, bottom) = monitor;

    // Up and to the right of the cursor by default — the hand and the pointer
    // sit below and to the left of what is being aimed at, so that quadrant is
    // the one least likely to be covering what the user wants to see. Each
    // axis flips independently when its far edge would leave the monitor.
    let mut x = cursor_x + gap;
    if x + size > right {
        x = cursor_x - gap - size;
    }
    let mut y = cursor_y - gap - size;
    if y < top {
        y = cursor_y + gap;
    }
    (x.min(right - size).max(left), y.min(bottom - size).max(top))
}

/// `#rrggbb` as UTF-16, for the loupe's label.
///
/// Fixed-size and allocation-free because this runs on every mouse move, and a
/// per-move heap allocation is exactly the kind of thing that has no business
/// in a drag loop. `hex_label_matches_the_emitted_hex` pins it against
/// [`hex_from_rgb`] so the label and the hover event can never disagree about
/// the colour under the cursor.
#[cfg_attr(not(windows), allow(dead_code))]
fn hex_utf16(rgb: u32) -> [u16; 7] {
    const DIGITS: [u8; 16] = *b"0123456789abcdef";
    let mut out = [u16::from(b'#'); 7];
    for i in 0..6 {
        let nibble = (rgb >> (20 - i * 4)) & 0xf;
        out[i + 1] = u16::from(DIGITS[nibble as usize]);
    }
    out
}

/* ------------------------------- Windows --------------------------------- */

#[cfg(windows)]
mod win {
    use std::cell::{Cell, RefCell};
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Once, OnceLock};
    use std::time::Instant;

    use tauri::{AppHandle, Emitter};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection,
        CreateEllipticRgn, CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject,
        DrawTextW, Ellipse, FillRect, FrameRect, GdiFlush, GetDC, GetMonitorInfoW, GetStockObject,
        MonitorFromPoint, ReleaseDC, RoundRect, SelectObject, SetBkMode, SetStretchBltMode,
        SetTextColor, SetWindowRgn, StretchBlt, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, BLACK_BRUSH, CAPTUREBLT, COLORONCOLOR, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_CENTER,
        DT_SINGLELINE, DT_VCENTER, HBITMAP, HBRUSH, HDC, HFONT, HGDIOBJ, HPEN, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, NULL_BRUSH, NULL_PEN, PS_SOLID, SRCCOPY, SYSTEM_FONT,
        TRANSPARENT, WHITE_BRUSH,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, VK_ESCAPE};
    use windows_sys::Win32::UI::WindowsAndMessaging::SetCursor;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
        GetMessageW, GetSystemMetrics, LoadCursorW, PostQuitMessage, RegisterClassW,
        SetForegroundWindow, SetLayeredWindowAttributes, SetWindowPos, ShowWindow, IDC_CROSS,
        LWA_ALPHA, MSG, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOW, SW_SHOWNA,
        WM_ACTIVATEAPP, WM_KEYDOWN, WM_LBUTTONDOWN, WM_MOUSEMOVE, WM_RBUTTONDOWN, WNDCLASSW,
        WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
        WS_POPUP,
    };

    use crate::error::{AppError, Result};

    use super::{
        dib_offset, hex_from_rgb, hex_utf16, hover_should_emit, loupe_cell_px, loupe_origin,
        loupe_patch, rgb_from_bgra, HoverEmit, HOVER_EVENT, LOUPE_CELLS, LOUPE_GAP_CELLS,
        LOUPE_RADIUS, PICK_IN_PROGRESS,
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
    static LOUPE_CLASS_NAME: OnceLock<Vec<u16>> = OnceLock::new();
    static REGISTER: Once = Once::new();
    static REGISTERED: AtomicBool = AtomicBool::new(false);

    /// The class name has to outlive every window made from it, so it lives in a
    /// `OnceLock` rather than on a stack frame.
    fn class_name() -> *const u16 {
        CLASS_NAME
            .get_or_init(|| "TarotingScreenPick\0".encode_utf16().collect())
            .as_ptr()
    }

    fn loupe_class_name() -> *const u16 {
        LOUPE_CLASS_NAME
            .get_or_init(|| "TarotingScreenPickLoupe\0".encode_utf16().collect())
            .as_ptr()
    }

    /// The loupe's own procedure, which is `DefWindowProcW` and nothing else.
    ///
    /// It deliberately does NOT share the overlay's: `WM_ACTIVATEAPP` is
    /// delivered to every top-level window of the process, so a shared
    /// procedure would cancel the pick twice on one alt-tab, and the loupe must
    /// never be the window that reads a mouse message.
    ///
    /// `WM_PAINT` still has to reach `DefWindowProcW`, which validates the
    /// update region through `BeginPaint`/`EndPaint`. Swallowing it instead
    /// would leave the region dirty forever and spin the message loop.
    unsafe extern "system" fn loupe_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
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
            let loupe = WNDCLASSW {
                lpfnWndProc: Some(loupe_wndproc),
                // No background brush: every pixel of the loupe is painted from
                // its own back buffer on every move, and an erase between the
                // move and the blit is a flicker with nothing to gain.
                hbrBackground: null_mut(),
                lpszClassName: loupe_class_name(),
                // The same crosshair, so that the pointer keeps its shape if it
                // is ever hit-tested against the loupe rather than through it.
                ..class
            };
            // SAFETY: both structs are fully initialized and outlive the calls;
            // the pointers inside them are `'static` UTF-16 strings and system
            // handles.
            let (atom, loupe_atom) = unsafe { (RegisterClassW(&class), RegisterClassW(&loupe)) };
            REGISTERED.store(atom != 0 && loupe_atom != 0, Ordering::Release);
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

    /* -------------------------------- loupe ------------------------------- */

    /// `COLORREF` is `0x00bbggrr` — the mirror of the DIB's byte order, and the
    /// reason [`rgb_from_bgra`] exists. Written out channel by channel so no
    /// literal in here has to be read backwards.
    const fn colorref(r: u8, g: u8, b: u8) -> u32 {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }

    /// Cells with no pixel behind them — the neighbourhood hanging off the edge
    /// of the desktop. Near-black rather than a checker: the loupe already has
    /// a grid, and a second pattern inside it reads as content.
    const LOUPE_VOID: u32 = colorref(18, 18, 22);
    /// Mid grey is the one value that separates cells over both a black and a
    /// white neighbourhood.
    const LOUPE_GRID: u32 = colorref(128, 128, 128);
    const LOUPE_EDGE: u32 = colorref(12, 12, 14);
    const LOUPE_RIM: u32 = colorref(236, 236, 238);
    const LOUPE_INK: u32 = colorref(242, 242, 245);

    /// `GetDpiForWindow` resolved at run time.
    ///
    /// windows-sys hides it behind the `Win32_UI_HiDpi` feature, and pulling in
    /// a whole feature for one call is a poor trade: the export has been in
    /// `user32` since Windows 10 1607, `user32` is always loaded in a GUI
    /// process, and the lookup happens once for the life of the process. Where
    /// it is missing, 96 gives the loupe its unscaled size — small on a scaled
    /// display, never broken.
    fn dpi_for_window(hwnd: HWND) -> u32 {
        // 0 means "no DPI could be determined" (an invalid handle); 96 is the
        // unscaled baseline every other value is a multiple of.
        match unsafe { GetDpiForWindow(hwnd) } {
            0 => 96,
            dpi => dpi,
        }
    }

    /// The monitor rectangle the point sits on, or `None` if Windows will not
    /// say. Physical pixels, in the same virtual-screen space as everything
    /// else here.
    fn monitor_rect(x: i32, y: i32) -> Option<(i32, i32, i32, i32)> {
        // SAFETY: `MonitorFromPoint` takes the POINT by value; `info` is a
        // valid writable MONITORINFO with its `cbSize` set, which is how
        // `GetMonitorInfoW` knows which structure it was handed.
        unsafe {
            let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST);
            if monitor.is_null() {
                return None;
            }
            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return None;
            }
            let r = info.rcMonitor;
            Some((r.left, r.top, r.right, r.bottom))
        }
    }

    /// The magnifier that follows the cursor: one window, one back buffer and
    /// one set of GDI objects, all built once per pick and all released
    /// together.
    ///
    /// Everything it draws comes out of the frozen [`Frame`], so it cannot show
    /// itself, and it covers screen the user might want to pick without
    /// affecting what a click returns — the sample is read from the DIB, not
    /// from under the pointer.
    struct Loupe {
        hwnd: HWND,
        /// Back buffer. Drawn into completely, then blitted in one go, so a
        /// move never shows a half-drawn grid.
        dc: HDC,
        bitmap: HBITMAP,
        previous_bitmap: HGDIOBJ,
        font: HFONT,
        void_brush: HBRUSH,
        grid_brush: HBRUSH,
        edge_pen: HPEN,
        rim_pen: HPEN,
        /// Device pixels per source pixel, and `cell * LOUPE_CELLS`.
        cell: i32,
        size: i32,
        gap: i32,
        /// Shown on the first paint, never before it: an empty circle appearing
        /// a frame ahead of its content is the one artefact a back buffer is
        /// supposed to prevent.
        shown: Cell<bool>,
    }

    impl Drop for Loupe {
        fn drop(&mut self) {
            // SAFETY: every handle is either null (never acquired) or one this
            // Loupe owns exclusively. Stock objects go back into the DC first
            // because GDI refuses to delete an object that is still selected,
            // and a refused delete is a leak that lasts as long as the process.
            unsafe {
                if !self.dc.is_null() {
                    SelectObject(self.dc, GetStockObject(NULL_PEN));
                    SelectObject(self.dc, GetStockObject(WHITE_BRUSH));
                    SelectObject(self.dc, GetStockObject(SYSTEM_FONT));
                    if !self.previous_bitmap.is_null() {
                        SelectObject(self.dc, self.previous_bitmap);
                    }
                }
                for object in [
                    self.bitmap as HGDIOBJ,
                    self.font as HGDIOBJ,
                    self.void_brush as HGDIOBJ,
                    self.grid_brush as HGDIOBJ,
                    self.edge_pen as HGDIOBJ,
                    self.rim_pen as HGDIOBJ,
                ] {
                    if !object.is_null() {
                        DeleteObject(object);
                    }
                }
                if !self.dc.is_null() {
                    DeleteDC(self.dc);
                }
                if !self.hwnd.is_null() {
                    DestroyWindow(self.hwnd);
                }
            }
        }
    }

    /// Build the loupe for a pick that starts with the cursor at `at`.
    ///
    /// The window is created first, at the cursor, so that `GetDpiForWindow`
    /// answers for the monitor the pick started on; only then is its size
    /// known. The size is fixed for the rest of the pick even if the user drags
    /// onto a differently scaled monitor — reallocating a bitmap, a font and a
    /// window region on a mouse move is precisely the per-move work this file
    /// is not allowed to do, and a pick is a gesture of a few seconds.
    fn create_loupe(screen_dc: HDC, at: (i32, i32)) -> Result<Loupe> {
        // SAFETY: the class is registered, the class-name string is 'static and
        // every handle argument is either null or this process's own module.
        let hwnd = unsafe {
            CreateWindowExW(
                // TOPMOST to sit above the overlay, TOOLWINDOW to earn no
                // taskbar button, NOACTIVATE so it can never take the focus the
                // overlay needs for Escape, and TRANSPARENT so the click falls
                // through it to the overlay that has the capture.
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
                loupe_class_name(),
                null(),
                WS_POPUP,
                at.0,
                at.1,
                1,
                1,
                null_mut(),
                null_mut(),
                GetModuleHandleW(null()),
                null(),
            )
        };
        if hwnd.is_null() {
            return Err(failed("could not create the loupe"));
        }

        let cell = loupe_cell_px(dpi_for_window(hwnd));
        let size = cell * LOUPE_CELLS;
        let mut loupe = Loupe {
            hwnd,
            dc: null_mut(),
            bitmap: null_mut(),
            previous_bitmap: null_mut(),
            font: null_mut(),
            void_brush: null_mut(),
            grid_brush: null_mut(),
            edge_pen: null_mut(),
            rim_pen: null_mut(),
            cell,
            size,
            gap: cell * LOUPE_GAP_CELLS,
            shown: Cell::new(false),
        };

        // SAFETY: every call is given handles this function owns, and the
        // Loupe's Drop releases whatever was acquired if we return early.
        unsafe {
            SetWindowPos(hwnd, null_mut(), at.0, at.1, size, size, SWP_NOZORDER | SWP_NOACTIVATE);

            // The round shape users know an eyedropper by. The system takes
            // ownership of a region a window accepts, so it is deleted here
            // only on the path where it was refused.
            let region = CreateEllipticRgn(0, 0, size, size);
            if !region.is_null() && SetWindowRgn(hwnd, region, 0) == 0 {
                DeleteObject(region as HGDIOBJ);
            }

            // Compatible with the SCREEN dc, not with the memory one: a fresh
            // memory DC holds a 1x1 monochrome bitmap, and a bitmap made
            // compatible with THAT is monochrome too.
            loupe.dc = CreateCompatibleDC(screen_dc);
            loupe.bitmap = CreateCompatibleBitmap(screen_dc, size, size);
            if loupe.dc.is_null() || loupe.bitmap.is_null() {
                return Err(failed("could not allocate the loupe buffer"));
            }
            loupe.previous_bitmap = SelectObject(loupe.dc, loupe.bitmap as HGDIOBJ);

            let face: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
            loupe.font = CreateFontW(
                // Negative: a character height in pixels rather than a cell
                // height, which is what makes the label scale with the loupe.
                -(cell + cell / 4),
                0,
                0,
                0,
                400,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                0,
                0,
                ANTIALIASED_QUALITY as u32,
                0,
                face.as_ptr(),
            );
            if !loupe.font.is_null() {
                SelectObject(loupe.dc, loupe.font as HGDIOBJ);
            }

            loupe.void_brush = CreateSolidBrush(LOUPE_VOID);
            loupe.grid_brush = CreateSolidBrush(LOUPE_GRID);
            loupe.edge_pen = CreatePen(PS_SOLID, edge_width(cell), LOUPE_EDGE);
            loupe.rim_pen = CreatePen(PS_SOLID, rim_width(cell), LOUPE_RIM);
            if loupe.void_brush.is_null()
                || loupe.grid_brush.is_null()
                || loupe.edge_pen.is_null()
                || loupe.rim_pen.is_null()
            {
                return Err(failed("could not allocate the loupe's drawing objects"));
            }
        }
        Ok(loupe)
    }

    /// The dark ring that hugs the circular edge, and the light one just inside
    /// it. Two rings rather than one because a single ring of either colour
    /// disappears against a desktop of the same colour.
    fn edge_width(cell: i32) -> i32 {
        (cell / 5).max(2)
    }

    fn rim_width(cell: i32) -> i32 {
        (cell / 10).max(1)
    }

    impl Loupe {
        /// Move, repaint and show. One call per mouse move.
        ///
        /// Windows synthesizes `WM_MOUSEMOVE` from the input queue rather than
        /// queueing one per hardware report, so the moves this sees are already
        /// coalesced to the rate the loop can retrieve them: there is no timer
        /// here and none is needed.
        fn update(&self, frame: &Frame, x: i32, y: i32) {
            let monitor =
                monitor_rect(x, y).unwrap_or((
                    frame.origin_x,
                    frame.origin_y,
                    frame.origin_x + frame.width,
                    frame.origin_y + frame.height,
                ));
            let (lx, ly) = loupe_origin(x, y, self.size, self.gap, monitor);

            // SAFETY: `hwnd` is a live window owned by this thread; NOACTIVATE
            // and NOZORDER keep the move from disturbing the overlay's focus or
            // its place in the topmost band.
            unsafe {
                SetWindowPos(
                    self.hwnd,
                    null_mut(),
                    lx,
                    ly,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
                self.paint(frame, x, y);
                let window_dc = GetDC(self.hwnd);
                if !window_dc.is_null() {
                    BitBlt(window_dc, 0, 0, self.size, self.size, self.dc, 0, 0, SRCCOPY);
                    ReleaseDC(self.hwnd, window_dc);
                }
                if !self.shown.get() {
                    ShowWindow(self.hwnd, SW_SHOWNA);
                    self.shown.set(true);
                }
            }
        }

        /// Draw one frame of the loupe into the back buffer.
        ///
        /// # Safety
        ///
        /// `frame` must be the live capture this loupe is being driven from:
        /// its memory DC is read as the magnification source.
        unsafe fn paint(&self, frame: &Frame, x: i32, y: i32) {
            let (cell, size) = (self.cell, self.size);

            // Every cell starts as the placeholder, so a neighbourhood that
            // hangs off the desktop shows what is missing instead of whatever
            // the clipped blit happened to leave behind.
            let all = RECT { left: 0, top: 0, right: size, bottom: size };
            FillRect(self.dc, &all, self.void_brush);

            if let Some(p) = loupe_patch(x, y, frame.origin_x, frame.origin_y, frame.width, frame.height)
            {
                // COLORONCOLOR is nearest-neighbour: the pixels must arrive as
                // hard-edged squares. Any smoothing mode would average
                // neighbours together and show the user a colour that is on the
                // screen nowhere.
                SetStretchBltMode(self.dc, COLORONCOLOR);
                StretchBlt(
                    self.dc,
                    p.cell_x * cell,
                    p.cell_y * cell,
                    p.cols * cell,
                    p.rows * cell,
                    frame.mem_dc,
                    p.src_col,
                    p.src_row,
                    p.cols,
                    p.rows,
                    SRCCOPY,
                );
            }

            // One line per boundary, drawn ON the first pixel column of each
            // cell rather than in a gutter between them — at ten device pixels
            // to a source pixel there is no gutter to draw in, and taking the
            // edge pixel leaves the other nine reading the true colour.
            for i in 1..LOUPE_CELLS {
                let vertical = RECT { left: i * cell, top: 0, right: i * cell + 1, bottom: size };
                FillRect(self.dc, &vertical, self.grid_brush);
                let horizontal = RECT { left: 0, top: i * cell, right: size, bottom: i * cell + 1 };
                FillRect(self.dc, &horizontal, self.grid_brush);
            }

            // The centre marker rings the centre cell from OUTSIDE it, so the
            // pixel being aimed at is never partly painted over by its own
            // marker. Black immediately around the cell, white around that:
            // one of the two always separates from whatever is behind it.
            let near = LOUPE_RADIUS * cell;
            let far = near + cell;
            let inner = RECT { left: near - 1, top: near - 1, right: far + 1, bottom: far + 1 };
            FrameRect(self.dc, &inner, GetStockObject(BLACK_BRUSH) as HBRUSH);
            let outer = RECT { left: near - 2, top: near - 2, right: far + 2, bottom: far + 2 };
            FrameRect(self.dc, &outer, GetStockObject(WHITE_BRUSH) as HBRUSH);

            // A hollow brush, or `Ellipse` fills the whole loupe with it.
            let previous_brush = SelectObject(self.dc, GetStockObject(NULL_BRUSH));
            let previous_pen = SelectObject(self.dc, self.edge_pen as HGDIOBJ);
            let edge = edge_width(cell);
            // A pen straddles the path it draws, so the outer ring is inset by
            // half its width to keep all of it inside the bitmap.
            Ellipse(self.dc, edge / 2, edge / 2, size - edge / 2, size - edge / 2);
            SelectObject(self.dc, self.rim_pen as HGDIOBJ);
            Ellipse(self.dc, edge, edge, size - edge, size - edge);

            if let Some(rgb) = frame.sample(x, y) {
                let text = hex_utf16(rgb);
                let (pill_w, pill_h) = (size * 3 / 5, cell * 2);
                // Sat two cells clear of the rim: any lower and the circle
                // clips the pill's corners.
                let mut pill = RECT {
                    left: (size - pill_w) / 2,
                    top: size - edge - cell * 2 - pill_h,
                    right: (size + pill_w) / 2,
                    bottom: size - edge - cell * 2,
                };
                SelectObject(self.dc, GetStockObject(NULL_PEN));
                SelectObject(self.dc, self.void_brush as HGDIOBJ);
                RoundRect(self.dc, pill.left, pill.top, pill.right, pill.bottom, pill_h, pill_h);
                SetBkMode(self.dc, TRANSPARENT as i32);
                SetTextColor(self.dc, LOUPE_INK);
                DrawTextW(
                    self.dc,
                    text.as_ptr(),
                    text.len() as i32,
                    &mut pill,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                );
            }

            SelectObject(self.dc, previous_pen);
            SelectObject(self.dc, previous_brush);
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
        /// `None` when the loupe could not be built. A missing magnifier is a
        /// worse pick, not a failed one, so the overlay carries on without it.
        ///
        /// Declared BEFORE the frame it magnifies: fields drop in declaration
        /// order, and the window that reads the capture should not outlive it.
        loupe: Option<Loupe>,
        frame: Frame,
        client_origin: (i32, i32),
        started: Instant,
        last: Option<HoverEmit>,
        /// The last point the loupe was drawn for. A `WM_MOUSEMOVE` that lands
        /// on the pixel already being magnified has nothing to redraw.
        last_point: Option<(i32, i32)>,
        outcome: Outcome,
    }

    impl State {
        /// Follow the cursor with the loupe.
        ///
        /// Deliberately outside the hover gate below: that gate throttles an
        /// IPC event by COLOUR, and the loupe tracks POSITION. Gating the
        /// magnifier on a colour change would freeze it the moment the cursor
        /// crossed a flat surface.
        fn track(&mut self, x: i32, y: i32) {
            if self.last_point == Some((x, y)) {
                return;
            }
            self.last_point = Some((x, y));
            if let Some(loupe) = &self.loupe {
                loupe.update(&self.frame, x, y);
            }
        }
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
            // Before the gate, and before the sample can bail out: the loupe
            // has to keep up with the pointer whatever the colour does.
            st.track(x, y);
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
            // WM_SETCURSOR is not sent while the mouse is captured, so the class
            // cursor registered above is never applied: whatever cursor the
            // webview was showing at the moment of capture would stay on screen
            // for the whole pick. Set the crosshair by hand, once, right after
            // taking capture; nothing else changes it until capture is released.
            SetCursor(LoadCursorW(null_mut(), IDC_CROSS));
        }

        let at = cursor_pos();

        // After the overlay is up, so the loupe lands above it in the topmost
        // band, and positioned at the cursor so it is created on the monitor
        // whose scaling it should be sized for. It goes into `State`, which
        // means the same guard that tears down the frame tears down the loupe —
        // pick, Escape, right click, lost activation and error all destroy it
        // on the one path.
        let loupe = create_loupe(frame.screen_dc, at.unwrap_or((origin_x, origin_y))).ok();

        STATE.with_borrow_mut(|slot| {
            *slot = Some(State {
                app,
                frame,
                loupe,
                client_origin,
                started: Instant::now(),
                last: None,
                last_point: None,
                outcome: Outcome::Cancelled,
            });
        });
        let _state = StateGuard;

        // Show the colour the pointer is already over, so the frontend has a
        // swatch before the user moves at all — and paint the loupe, which is
        // what first makes it visible.
        if let Some((x, y)) = at {
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

    /// The virtual screen every loupe test magnifies out of: origin negative on
    /// both axes and by DIFFERENT amounts, width unequal to height, so a
    /// swapped axis or a dropped origin lands somewhere else on every row.
    const CAPTURE: (i32, i32, i32, i32) = (-1920, -240, 3840, 1440);

    fn patch_of(x: i32, y: i32) -> Option<LoupePatch> {
        loupe_patch(x, y, CAPTURE.0, CAPTURE.1, CAPTURE.2, CAPTURE.3)
    }

    /// The magnified neighbourhood, whole and clipped.
    ///
    /// The two clipped rows are mirror images — one loses columns on the left
    /// and rows at the bottom, the other loses columns on the right and rows at
    /// the top — and every number in them differs, so an implementation that
    /// confused the two axes would turn one row into the other and fail both.
    #[test]
    fn loupe_patch_clips_the_neighbourhood_to_the_capture() {
        // Well inside: the full 15x15, starting at the top-left cell.
        // (-100, 300) is column 1820, row 540, so the neighbourhood starts
        // seven of each before that.
        assert_eq!(
            patch_of(-100, 300),
            Some(LoupePatch {
                src_col: 1813,
                src_row: 533,
                cols: 15,
                rows: 15,
                cell_x: 0,
                cell_y: 0,
            })
        );

        // Three columns from the left edge and two rows from the bottom.
        assert_eq!(
            patch_of(-1917, 1198),
            Some(LoupePatch {
                src_col: 0,
                src_row: 1431,
                cols: 11,
                rows: 9,
                cell_x: 4,
                cell_y: 0,
            })
        );

        // Two columns from the right edge and three rows from the top.
        assert_eq!(
            patch_of(1918, -237),
            Some(LoupePatch {
                src_col: 3831,
                src_row: 0,
                cols: 9,
                rows: 11,
                cell_x: 0,
                cell_y: 4,
            })
        );
    }

    /// One pair per edge: the last point with a single surviving cell, and the
    /// first with none. A neighbourhood entirely off the capture has to be
    /// `None` so the caller paints placeholder rather than magnifying whatever
    /// is next in memory — and each pair fails for exactly one edge.
    #[test]
    fn loupe_patch_is_none_once_every_cell_is_off_the_capture() {
        assert_eq!(patch_of(-1927, 300).map(|p| p.cols), Some(1), "one column left of the origin still exists");
        assert!(patch_of(-1928, 300).is_none(), "one further left and nothing does");

        assert_eq!(patch_of(1926, 300).map(|p| p.cols), Some(1), "the right edge is exclusive");
        assert!(patch_of(1927, 300).is_none(), "one column past it is off the capture");

        assert_eq!(patch_of(-100, -247).map(|p| p.rows), Some(1), "one row above the origin still exists");
        assert!(patch_of(-100, -248).is_none(), "one further up and nothing does");

        assert_eq!(patch_of(-100, 1206).map(|p| p.rows), Some(1), "the bottom edge is exclusive");
        assert!(patch_of(-100, 1207).is_none(), "one row past it is off the capture");
    }

    /// The one invariant the whole loupe rests on: the cell drawn in the middle
    /// of the grid, with the marker around it, is the pixel a click returns.
    ///
    /// Asserted against `dib_offset` — the function the click itself uses —
    /// rather than against a second copy of the arithmetic, and including the
    /// clipped cases, which are where a naive implementation drifts: there the
    /// centre cell is no longer `LOUPE_RADIUS` cells into the *source*
    /// rectangle, only into the *grid*.
    #[test]
    fn loupe_centre_cell_is_the_pixel_a_click_returns() {
        let (origin_x, origin_y, width, height) = CAPTURE;
        for (x, y) in [(-100, 300), (-1917, 1198), (1918, -237), (-1920, -240), (1919, 1199)] {
            let p = patch_of(x, y).expect("the cursor is over the capture");
            let col = p.src_col + LOUPE_RADIUS - p.cell_x;
            let row = p.src_row + LOUPE_RADIUS - p.cell_y;
            assert_eq!(
                dib_offset(x, y, origin_x, origin_y, width, height),
                Some(((row as usize) * (width as usize) + col as usize) * 4),
                "the centre cell at ({x}, {y}) is not the sampled pixel"
            );
        }
    }

    /// Placement and the flip, on a monitor that is NOT the primary one — its
    /// rectangle starts negative and is wider than it is tall, so the two axes
    /// can never coincide. Every expected value below is distinct.
    #[test]
    fn loupe_origin_flips_at_the_monitor_edge() {
        // left -1920, top -240, right 640, bottom 1200: 2560x1440, up and to
        // the left of the primary display.
        let monitor = (-1920, -240, 640, 1200);
        let place = |x, y| loupe_origin(x, y, 150, 20, monitor);

        assert_eq!(place(-1000, 300), (-980, 130), "room on both sides: up and to the right");
        assert_eq!(place(600, 300), (430, 130), "no room on the right: flipped, y untouched");
        assert_eq!(place(-1000, -100), (-980, -80), "no room above: dropped below, x untouched");
        assert_eq!(place(600, -100), (430, -80), "no room either way");

        // The flip is decided by whether the loupe's far edge would pass the
        // monitor's, so one pixel either side of exactly-fitting must differ —
        // on both axes.
        assert_eq!(place(470, 300).0, 490, "the right edge landing exactly on the monitor edge fits");
        assert_eq!(place(471, 300).0, 301, "one pixel further and it flips left");
        assert_eq!(place(-1000, -70).1, -240, "the top edge landing exactly on the monitor edge fits");
        assert_eq!(place(-1000, -71).1, -51, "one pixel higher and it drops below the cursor");
    }

    /// A display smaller than the loupe has no side that fits, so neither
    /// placement nor flip can help; being pinned to the edge is the answer.
    #[test]
    fn loupe_origin_clamps_onto_a_display_smaller_than_itself() {
        // 100 wide, 3000 tall — narrow enough that a 150 px loupe never fits
        // horizontally, tall enough that it always fits vertically.
        let monitor = (40, 0, 140, 3000);
        assert_eq!(loupe_origin(90, 500, 150, 20, monitor), (40, 330));
    }

    /// The loupe is sized in physical pixels so it is the same size on the desk
    /// at any scaling, and always a whole number of them per source pixel so
    /// the grid lines land on the stretched cell boundaries.
    #[test]
    fn loupe_cell_scales_with_the_monitor_dpi() {
        assert_eq!(loupe_cell_px(96) * LOUPE_CELLS, 150, "100%: the base size");
        assert_eq!(loupe_cell_px(120) * LOUPE_CELLS, 195, "125%");
        assert_eq!(loupe_cell_px(144) * LOUPE_CELLS, 225, "150%: half again as many pixels");
        assert_eq!(loupe_cell_px(192), 20, "200%");

        // The clamps, so an absurd reported dpi cannot produce a loupe with no
        // room for a grid line or one that covers the screen.
        assert_eq!(loupe_cell_px(1), 6, "clamped up");
        assert_eq!(loupe_cell_px(4_800), 40, "clamped down");
    }

    /// The loupe's label and the `screen-pick-hover` event describe the same
    /// pixel, so they must spell it the same way — including ignoring the same
    /// unused top byte.
    #[test]
    fn hex_label_matches_the_emitted_hex() {
        for rgb in [0x0000_0000, 0x0000_00ff, 0x00ab_cdef, 0x0056_3412, 0xff00_1234] {
            assert_eq!(
                String::from_utf16(&hex_utf16(rgb)).expect("ascii is valid UTF-16"),
                hex_from_rgb(rgb),
                "the label disagrees with the event for {rgb:#010x}"
            );
        }
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
