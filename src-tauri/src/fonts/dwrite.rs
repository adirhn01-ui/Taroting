//! Which fonts are installed on this PC, through DirectWrite's system font
//! collection (it carries the per-user installs too on current Windows).
//!
//! DirectWrite is asked only WHAT exists and what it is called: the en-us
//! Win32 family and subfamily names (the four-face RIBBI model the app's
//! Bold/Italic toggles map onto), the file and the face index. Everything
//! about the face itself (style bits, weight, metrics, fsType) is read from the
//! file by `sfnt.rs`, the same reader library fonts go through. Every COM
//! object is dropped before this returns; nothing DirectWrite is held.
//!
//! The shared factory needs no `CoInitialize` and is safe from any thread.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;

use windows::core::{w, Interface, BOOL};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteFont, IDWriteFont3, IDWriteFontCollection, IDWriteFontFile,
    IDWriteLocalFontFileLoader, IDWriteLocalizedStrings, DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_SIMULATIONS_NONE,
    DWRITE_INFORMATIONAL_STRING_ID, DWRITE_INFORMATIONAL_STRING_WIN32_FAMILY_NAMES,
    DWRITE_INFORMATIONAL_STRING_WIN32_SUBFAMILY_NAMES,
};

/// One installed face as DirectWrite lists it.
#[derive(Debug, Clone)]
pub struct ListedFace {
    pub family: String,
    pub style: String,
    pub path: PathBuf,
    pub index: u32,
}

/// Every non-simulated installed face that lives in a local file.
/// `check_updates` asks DirectWrite to look again for fonts installed since.
pub fn list_installed(check_updates: bool) -> windows::core::Result<Vec<ListedFace>> {
    let factory: IDWriteFactory = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }?;
    let mut coll: Option<IDWriteFontCollection> = None;
    unsafe { factory.GetSystemFontCollection(&mut coll, check_updates) }?;
    let Some(coll) = coll else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for f in 0..unsafe { coll.GetFontFamilyCount() } {
        let Ok(family) = (unsafe { coll.GetFontFamily(f) }) else { continue };
        for i in 0..unsafe { family.GetFontCount() } {
            let Ok(font) = (unsafe { family.GetFont(i) }) else { continue };
            if let Some(face) = listed(&font) {
                out.push(face);
            }
        }
    }
    Ok(out)
}

fn listed(font: &IDWriteFont) -> Option<ListedFace> {
    // A simulated (faux bold / oblique) face is not a real face.
    if unsafe { font.GetSimulations() } != DWRITE_FONT_SIMULATIONS_NONE {
        return None;
    }
    let family = info_string(font, DWRITE_INFORMATIONAL_STRING_WIN32_FAMILY_NAMES)?;
    let style = info_string(font, DWRITE_INFORMATIONAL_STRING_WIN32_SUBFAMILY_NAMES).unwrap_or_default();
    // The face REFERENCE names the file and the index without opening the
    // font: `CreateFontFace` parses every file and was four fifths of the
    // enumeration. Whether the file is a font this app can use is decided by
    // `sfnt.rs` when it reads it (a bitmap or Type 1 font does not parse).
    let reference = unsafe { font.cast::<IDWriteFont3>().ok()?.GetFontFaceReference() }.ok()?;
    let path = local_path(&unsafe { reference.GetFontFile() }.ok()?)?;
    Some(ListedFace { family, style, path, index: unsafe { reference.GetFontFaceIndex() } })
}

/// The file behind a font file reference, when it is a plain local file (a
/// downloadable or in-memory font has another loader and is skipped).
fn local_path(file: &IDWriteFontFile) -> Option<PathBuf> {
    let loader: IDWriteLocalFontFileLoader = unsafe { file.GetLoader() }.ok()?.cast().ok()?;
    let mut key: *mut core::ffi::c_void = core::ptr::null_mut();
    let mut size = 0u32;
    unsafe { file.GetReferenceKey(&mut key, &mut size) }.ok()?;
    let len = unsafe { loader.GetFilePathLengthFromKey(key, size) }.ok()?;
    let mut buf = vec![0u16; usize::try_from(len).ok()?.checked_add(1)?];
    unsafe { loader.GetFilePathFromKey(key, size, &mut buf) }.ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(PathBuf::from(OsString::from_wide(&buf[..end])))
}

/// The en-us string of an informational string set, else its first string.
fn info_string(font: &IDWriteFont, id: DWRITE_INFORMATIONAL_STRING_ID) -> Option<String> {
    let mut strings: Option<IDWriteLocalizedStrings> = None;
    let mut exists = BOOL(0);
    unsafe { font.GetInformationalStrings(id, &mut strings, &mut exists) }.ok()?;
    let strings = strings.filter(|_| exists.as_bool())?;
    let mut index = 0u32;
    let mut found = BOOL(0);
    if unsafe { strings.FindLocaleName(w!("en-us"), &mut index, &mut found) }.is_err() || !found.as_bool() {
        index = 0;
    }
    if index >= unsafe { strings.GetCount() } {
        return None;
    }
    let len = unsafe { strings.GetStringLength(index) }.ok()?;
    let mut buf = vec![0u16; usize::try_from(len).ok()?.checked_add(1)?];
    unsafe { strings.GetString(index, &mut buf) }.ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}
