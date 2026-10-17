#!/usr/bin/env node
// Generates the PDF test documents into tests/fixtures/pdf/ (gitignored).
// Called by make-fixtures.mjs; runnable on its own:
//
//   node scripts/make-pdf-fixtures.mjs
//
// Built with pdf-lib (the app's own export writer) plus a few hand-written
// objects where pdf-lib has no API (a JPEG 2000 image, a markup annotation,
// encryption). The scanned page needs the ffmpeg sidecar for its JPX stream.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFBool, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ffmpeg = path.join(root, "src-tauri", "binaries", "ffmpeg-x86_64-pc-windows-msvc.exe");
const outDir = path.join(root, "tests", "fixtures", "pdf");
fs.mkdirSync(outDir, { recursive: true });

const A4 = [595.28, 841.89];
const LOREM =
  "The quick brown fox jumps over the lazy dog. Taroting reads this page so the search, " +
  "the text layer and the copy path have real words to find.";

async function make(name, build) {
  const target = path.join(outDir, name);
  if (fs.existsSync(target)) {
    console.log(`skip   pdf/${name}`);
    return;
  }
  console.log(`create pdf/${name}`);
  const bytes = await build();
  fs.writeFileSync(target + ".part", bytes);
  fs.renameSync(target + ".part", target);
}

function textPage(doc, font, n, total, extra = "") {
  const page = doc.addPage(A4);
  page.drawText(`Page ${n} of ${total}`, { x: 60, y: 770, size: 24, font });
  const words = `${LOREM} ${extra}`.split(" ");
  let line = "";
  let y = 730;
  for (const w of words) {
    if ((line + " " + w).length > 80) {
      page.drawText(line, { x: 60, y, size: 12, font });
      y -= 18;
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) page.drawText(line, { x: 60, y, size: 12, font });
  return page;
}

/* plain: 3 text pages; "needle" appears once on page 2 for the search test */
await make("plain_3p.pdf", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) textPage(doc, font, i, 3, i === 2 ? "needle" : "");
  return doc.save();
});

/* large: 300 pages, for render/memory budgets */
await make("large_300p.pdf", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 300; i++) {
    const p = textPage(doc, font, i, 300);
    p.drawRectangle({ x: 60, y: 120, width: 475, height: 300, color: rgb((i % 7) / 7, 0.4, 0.7) });
  }
  return doc.save();
});

/* form: text, checkbox, radio group, dropdown (AcroForm) */
async function acroFormDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  const form = doc.getForm();
  page.drawText("Name", { x: 60, y: 760, size: 12, font });
  form.createTextField("name").addToPage(page, { x: 160, y: 750, width: 300, height: 22 });
  page.drawText("Agree", { x: 60, y: 710, size: 12, font });
  form.createCheckBox("agree").addToPage(page, { x: 160, y: 705, width: 16, height: 16 });
  page.drawText("Size", { x: 60, y: 660, size: 12, font });
  const radio = form.createRadioGroup("size");
  radio.addOptionToPage("small", page, { x: 160, y: 655, width: 16, height: 16 });
  radio.addOptionToPage("large", page, { x: 200, y: 655, width: 16, height: 16 });
  page.drawText("Colour", { x: 60, y: 610, size: 12, font });
  const dd = form.createDropdown("colour");
  dd.addOptions(["Red", "Green", "Blue"]);
  dd.addToPage(page, { x: 160, y: 600, width: 150, height: 22 });
  return doc;
}
await make("form_acro.pdf", async () => (await acroFormDoc()).save());

/* need_appearances: values filled in by another app that wrote NO appearance
   streams and set /NeedAppearances true (the viewer is to draw them): a text
   field "name" = "Filled elsewhere", a multi-line "notes" = "Line one" /
   "Line two", a dropdown "colour" = "Green" */
await make("need_appearances.pdf", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  const form = doc.getForm();
  page.drawText("Name", { x: 60, y: 760, size: 12, font });
  const name = form.createTextField("name");
  name.setText("Filled elsewhere");
  name.addToPage(page, { x: 160, y: 750, width: 300, height: 22 });
  page.drawText("Notes", { x: 60, y: 710, size: 12, font });
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.setText("Line one\nLine two");
  notes.addToPage(page, { x: 160, y: 650, width: 300, height: 70 });
  page.drawText("Colour", { x: 60, y: 610, size: 12, font });
  const dd = form.createDropdown("colour");
  dd.addOptions(["Red", "Green", "Blue"]);
  dd.select("Green");
  dd.addToPage(page, { x: 160, y: 600, width: 150, height: 22 });
  for (const f of form.getFields()) {
    for (const w of f.acroField.getWidgets()) w.dict.delete(PDFName.of("AP"));
  }
  form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  return doc.save({ updateFieldAppearances: false });
});

/* form_text_kinds: empty fields of every layout a value can need, for the
   export's own field appearances (src/pdf/export/fields.ts):
   "notes"  multi-line, auto size (DA size 0)
   "fixed"  one line, 14 pt blue, right-aligned (Q 2)
   "auto"   one line, auto size (DA size 0)
   "code"   comb of 6 cells
   "turned" one line turned 90 (/MK /R 90): a tall box read bottom to top
   "pick"   list box: Red / אדום / Синий */
await make("form_text_kinds.pdf", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(A4);
  const form = doc.getForm();
  const da = (field, s) => field.acroField.dict.set(PDFName.of("DA"), PDFString.of(s));
  const label = (t, y) => page.drawText(t, { x: 60, y, size: 12, font });
  label("Notes", 760);
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.addToPage(page, { x: 160, y: 700, width: 300, height: 70 });
  da(notes, "0 g /Helv 0 Tf");
  label("Fixed", 660);
  const fixed = form.createTextField("fixed");
  fixed.addToPage(page, { x: 160, y: 650, width: 300, height: 24 });
  da(fixed, "0 0 1 rg /Helv 14 Tf");
  fixed.acroField.dict.set(PDFName.of("Q"), doc.context.obj(2));
  label("Auto", 610);
  const auto = form.createTextField("auto");
  auto.addToPage(page, { x: 160, y: 600, width: 300, height: 30 });
  da(auto, "0 g /Helv 0 Tf");
  label("Code", 560);
  const code = form.createTextField("code");
  code.setMaxLength(6);
  code.enableCombing();
  code.addToPage(page, { x: 160, y: 550, width: 180, height: 24 });
  da(code, "0 g /Helv 12 Tf");
  label("Turned", 500);
  const turned = form.createTextField("turned");
  turned.addToPage(page, { x: 180, y: 360, width: 140, height: 24, rotate: degrees(90) });
  da(turned, "0 g /Helv 12 Tf");
  label("Pick", 340);
  const pick = form.createOptionList("pick");
  pick.addToPage(page, { x: 160, y: 270, width: 150, height: 60 });
  da(pick, "0 g /Helv 12 Tf");
  // set after addToPage: pdf-lib would try to draw the options in Helvetica
  pick.acroField.dict.set(
    PDFName.of("Opt"),
    doc.context.obj(["Red", "אדום", "Синий"].map((t) => PDFHexString.fromText(t))),
  );
  return doc.save({ updateFieldAppearances: false });
});

/* rotated: page 2 carries /Rotate 90 */
await make("rotated.pdf", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) textPage(doc, font, i, 3);
  doc.getPage(1).setRotation(degrees(90));
  return doc.save();
});

/* annotated: an existing yellow Square markup annotation from "another app" */
await make("annotated.pdf", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = textPage(doc, font, 1, 1);
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Square",
    Rect: [60, 500, 260, 600],
    C: [1, 0.8, 0],
    Border: [0, 0, 3],
    T: PDFString.of("Someone else"),
    Contents: PDFString.of("An existing annotation"),
  });
  page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
  return doc.save();
});

/* hebrew: Hebrew + English text with an embedded system font (search + RTL) */
await make("hebrew.pdf", async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync("C:\\Windows\\Fonts\\arial.ttf"), { subset: true });
  const page = doc.addPage(A4);
  // pdf-lib lays glyphs out left to right with no bidi pass, so the Hebrew
  // word is written in VISUAL order (reversed) to read correctly, as a real
  // RTL-aware producer would have placed it.
  page.drawText("Hello / " + [..."שלום"].reverse().join(""), { x: 60, y: 760, size: 24, font });
  return doc.save();
});

/* scanned: one full-page JPEG 2000 image (JPXDecode) - pdf.js decodes it with
   WebAssembly or its JS fallback; this is the CSP question's evidence */
await make("scanned_jpx.pdf", async () => {
  const jp2 = path.join(outDir, "scan.jp2.part");
  execFileSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=1240x1754:duration=1",
    "-frames:v", "1", "-c:v", "jpeg2000", "-pix_fmt", "rgb24", "-f", "image2", jp2,
  ]);
  const data = fs.readFileSync(jp2);
  fs.unlinkSync(jp2);
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const stream = doc.context.stream(data, {
    Type: "XObject",
    Subtype: "Image",
    Width: 1240,
    Height: 1754,
    Filter: "JPXDecode",
  });
  const ref = doc.context.register(stream);
  page.node.setXObject(PDFName.of("Im0"), ref);
  const ops = `q ${A4[0]} 0 0 ${A4[1]} 0 0 cm /Im0 Do Q`;
  const content = doc.context.stream(ops);
  page.node.set(PDFName.of("Contents"), doc.context.register(content));
  return doc.save();
});

/* corrupt: the plain document cut in half (no xref, no trailer) */
await make("corrupt.pdf", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  textPage(doc, font, 1, 1);
  const bytes = await doc.save();
  return bytes.slice(0, Math.floor(bytes.length / 2));
});

/* -------- RC4 R3 encryption for the encrypted fixture -------- */

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const PAD = Buffer.from(
  "28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const md5 = (...parts) => {
  const h = crypto.createHash("md5");
  for (const p of parts) h.update(p);
  return h.digest();
};
const padPw = (pw) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);

async function encryptRc4(plainBytes, userPw) {
  // Re-load and encrypt every string and stream in place, then add /Encrypt.
  const doc = await PDFDocument.load(plainBytes);
  const ctx = doc.context;
  const id = crypto.randomBytes(16);
  const P = -3904; // print + copy allowed, nothing else
  const ownerPw = padPw("owner-" + userPw);
  let okey = md5(ownerPw);
  for (let i = 0; i < 50; i++) okey = md5(okey);
  let O = rc4(okey, padPw(userPw));
  for (let i = 1; i <= 19; i++) O = rc4(okey.map((b) => b ^ i), O);
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  let key = md5(padPw(userPw), Buffer.from(O), pBytes, id);
  for (let i = 0; i < 50; i++) key = md5(key);
  let U = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) U = rc4(key.map((b) => b ^ i), U);
  U = Buffer.concat([Buffer.from(U), Buffer.alloc(16)]);

  const objKey = (num, gen) => {
    const k = md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, 0]));
    return k.subarray(0, Math.min(16, key.length + 5));
  };
  const { PDFRawStream, PDFDict, PDFArray, PDFHexString } = await import("pdf-lib");
  const encObj = (obj, k) => {
    if (obj instanceof PDFString || obj instanceof PDFHexString) {
      return PDFHexString.of(Buffer.from(rc4(k, obj.asBytes())).toString("hex"));
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) obj.set(i, encObj(obj.get(i), k));
      return obj;
    }
    if (obj instanceof PDFDict) {
      for (const [name, v] of obj.entries()) obj.set(name, encObj(v, k));
      return obj;
    }
    return obj;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const k = objKey(ref.objectNumber, ref.generationNumber);
    if (obj instanceof PDFRawStream) {
      encObj(obj.dict, k);
      const enc = rc4(k, obj.contents);
      ctx.assign(ref, PDFRawStream.of(obj.dict, enc));
    } else {
      encObj(obj, k);
    }
  }
  const encrypt = ctx.obj({
    Filter: "Standard", V: 2, R: 3, Length: 128, P,
    O: PDFHexString.of(Buffer.from(O).toString("hex")),
    U: PDFHexString.of(U.toString("hex")),
  });
  ctx.trailerInfo.Encrypt = ctx.register(encrypt);
  ctx.trailerInfo.ID = ctx.obj([
    PDFHexString.of(id.toString("hex")), PDFHexString.of(id.toString("hex")),
  ]);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/* encrypted: user password "taroting" (standard security handler, RC4 128-bit,
   R3) - hand-rolled because pdf-lib cannot encrypt */
await make("encrypted.pdf", async () => encryptRc4(await (async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  textPage(doc, font, 1, 1, "secret");
  return doc.save({ useObjectStreams: false });
})(), "taroting"));

/* owner-only: encrypted with an EMPTY user password, so it opens without one
   while its permissions stay locked (the common "protected" PDF) - the export
   must still write a plain file from it */
await make("owner_only.pdf", async () => encryptRc4(await (async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) textPage(doc, font, i, 3);
  doc.setTitle("Owner only");
  return doc.save({ useObjectStreams: false });
})(), ""));

/* owner-only form: the form_acro document behind an empty user password */
await make("owner_form.pdf", async () =>
  encryptRc4(await (await acroFormDoc()).save({ useObjectStreams: false }), ""));

/* edit_text: one page per kind of page text that "Edit text" removes at
   export (src/pdf/export/redact.ts), with the expected geometry written beside
   it as edit_text.json (computed HERE from the font data written into the
   file, never from the app's code):
     0  standard-14 Helvetica without /Widths, a crop box not at the origin, a
        scaling + translating cm, Tc 0.5, Tz 90, then ' and " lines
     1  an embedded TrueType font, WinAnsi, /Widths
     2  a Type0 / Identity-H font (pdf-lib's own embedding of a subset)
     3  text inside a Form XObject (not rewritten: a cover instead)
     4  a TJ-kerned line
   Per page: `rect` = the edited word's box in page space (PDF points of the
   unrotated page, origin the crop box's top-left, y down), `gone` = that word,
   `keep` = whole lines that must come out untouched, `head` / `tail` = the
   text before / after the word on its line and where its first glyph must
   stay (user space). */
const EDIT_JSON = path.join(outDir, "edit_text.json");
if (!fs.existsSync(EDIT_JSON) && fs.existsSync(path.join(outDir, "edit_text.pdf"))) {
  fs.unlinkSync(path.join(outDir, "edit_text.pdf")); // the pair is made together
}
await make("edit_text.pdf", async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvW = (ch) => helv.widthOfTextAtSize(ch, 1000);
  /** advance of `s` in text space */
  const adv = (s, w, tfs, tc = 0, tw = 0, th = 1) => {
    let x = 0;
    for (const ch of s) x += ((w(ch) / 1000) * tfs + tc + (ch === " " ? tw : 0)) * th;
    return x;
  };
  const info = [];
  const content = (page, ops) => page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream(ops)));
  const fontRes = (page, fonts) => page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: fonts }));
  const helvRef = doc.context.register(
    doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }),
  );

  /* 0: Helvetica, crop box, cm, Tc, Tz */
  {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of("CropBox"), doc.context.obj([30, 40, 590, 780]));
    const crop = { x: 30, top: 780 };
    const [S, E, F] = [1.5, 20, -30];
    const tfs = 12, tc = 0.5, th = 0.9, tl = 14;
    fontRes(page, { F1: helvRef });
    content(
      page,
      `q ${S} 0 0 ${S} ${E} ${F} cm BT /F1 ${tfs} Tf ${tc} Tc 90 Tz ${tl} TL 1 0 0 1 40 400 Tm ` +
        `(Keep this REMOVE that) Tj (Another line stays) ' 3 0.2 (Third via quote) " ET Q`,
    );
    const x0 = adv("Keep this ", helvW, tfs, tc, 0, th);
    const x1 = x0 + adv("REMOVE", helvW, tfs, tc, 0, th);
    const ux = (tx) => S * (40 + tx) + E;
    const uy = S * 400 + F;
    const size = S * tfs;
    info.push({
      name: "helvetica",
      rect: [ux(x0) - crop.x, crop.top - (uy + 0.8 * size), ux(x1) - ux(x0), size],
      gone: "REMOVE",
      keep: ["Another line stays", "Third via quote"],
      head: { str: "Keep this", x: ux(0), y: uy },
      tail: { str: "that", x: ux(adv("Keep this REMOVE ", helvW, tfs, tc, 0, th)), y: uy },
    });
  }

  /* 1: an embedded TrueType font, WinAnsi, /Widths */
  {
    const ttf = fs.readFileSync("C:\\Windows\\Fonts\\arial.ttf");
    const face = fontkit.create(ttf);
    const upm = face.unitsPerEm;
    const widths = [];
    for (let c = 32; c <= 126; c++) widths.push(Math.round((face.glyphForCodePoint(c).advanceWidth * 1000) / upm));
    const w = (ch) => widths[ch.charCodeAt(0) - 32];
    const file = doc.context.register(doc.context.flateStream(ttf, { Length1: ttf.length }));
    const fd = doc.context.register(
      doc.context.obj({
        Type: "FontDescriptor",
        FontName: "ArialEmbedded",
        Flags: 32,
        FontBBox: [-665, -325, 2000, 1040],
        ItalicAngle: 0,
        Ascent: 905,
        Descent: -212,
        CapHeight: 716,
        StemV: 80,
        FontFile2: file,
      }),
    );
    const font = doc.context.register(
      doc.context.obj({
        Type: "Font",
        Subtype: "TrueType",
        BaseFont: "ArialEmbedded",
        FirstChar: 32,
        LastChar: 126,
        Widths: widths,
        Encoding: "WinAnsiEncoding",
        FontDescriptor: fd,
      }),
    );
    const page = doc.addPage([612, 792]);
    fontRes(page, { TT: font });
    content(page, "BT /TT 16 Tf 1 0 0 1 72 600 Tm (Alpha Beta Gamma) Tj 0 -24 Td (Second line here) Tj ET");
    const x0 = 72 + adv("Alpha ", w, 16);
    const x1 = x0 + adv("Beta", w, 16);
    info.push({
      name: "truetype",
      rect: [x0, 792 - (600 + 0.8 * 16), x1 - x0, 16],
      gone: "Beta",
      keep: ["Second line here"],
      head: { str: "Alpha", x: 72, y: 600 },
      tail: { str: "Gamma", x: 72 + adv("Alpha Beta ", w, 16), y: 600 },
    });
  }

  /* 2: Type0 / Identity-H */
  const type0Page = doc.getPageCount();
  {
    const font = await doc.embedFont(fs.readFileSync("C:\\Windows\\Fonts\\arial.ttf"), { subset: true });
    const page = doc.addPage([612, 792]);
    page.drawText("Hello World Again", { x: 72, y: 500, size: 18, font });
    page.drawText("Line two of type zero", { x: 72, y: 470, size: 18, font });
    info.push({ name: "type0", gone: "World", keep: ["Line two of type zero"] }); // geometry after saving
  }

  /* 3: text inside a Form XObject */
  {
    const page = doc.addPage([612, 792]);
    const form = doc.context.register(
      doc.context.stream("BT /F1 14 Tf 1 0 0 1 4 8 Tm (Inside form) Tj ET", {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, 200, 30],
        Resources: { Font: { F1: helvRef } },
      }),
    );
    page.node.set(PDFName.of("Resources"), doc.context.obj({ Font: { F1: helvRef }, XObject: { Fm1: form } }));
    content(page, "q 1 0 0 1 100 300 cm /Fm1 Do Q BT /F1 14 Tf 1 0 0 1 100 250 Tm (Outside text) Tj ET");
    const x0 = 104;
    const x1 = x0 + adv("Inside form", helvW, 14);
    info.push({
      name: "xobject",
      rect: [x0, 792 - (308 + 0.8 * 14), x1 - x0, 14],
      gone: "Inside form",
      keep: ["Outside text"],
      formText: true,
    });
  }

  /* 4: a TJ-kerned line */
  {
    const page = doc.addPage([612, 792]);
    fontRes(page, { F1: helvRef });
    content(page, "BT /F1 14 Tf 1 0 0 1 72 400 Tm [(Ke) -120 (rned) 50 (REMOVE) -200 (tail end)] TJ 0 -20 Td (Kept below) Tj ET");
    const k = (n) => (-n / 1000) * 14;
    const x0 = 72 + adv("Kerned", helvW, 14) + k(-120) + k(50);
    const x1 = x0 + adv("REMOVE", helvW, 14);
    info.push({
      name: "kerned",
      rect: [x0, 792 - (400 + 0.8 * 14), x1 - x0, 14],
      gone: "REMOVE",
      keep: ["Kept below"],
      head: { str: "Ke", x: 72, y: 400 },
      tail: { str: "tail end", x: x1 + k(-200), y: 400 },
    });
  }

  const bytes = await doc.save({ useObjectStreams: false });

  // the Type0 page's geometry, from the W array and glyph codes pdf-lib wrote
  {
    const { PDFArray, PDFDict, decodePDFRawStream } = await import("pdf-lib");
    const back = await PDFDocument.load(bytes);
    const page = back.getPage(type0Page);
    const fonts = page.node.Resources().lookup(PDFName.of("Font"), PDFDict);
    const f = fonts.lookup(fonts.keys()[0], PDFDict);
    const cid = f.lookup(PDFName.of("DescendantFonts"), PDFArray).lookup(0, PDFDict);
    const W = cid.lookup(PDFName.of("W"), PDFArray);
    const dw = cid.lookup(PDFName.of("DW"))?.asNumber() ?? 1000;
    const widths = new Map();
    for (let i = 0; i < W.size(); ) {
      const first = W.lookup(i).asNumber();
      const next = W.lookup(i + 1);
      if (next instanceof PDFArray) {
        for (let j = 0; j < next.size(); j++) widths.set(first + j, next.lookup(j).asNumber());
        i += 2;
      } else {
        for (let c = first; c <= next.asNumber(); c++) widths.set(c, W.lookup(i + 2).asNumber());
        i += 3;
      }
    }
    const cs = page.node.Contents();
    const raw = cs instanceof PDFArray ? back.context.lookup(cs.get(0)) : cs;
    const text = new TextDecoder("latin1").decode(decodePDFRawStream(raw).decode());
    const hex = /<([0-9A-F]+)> Tj/.exec(text)[1];
    const codes = [];
    for (let i = 0; i < hex.length; i += 4) codes.push(parseInt(hex.slice(i, i + 4), 16));
    const at = (n) => codes.slice(0, n).reduce((x, c) => x + ((widths.get(c) ?? dw) / 1000) * 18, 72);
    // "Hello World Again": World = characters 6..10, Again from 12
    const x0 = at(6);
    const x1 = at(11);
    Object.assign(info[type0Page], {
      rect: [x0, 792 - (500 + 0.8 * 18), x1 - x0, 18],
      head: { str: "Hello", x: 72, y: 500 },
      tail: { str: "Again", x: at(12), y: 500 },
    });
  }
  fs.writeFileSync(EDIT_JSON, JSON.stringify({ pages: info }, null, 2));
  return bytes;
});
