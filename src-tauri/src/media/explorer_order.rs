//! The order a File Explorer window lists a folder in, for the viewer's
//! previous/next. A user who double-clicks the newest clip in a folder sorted
//! by date expects "next" to be the clip beside it on screen, not the next
//! name in the alphabet (Windows' own Photos and Movies & TV behave this way).
//!
//! Read once per file the viewer is sent to, never per step: siblings.rs holds
//! the answer for one folder. Everything here runs on a thread of its own with
//! a deadline, so a busy or hung Explorer costs the viewer at most
//! `CAPTURE_TIMEOUT` and then natural name order.
//!
//! Windows only; elsewhere there is no Explorer to ask and the capture is None.

use std::collections::HashMap;
use std::path::Path;

/// Exact file name → its position in the window's view order (0-based).
pub type Ranks = HashMap<String, u32>;

/// How long a listing waits for Explorer's answer before it falls back to
/// name order. Set by the slowest case that matters: a cold start from a
/// double-click in Explorer, where the app, the COM runtime and the proxies
/// into Explorer all load at once — and a capture that misses the deadline
/// holds name order for the whole viewer session. A warm capture answers in
/// tens of milliseconds, so the arrows and the counter only wait this long
/// when Explorer is hung.
#[cfg(windows)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// The view order of the Explorer window showing `file`'s folder, or None:
/// no such window, a view with no filesystem path (a library, a search), a
/// COM failure, an elevation mismatch, or no answer within the deadline.
///
/// Under the in-app E2E harness this never touches COM: the owner's own
/// Explorer windows must not steer a test, and its fixture folder is
/// name-ordered by design.
pub fn capture(file: &Path) -> Option<Ranks> {
    if crate::debug::autotest_mode() {
        return None;
    }
    #[cfg(windows)]
    {
        win::capture(file)
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        None
    }
}

/// A folder path in the one spelling two views of it share: `/` as `\`, no
/// trailing separator, the `\\?\` prefix dropped, case folded.
pub fn folder_key(path: &str) -> String {
    let p = path.replace('/', "\\");
    let p = if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        p
    };
    p.trim_end_matches('\\').to_lowercase()
}

#[cfg(windows)]
mod win {
    use super::{folder_key, Ranks, CAPTURE_TIMEOUT};
    use std::path::Path;

    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IDataObject,
        IServiceProvider, CLSCTX_ALL, COINIT_MULTITHREADED, DVASPECT_CONTENT, FORMATETC,
        TYMED_HGLOBAL,
    };
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::ReleaseStgMedium;
    use windows::Win32::System::Variant::{VARIANT, VT_I4};
    use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
    use windows::Win32::UI::Shell::{
        IFolderView, IPersistFolder2, IShellBrowser, IShellFolder, IShellWindows, SHBindToObject,
        SHGetNameFromIDList, SID_STopLevelBrowser, ShellWindows, StrRetToStrW, CFSTR_SHELLIDLIST,
        SHGDNF, SHGDN_FORPARSING, SHGDN_INFOLDER, SIGDN_FILESYSPATH, SVGIO_ALLVIEW,
        SVGIO_FLAG_VIEWORDER, SVGIO_SELECTION,
    };

    pub(super) fn capture(file: &Path) -> Option<Ranks> {
        let folder = folder_key(file.parent()?.to_str()?);
        let name = file.file_name()?.to_str()?.to_owned();
        #[cfg(debug_assertions)]
        let asked = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        // A thread of its own: the apartment is ours to set up and tear down,
        // and a late answer has nowhere to go but a channel nobody reads.
        std::thread::Builder::new()
            .name("explorer-order".into())
            .spawn(move || {
                if tx.send(on_com_thread(&folder, &name)).is_err() {
                    // How late a missed answer was is what says whether the
                    // deadline is long enough; a dev run shows it.
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "Taroting: Explorer order answered after the deadline ({} ms)",
                        asked.elapsed().as_millis()
                    );
                }
            })
            .ok()?;
        let got = rx.recv_timeout(CAPTURE_TIMEOUT);
        #[cfg(debug_assertions)]
        eprintln!(
            "Taroting: Explorer order {} ({} ms)",
            match &got {
                Ok(Ok(ranks)) => format!("read from the folder's window, {} items", ranks.len()),
                Ok(Err(why)) => format!("not read: {why}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    "not read: no answer within the deadline".to_owned()
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    "not read: the capture ended without an answer".to_owned()
                }
            },
            asked.elapsed().as_millis()
        );
        got.ok()?.ok()
    }

    /// The order, or why there is none (for the dev log only).
    fn on_com_thread(folder: &str, name: &str) -> Result<Ranks, &'static str> {
        // SAFETY: a fresh thread, so this is its first and only COM init; every
        // interface below lives inside `find_and_read` and is released before
        // the matching CoUninitialize.
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            return Err("COM did not start");
        }
        let out = find_and_read(folder, name);
        unsafe { CoUninitialize() };
        out
    }

    fn find_and_read(folder: &str, name: &str) -> Result<Ranks, &'static str> {
        let view = matching_view(folder, name).ok_or("no Explorer window shows the folder")?;
        read_view_order(&view).ok_or("the window's view could not be read")
    }

    /// The view of the Explorer window (or Windows 11 tab — each is its own
    /// entry) showing `folder`. Several: the one whose selection holds `name`,
    /// which is the one the user double-clicked in; else the first.
    fn matching_view(folder: &str, name: &str) -> Option<IFolderView> {
        // SAFETY: plain COM calls on interfaces this function owns.
        let windows: IShellWindows =
            unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_ALL) }.ok()?;
        let count = unsafe { windows.Count() }.ok()?;
        let mut matches: Vec<IFolderView> = Vec::new();
        for i in 0..count {
            let Some(view) = view_at(&windows, i) else {
                continue;
            };
            if view_folder(&view).is_some_and(|f| folder_key(&f) == folder) {
                matches.push(view);
            }
        }
        if matches.len() > 1 {
            if let Some(i) = matches.iter().position(|v| selection_holds(v, name)) {
                return Some(matches.swap_remove(i));
            }
        }
        matches.into_iter().next()
    }

    /// Entry `i` as a folder view. Anything that is not a shell browser with
    /// a folder view (a closing window, another host) is skipped.
    fn view_at(windows: &IShellWindows, i: i32) -> Option<IFolderView> {
        let mut index = VARIANT::default();
        // SAFETY: a VT_I4 VARIANT owns nothing, so writing the tag and the
        // integer is its whole initialisation and it needs no VariantClear.
        unsafe {
            let v = &mut *index.Anonymous.Anonymous;
            v.vt = VT_I4;
            v.Anonymous.lVal = i;
        }
        let item = unsafe { windows.Item(&index) }.ok()?;
        let provider: IServiceProvider = item.cast().ok()?;
        let browser: IShellBrowser =
            unsafe { provider.QueryService(&SID_STopLevelBrowser) }.ok()?;
        let view = unsafe { browser.QueryActiveShellView() }.ok()?;
        view.cast().ok()
    }

    /// The filesystem path of the folder a view shows; None for a view with
    /// none (This PC, a library, search results).
    pub(super) fn view_folder(view: &IFolderView) -> Option<String> {
        let persist: IPersistFolder2 = unsafe { view.GetFolder() }.ok()?;
        let pidl = unsafe { persist.GetCurFolder() }.ok()?;
        let path = filesystem_path(pidl);
        // SAFETY: GetCurFolder hands the caller a CoTaskMem allocation.
        unsafe { CoTaskMemFree(Some(pidl as *const _)) };
        path
    }

    fn filesystem_path(pidl: *const ITEMIDLIST) -> Option<String> {
        if pidl.is_null() {
            return None;
        }
        // SIGDN_FILESYSPATH, not SHGetPathFromIDListW: a folder reached
        // through the OneDrive entry is a delegate item the shorter API can
        // fail on.
        let name = unsafe { SHGetNameFromIDList(pidl, SIGDN_FILESYSPATH) }.ok()?;
        take_pwstr(name)
    }

    /// A CoTaskMem string as an owned String, freed either way.
    fn take_pwstr(s: PWSTR) -> Option<String> {
        if s.is_null() {
            return None;
        }
        // SAFETY: a NUL-terminated string the shell allocated for the caller.
        let out = unsafe { s.to_string() }.ok();
        unsafe { CoTaskMemFree(Some(s.0 as *const _)) };
        out
    }

    fn selection_holds(view: &IFolderView, name: &str) -> bool {
        read_names(view, SVGIO_SELECTION.0).is_some_and(|names| names.iter().any(|n| n == name))
    }

    /// Every item of the view, in the order the view shows them.
    ///
    /// ONE call across to Explorer for the whole list: the view's items as a
    /// data object, whose "Shell IDList Array" is copied over in a single
    /// block and parsed here. (An item array or an enumerator would cost a
    /// round trip per item, or per batch.) SVGIO_FLAG_VIEWORDER is what makes
    /// it the view's order rather than the folder's; the proof is
    /// `tests::view_order_follows_the_views_sort` (sorted and grouped views),
    /// run by hand because showing a folder in any view writes the user's
    /// registry.
    pub(super) fn read_view_order(view: &IFolderView) -> Option<Ranks> {
        let names = read_names(view, SVGIO_ALLVIEW.0 | SVGIO_FLAG_VIEWORDER.0)?;
        let mut ranks = Ranks::with_capacity(names.len());
        for (i, n) in names.into_iter().enumerate() {
            let rank = u32::try_from(i).ok()?;
            ranks.entry(n).or_insert(rank);
        }
        Some(ranks)
    }

    /// The file names of `flags`' items, in the data object's order.
    fn read_names(view: &IFolderView, flags: i32) -> Option<Vec<String>> {
        use windows::Win32::UI::Shell::_SVGIO;
        let data: IDataObject = unsafe { view.Items(_SVGIO(flags)) }.ok()?;
        let format = unsafe { RegisterClipboardFormatW(CFSTR_SHELLIDLIST) };
        let format = u16::try_from(format).ok().filter(|f| *f != 0)?;
        let etc = FORMATETC {
            cfFormat: format,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        let mut medium = unsafe { data.GetData(&etc) }.ok()?;
        let names = if medium.tymed == TYMED_HGLOBAL.0 as u32 {
            // SAFETY: tymed says the union holds an HGLOBAL.
            names_of_cida(unsafe { medium.u.hGlobal })
        } else {
            None
        };
        // SAFETY: the medium came from GetData and is released exactly once.
        unsafe { ReleaseStgMedium(&mut medium) };
        names
    }

    fn names_of_cida(global: HGLOBAL) -> Option<Vec<String>> {
        // SAFETY: a locked HGLOBAL is `size` readable bytes until unlocked;
        // the slice does not outlive the lock.
        let size = unsafe { GlobalSize(global) };
        let base = unsafe { GlobalLock(global) } as *const u8;
        if base.is_null() {
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(base, size) };
        let out = parse_cida(bytes).and_then(|(parent, children)| names_in(parent, &children));
        let _ = unsafe { GlobalUnlock(global) };
        out
    }

    /// Bind to the parent folder once, in this process, and ask it for each
    /// child's name: no further round trips to Explorer.
    fn names_in(parent: &[u8], children: &[&[u8]]) -> Option<Vec<String>> {
        let folder: IShellFolder =
            unsafe { SHBindToObject(None, parent.as_ptr() as *const ITEMIDLIST, None) }.ok()?;
        let flags = SHGDNF(SHGDN_INFOLDER.0 | SHGDN_FORPARSING.0);
        let mut names = Vec::with_capacity(children.len());
        for child in children {
            let pidl = child.as_ptr() as *const ITEMIDLIST;
            let mut ret = STRRET::default();
            if unsafe { folder.GetDisplayNameOf(pidl, flags, &mut ret) }.is_err() {
                continue;
            }
            let mut name = PWSTR::null();
            if unsafe { StrRetToStrW(&mut ret, Some(pidl), &mut name) }.is_err() {
                continue;
            }
            if let Some(n) = take_pwstr(name) {
                names.push(n);
            }
        }
        Some(names)
    }

    /// A CIDA ("Shell IDList Array"): `cidl`, then `cidl + 1` byte offsets —
    /// the parent folder's ID list, then each child's. Every offset and every
    /// ID list is bounds-checked here before the shell sees a byte of it: the
    /// block came from another process.
    pub(super) fn parse_cida(bytes: &[u8]) -> Option<(&[u8], Vec<&[u8]>)> {
        let u32_at = |at: usize| -> Option<u32> {
            Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
        };
        let cidl = usize::try_from(u32_at(0)?).ok()?;
        // Each offset takes 4 bytes, so a count the block cannot hold is
        // refused before anything is allocated for it.
        if cidl >= bytes.len() / 4 {
            return None;
        }
        let mut lists = Vec::with_capacity(cidl + 1);
        for i in 0..=cidl {
            let at = usize::try_from(u32_at(4 + 4 * i)?).ok()?;
            lists.push(id_list_at(bytes, at)?);
        }
        let parent = lists.remove(0);
        Some((parent, lists))
    }

    /// The ID list starting at `at`, terminator included: SHITEMIDs of `cb`
    /// bytes each (cb counts itself), ended by a zero `cb`.
    fn id_list_at(bytes: &[u8], at: usize) -> Option<&[u8]> {
        let mut end = at;
        loop {
            let cb = u16::from_le_bytes(bytes.get(end..end + 2)?.try_into().ok()?) as usize;
            if cb == 0 {
                return bytes.get(at..end + 2);
            }
            if cb < 2 {
                return None;
            }
            end = end.checked_add(cb)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_keys_agree_across_spellings() {
        let want = folder_key(r"C:\Users\A\OneDrive\Videos\OBS Clips");
        for p in [
            r"c:\users\a\onedrive\videos\obs clips",
            r"C:\Users\A\OneDrive\Videos\OBS Clips\",
            "C:/Users/A/OneDrive/Videos/OBS Clips/",
            r"\\?\C:\Users\A\OneDrive\Videos\OBS Clips",
        ] {
            assert_eq!(folder_key(p), want, "{p}");
        }
        assert_eq!(
            folder_key(r"\\?\UNC\srv\share\x\"),
            folder_key(r"\\SRV\Share\X")
        );
        // A sibling folder whose name merely starts the same is another folder.
        assert_ne!(folder_key(r"C:\a\clips 2"), folder_key(r"C:\a\clips"));
    }

    /// Every offset and every ID list in a CIDA from another process is
    /// bounds-checked before the shell sees it.
    #[cfg(windows)]
    #[test]
    fn a_malformed_id_list_array_is_refused() {
        use super::win::parse_cida;
        // cidl 1: offsets 12 (parent: the empty list) and 14 (one 4-byte item).
        let good: Vec<u8> = [1u32, 12, 14]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .chain([0, 0])
            .chain([4, 0, 0xAB, 0xCD, 0, 0])
            .collect();
        let (parent, children) = parse_cida(&good).unwrap();
        assert_eq!(parent, &[0, 0]);
        assert_eq!(children, vec![&[4u8, 0, 0xAB, 0xCD, 0, 0][..]]);

        let mut cut = good.clone();
        cut.truncate(good.len() - 1); // the child's terminator is cut short
        assert!(parse_cida(&cut).is_none());
        let mut past = good.clone();
        past[8..12].copy_from_slice(&200u32.to_le_bytes()); // offset past the end
        assert!(parse_cida(&past).is_none());
        let mut tiny = good.clone();
        tiny[14] = 1; // an item shorter than its own size field
        assert!(parse_cida(&tiny).is_none());
        let mut huge = good.clone();
        huge[0..4].copy_from_slice(&u32::MAX.to_le_bytes()); // a count it cannot hold
        assert!(parse_cida(&huge).is_none());
        assert!(parse_cida(&[]).is_none());
    }

    /// The proof that `read_view_order` returns the order the view SHOWS, not
    /// the folder's own: a real Explorer view, in this process, on a window
    /// that is never shown (no WS_VISIBLE, no ShowWindow — nothing appears on
    /// the desktop), over files whose name, size and date orders all differ.
    /// Sorted by size descending, then by name descending, it must read back
    /// exactly that. Without SVGIO_FLAG_VIEWORDER the same view reads back
    /// neither (measured on Windows 11 26300: a rotation that starts at the
    /// focused item), so this also pins the flag.
    ///
    /// Then GROUPED, as Explorer shows Downloads by default: sorted by size
    /// again and grouped by type, the groups set the order on screen, and it
    /// must read back in that order, not the plain sort's. The type is the
    /// group key because its buckets are fixed (a date group moves at
    /// midnight, and every fixture is one size bucket).
    ///
    /// The user's remembered folder views (Shell\BagMRU, Shell\Bags):
    /// EBO_NOPERSISTVIEWSTATE keeps this view's mode, sorts and grouping out
    /// of them. It does not cover folder-type discovery, which records the
    /// type it sniffed — and with it a remembered slot for the folder — the
    /// first time any view shows a folder; a FolderType declared in a
    /// desktop.ini is recorded the same way (both measured on Windows 11
    /// 26300). So the folder's name is fixed: the first run on a machine takes
    /// one slot, and every later run finds it and adds nothing — at most it
    /// moves that slot to the front of the temp folder's recently-used list
    /// (measured by the keys' last-write times) — where a per-run name took a
    /// slot per run. Even that one slot is a write to the user's registry that
    /// no flag prevents, so the test does not run with the suite.
    #[cfg(windows)]
    #[test]
    #[ignore = "shows a folder in an Explorer view, which Windows remembers in the user's registry — run by hand: cargo test -- --ignored view_order"]
    fn view_order_follows_the_views_sort() {
        std::thread::spawn(proof::run).join().unwrap();
    }

    #[cfg(windows)]
    mod proof {
        use super::win::read_view_order;
        use std::time::{Duration, Instant, SystemTime};
        use windows::core::{w, Interface, HSTRING};
        use windows::Win32::Foundation::{PROPERTYKEY, RECT};
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::UI::Shell::Common::ITEMIDLIST;
        use windows::Win32::UI::Shell::{
            ExplorerBrowser, IExplorerBrowser, IFolderView, IFolderView2, SHParseDisplayName,
            EBO_NAVIGATEONCE, EBO_NOPERSISTVIEWSTATE, EBO_NOTRAVELLOG, FOLDERSETTINGS, FVM_DETAILS,
            SBSP_ABSOLUTE, SORTCOLUMN, SORT_DESCENDING, SVGIO_ALLVIEW,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, IsWindowVisible, PeekMessageW,
            TranslateMessage, MSG, PM_REMOVE, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
        };

        /// System.Size, System.ItemNameDisplay and System.ItemTypeText
        /// (propkey.h).
        const SYSTEM: windows::core::GUID =
            windows::core::GUID::from_u128(0xb725f130_47ef_101a_a5f1_02608c9eebac);
        const PKEY_SIZE: PROPERTYKEY = PROPERTYKEY {
            fmtid: SYSTEM,
            pid: 12,
        };
        const PKEY_NAME: PROPERTYKEY = PROPERTYKEY {
            fmtid: SYSTEM,
            pid: 10,
        };
        const PKEY_TYPE: PROPERTYKEY = PROPERTYKEY {
            fmtid: SYSTEM,
            pid: 4,
        };

        /// Pump this thread's messages (the view enumerates and sorts through
        /// them) until `done` or the deadline.
        fn pump_until(deadline: Duration, mut done: impl FnMut() -> bool) -> bool {
            let end = Instant::now() + deadline;
            loop {
                let mut msg = MSG::default();
                while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                    unsafe {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                if done() {
                    return true;
                }
                if Instant::now() > end {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn in_view_order(view: &IFolderView) -> Option<Vec<String>> {
            let mut v: Vec<(String, u32)> = read_view_order(view)?.into_iter().collect();
            v.sort_by_key(|(_, r)| *r);
            Some(v.into_iter().map(|(n, _)| n).collect())
        }

        /// Sort the view by `key` descending and wait until it reads back
        /// `want` — the sort lands through the message queue, not at once
        /// (and the view may refuse a read while it re-sorts).
        fn sort_and_read(
            view: &IFolderView2,
            key: PROPERTYKEY,
            want: &[&str],
        ) -> Option<Vec<String>> {
            let col = SORTCOLUMN {
                propkey: key,
                direction: SORT_DESCENDING,
            };
            unsafe { view.SetSortColumns(&[col]) }.unwrap();
            read_until(view, want)
        }

        /// Group the view by `key`, groups ascending, and wait until it reads
        /// back `want`, the same way.
        fn group_and_read(
            view: &IFolderView2,
            key: PROPERTYKEY,
            want: &[&str],
        ) -> Option<Vec<String>> {
            unsafe { view.SetGroupBy(&key, true) }.unwrap();
            read_until(view, want)
        }

        fn read_until(view: &IFolderView2, want: &[&str]) -> Option<Vec<String>> {
            let fv: IFolderView = view.cast().unwrap();
            let mut got = None;
            pump_until(Duration::from_secs(5), || {
                got = in_view_order(&fv);
                got.as_deref().is_some_and(|g| g == want)
            });
            got
        }

        pub fn run() {
            // One fixed name, never a per-run one (see the test's doc), and
            // recreated empty so nothing a failed run left behind is listed.
            let dir = std::env::temp_dir().join("taroting-eo-proof");
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            // Name ascending: alpha bravo charlie delta. Size descending:
            // charlie alpha delta bravo. Date descending: bravo delta alpha
            // charlie. No two of those (or name descending) agree at any
            // position, so a reader that followed any other order fails.
            // Two types for the grouped view, GIF before PNG in any naming
            // ("GIF File", "PNG File", "Fichier GIF", ...): grouped by type
            // over the size sort, that is delta bravo | charlie alpha, which
            // differs from the plain size sort at every position.
            let now = SystemTime::now();
            for (name, size, age_h) in [
                ("alpha.png", 300u64, 30u64),
                ("bravo.gif", 100, 10),
                ("charlie.png", 400, 40),
                ("delta.gif", 200, 20),
            ] {
                let f = std::fs::File::create(dir.join(name)).unwrap();
                f.set_len(size).unwrap();
                f.set_modified(now - Duration::from_secs(age_h * 3600))
                    .unwrap();
            }
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.unwrap();
            // Top-level so no window of anyone else's is its parent; never
            // WS_VISIBLE and never shown, so neither is anything inside it.
            let hwnd = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!(""),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    800,
                    600,
                    None,
                    None,
                    None,
                    None,
                )
            }
            .unwrap();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let browser: IExplorerBrowser =
                    unsafe { CoCreateInstance(&ExplorerBrowser, None, CLSCTX_INPROC_SERVER) }
                        .unwrap();
                let rc = RECT {
                    left: 0,
                    top: 0,
                    right: 800,
                    bottom: 600,
                };
                let fs = FOLDERSETTINGS {
                    ViewMode: FVM_DETAILS.0 as u32,
                    fFlags: 0,
                };
                unsafe {
                    browser.SetOptions(EBO_NAVIGATEONCE | EBO_NOTRAVELLOG | EBO_NOPERSISTVIEWSTATE)
                }
                .unwrap();
                unsafe { browser.Initialize(hwnd, &rc, Some(&fs)) }.unwrap();
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                    unsafe {
                        SHParseDisplayName(
                            &HSTRING::from(dir.as_os_str()),
                            None,
                            &mut pidl,
                            0,
                            None,
                        )
                    }
                    .unwrap();
                    let browsed = unsafe { browser.BrowseToIDList(pidl, SBSP_ABSOLUTE) };
                    unsafe { CoTaskMemFree(Some(pidl as *const _)) };
                    browsed.unwrap();
                    let mut view: Option<IFolderView2> = None;
                    let enumerated = pump_until(Duration::from_secs(10), || {
                        if view.is_none() {
                            view = unsafe { browser.GetCurrentView::<IFolderView2>() }.ok();
                        }
                        view.as_ref()
                            .is_some_and(|v| unsafe { v.ItemCount(SVGIO_ALLVIEW) } == Ok(4))
                    });
                    assert!(enumerated, "the view never listed the four files");
                    let view = view.unwrap();
                    let by_size = ["charlie.png", "alpha.png", "delta.gif", "bravo.gif"];
                    assert_eq!(
                        sort_and_read(&view, PKEY_SIZE, &by_size).as_deref(),
                        Some(&by_size.map(String::from)[..])
                    );
                    let by_name = ["delta.gif", "charlie.png", "bravo.gif", "alpha.png"];
                    assert_eq!(
                        sort_and_read(&view, PKEY_NAME, &by_name).as_deref(),
                        Some(&by_name.map(String::from)[..])
                    );
                    // Grouped over the size sort: the GIF group, then the PNG
                    // group, each in size order. Back to the size sort first,
                    // so the order the groups override is the one it is
                    // compared with.
                    assert_eq!(
                        sort_and_read(&view, PKEY_SIZE, &by_size).as_deref(),
                        Some(&by_size.map(String::from)[..])
                    );
                    let grouped = ["delta.gif", "bravo.gif", "charlie.png", "alpha.png"];
                    assert!(
                        grouped.iter().zip(&by_size).all(|(g, s)| g != s),
                        "the grouped order must differ from the plain sort at every position"
                    );
                    assert_eq!(
                        group_and_read(&view, PKEY_TYPE, &grouped).as_deref(),
                        Some(&grouped.map(String::from)[..])
                    );
                    assert!(
                        !unsafe { IsWindowVisible(hwnd) }.as_bool(),
                        "the probe window became visible"
                    );
                }));
                // Every interface is released before CoUninitialize, pass or fail.
                unsafe { browser.Destroy() }.unwrap();
                drop(browser);
                if let Err(p) = outcome {
                    std::panic::resume_unwind(p);
                }
            }));
            unsafe { DestroyWindow(hwnd) }.unwrap();
            unsafe { CoUninitialize() };
            let _ = std::fs::remove_dir_all(&dir);
            if let Err(p) = result {
                std::panic::resume_unwind(p);
            }
        }
    }

    /// The half the proof above cannot reach: a view that lives in
    /// explorer.exe, its folder and its item data object marshalled into this
    /// process, as the capture reads a real Explorer window. The one such
    /// view there without showing a window is the desktop's, so this reads
    /// that, through the production `view_folder` and `read_view_order`, on a
    /// multithreaded apartment like the capture's. Read only: no selection,
    /// no sort, no view change. Ignored because the answer is this machine's
    /// desktop; run it by hand with
    /// `cargo test -- --ignored probe_desktop_view_cross_process --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore = "reads this machine's live desktop view in explorer.exe"]
    fn probe_desktop_view_cross_process() {
        std::thread::spawn(probe::run).join().unwrap();
    }

    #[cfg(windows)]
    mod probe {
        use super::win::{read_view_order, view_folder};
        use std::time::Instant;
        use windows::core::Interface;
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, IServiceProvider, CLSCTX_ALL,
            COINIT_MULTITHREADED,
        };
        use windows::Win32::System::Variant::{VARIANT, VT_I4};
        use windows::Win32::UI::Shell::{
            IFolderView, IShellBrowser, IShellWindows, SID_STopLevelBrowser, ShellWindows,
            CSIDL_DESKTOP, SVGIO_ALLVIEW, SWC_DESKTOP, SWFO_NEEDDISPATCH,
        };

        pub fn run() {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.unwrap();
            // Every interface lives inside `read_desktop`, so all of them are
            // released before CoUninitialize, pass or fail.
            let result = std::panic::catch_unwind(read_desktop);
            unsafe { CoUninitialize() };
            if let Err(p) = result {
                std::panic::resume_unwind(p);
            }
        }

        /// explorer.exe's desktop view: found, never created (no
        /// SWFO_INCLUDEPENDING, no cookie), and nothing on it is changed.
        fn desktop_view() -> IFolderView {
            let windows: IShellWindows =
                unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_ALL) }.expect("ShellWindows");
            let mut at = VARIANT::default();
            // SAFETY: as in `view_at` — a VT_I4 VARIANT owns nothing.
            unsafe {
                let v = &mut *at.Anonymous.Anonymous;
                v.vt = VT_I4;
                v.Anonymous.lVal = CSIDL_DESKTOP as i32;
            }
            let root = VARIANT::default();
            let mut hwnd = 0i32;
            let found = unsafe {
                windows.FindWindowSW(&at, &root, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)
            }
            .expect("FindWindowSW(desktop)");
            let provider: IServiceProvider = found.cast().expect("IServiceProvider");
            let browser: IShellBrowser = unsafe { provider.QueryService(&SID_STopLevelBrowser) }
                .expect("SID_STopLevelBrowser");
            let view = unsafe { browser.QueryActiveShellView() }.expect("QueryActiveShellView");
            view.cast().expect("IFolderView")
        }

        fn read_desktop() {
            let ms = |since: Instant| since.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let view = desktop_view();
            let found_ms = ms(started);
            let folder = view_folder(&view);
            let items = unsafe { view.ItemCount(SVGIO_ALLVIEW) }.expect("ItemCount");
            let reading = Instant::now();
            let ranks = read_view_order(&view);
            let read_ms = ms(reading);
            let total_ms = ms(started);
            let mut first: Vec<(&String, &u32)> = ranks.iter().flatten().collect();
            first.sort_by_key(|(_, r)| **r);
            first.truncate(3);
            println!("desktop view found in {found_ms:.2} ms; folder: {folder:?}");
            println!(
                "the view counts {items} items; read_view_order: {} names in {read_ms:.2} ms \
                 ({total_ms:.2} ms in all)",
                ranks
                    .as_ref()
                    .map_or_else(|| "None".to_owned(), |r| r.len().to_string()),
            );
            println!(
                "first in view order: {:?}",
                first.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>()
            );
            assert!(
                folder.is_some(),
                "the desktop view's folder did not resolve"
            );
            if items > 0 {
                let ranks = ranks.expect("the desktop's items did not read back");
                assert!(
                    !ranks.is_empty() && ranks.len() <= items as usize,
                    "{} names for {items} items",
                    ranks.len()
                );
            }
        }
    }
}
