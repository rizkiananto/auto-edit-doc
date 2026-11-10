// npm i grammy googleapis && npm i -D tsx typescript @types/node
// Run: npx tsx --env-file=.env bot.ts
// env: BOT_TOKEN, DOC_ID, ALLOWED_IDS (comma-separated Telegram user ids)
import { Bot, InputFile } from "grammy";
import { google } from "googleapis";
import { readFileSync } from "node:fs";

const bot = new Bot(process.env.BOT_TOKEN!);
let DOC_ID = process.env.DOC_ID!;
const setDocId = (id: string) => { DOC_ID = id; }; // used by test.ts
const ALLOWED = (process.env.ALLOWED_IDS ?? "").split(",").map(Number);

const auth = new google.auth.GoogleAuth({
  keyFile: "service-account.json",
  scopes: [
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/drive",
  ],
});
const docs = google.docs({ version: "v1", auth });
const drive = google.drive({ version: "v3", auth });

// ---------- vocabulary (loaded from config.json) ----------
// Edit config.json to match your own doc labels, words and table layout.
// Set CONFIG_PATH to use a different file.
const cfg = JSON.parse(readFileSync(process.env.CONFIG_PATH ?? "config.json", "utf8"));
for (const k of ["fields", "commands", "table", "columnWords", "date", "unit", "locale"])
  if (!(k in cfg)) throw new Error(`config.json: missing "${k}"`);

// canonical field -> label as written in the doc
const LABELS: Record<string, string> = Object.fromEntries(
  Object.entries<any>(cfg.fields).map(([k, v]) => [k, v.label])
);

// words people may type -> canonical name (a field's own key always counts)
const ALIASES: Record<string, string> = {};
for (const [k, v] of Object.entries<any>(cfg.fields))
  for (const w of [k, ...v.aliases]) ALIASES[w.toLowerCase()] = k;
for (const [k, words] of Object.entries<string[]>(cfg.commands))
  for (const w of words) ALIASES[w.toLowerCase()] = k;

// table column positions (0-based) and the words that pick a column in the guided flow
const T: Record<string, number> = cfg.table;
const COLUMNS: Record<string, number> = {};
for (const [col, words] of Object.entries<string[]>(cfg.columnWords))
  for (const w of words) COLUMNS[w.toLowerCase()] = T[col];

// e.g. "Jakarta, 22 Mei 2026"
const DATE_RE = /^[A-Za-zÀ-ÿ .]+,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}$/;

type Edit = { start: number; end: number; text: string };

// Auto-set the date line to today on every change (set AUTO_DATE=off to disable).
// If the user sends their own date line, theirs wins.
const AUTO_DATE = process.env.AUTO_DATE !== "off";
const MONTHS: string[] = cfg.date.months;
function todayLine() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: cfg.date.timezone,
    day: "2-digit",
    month: "numeric",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${cfg.date.city}, ${get("day")} ${MONTHS[+get("month") - 1]} ${get("year")}`;
}

// Unit handling comes from config.json ("unit"):
//   bare "2" -> "2" + default unit; "2 m3" -> "2m³" via aliases; "10pcs", "2 m2" stay as typed.
const UNIT_DEFAULT: string = cfg.unit.default;
const UNIT_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries<string>(cfg.unit.aliases).map(([k, v]) => [k.toLowerCase(), v])
);
function normQty(s: string) {
  const t = s.trim();
  const m = t.match(/^(\d+(?:[.,]\d+)*)\s*(.*)$/);
  if (!m) return t;
  if (!m[2]) return m[1] + UNIT_DEFAULT;
  const alias = UNIT_ALIASES[m[2].toLowerCase().replace(/[\s^]/g, "")];
  return alias ? m[1] + alias : t;
}

// ---------- doc helpers ----------
const paraText = (p: any) =>
  (p.elements ?? []).map((e: any) => e.textRun?.content ?? "").join("");

const cellText = (cell: any) =>
  cell.content.map((c: any) => (c.paragraph ? paraText(c.paragraph) : "")).join("").trim();

const cellRange = (cell: any) => {
  const p = cell.content[0];
  return { start: p.startIndex as number, end: (p.endIndex as number) - 1 };
};

const getDoc = async () => (await docs.documents.get({ documentId: DOC_ID })).data;
const itemsTable = (doc: any) =>
  doc.body.content.find((c: any) => c.table).table.tableRows as any[];
// skip header row (0) and total row (last)
const itemRows = (doc: any) =>
  itemsTable(doc)
    .slice(1, -1)
    .map((r, i) => ({ row: i + 1, name: cellText(r.tableCells[T.name]) }));

// Highest index first so earlier indexes stay valid.
// Insert first, then delete old text, so new text inherits formatting.
async function applyEdits(edits: Edit[]) {
  const requests: any[] = [];
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    requests.push({ insertText: { location: { index: e.start }, text: e.text } });
    if (e.end > e.start)
      requests.push({
        deleteContentRange: {
          range: { startIndex: e.start + e.text.length, endIndex: e.end + e.text.length },
        },
      });
  }
  if (requests.length)
    await docs.documents.batchUpdate({ documentId: DOC_ID, requestBody: { requests } });
}

const num = (s: string) =>
  parseFloat(s.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")) || 0; // "Rp 480.000" -> 480000
// accepts "480.000", "Rp 480.000", "Rp. 480.000,-"; rejects "480rb", "abc", "0"
const validPrice = (s: string) =>
  /\d/.test(s) && !/[a-z]/i.test(s.replace(/^\s*rp\.?\s*/i, "")) && num(s) > 0;
// "2" -> 2, "1,5" -> 1.5, "1.5" -> 1.5, "1.000" -> 1000 (dot + exactly 3 digits = thousands, like prices)
const qtyNum = (s: string) => {
  const t = s.match(/^\s*(\d+(?:[.,]\d+)*)/)?.[1] ?? "0";
  const n = /^[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(t) ? t.replace(/\./g, "") : t;
  return parseFloat(n.replace(",", ".")) || 0;
};
const idr = (n: number) => n.toLocaleString(cfg.locale);

async function recalc() {
  const rows = itemsTable(await getDoc());
  const edits: Edit[] = [];
  let grand = 0;
  rows.slice(1, -1).forEach((r, i) => {
    const total = qtyNum(cellText(r.tableCells[T.qty])) * num(cellText(r.tableCells[T.price]));
    grand += total;
    edits.push({ ...cellRange(r.tableCells[T.total]), text: idr(total) });
    edits.push({ ...cellRange(r.tableCells[T.no]), text: `${i + 1}.` }); // renumber
  });
  edits.push({ ...cellRange(rows[rows.length - 1].tableCells[T.total]), text: idr(grand) });
  await applyEdits(edits);
}

// "Label : value" paragraph -> edit of the value part
function fieldEdit(doc: any, canon: string, value: string): Edit | null {
  const label = LABELS[canon].replace(/ /g, "\\s+");
  const re = new RegExp(`^\\s*(?:\\d+[.)]\\s*)?${label}\\s*:\\s*`, "i");
  for (const c of doc.body.content) {
    if (!c.paragraph) continue;
    const m = paraText(c.paragraph).match(re);
    if (m) return { start: c.startIndex + m[0].length, end: c.endIndex - 1, text: value };
  }
  return null;
}

// "Jakarta, 22 Mei 2026" paragraph -> replace the whole line
function dateEdit(doc: any, value: string): Edit | null {
  // Match at the start of the paragraph only, in case "Sincerely yours,"
  // shares the same paragraph via a soft line break.
  const re = /^(\s*)([A-Za-zÀ-ÿ .]+,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4})/;
  for (const c of doc.body.content) {
    if (!c.paragraph) continue;
    const m = paraText(c.paragraph).match(re);
    if (m) {
      const start = c.startIndex + m[1].length;
      return { start, end: start + m[2].length, text: value };
    }
  }
  return null;
}

// ---------- message parser (no LLM) ----------
type Item = { name?: string; price?: string; qty?: string; add?: boolean };

// Lets one-line input like "no: Q1, to: Adi, company: PT X" work:
// a comma/semicolon followed by a known label and ":" starts a new line.
const LABEL_ALT = Object.keys(ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/ /g, "\\s+"))
  .join("|");
const INLINE_SPLIT = new RegExp(`\\s*[,;]\\s*(?=(?:${LABEL_ALT})\\s*:)`, "gi");

function parse(text: string) {
  const fields: [string, string][] = [];
  const items: Item[] = [];
  const deletes: string[] = [];
  let date: string | undefined;
  let totalGiven = false;
  let cur: Item | undefined;

  for (const raw of text.replace(INLINE_SPLIT, "\n").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (DATE_RE.test(line)) { date = line; continue; }

    const i = line.indexOf(":");
    if (i >= 0) {
      const label = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      const canon = ALIASES[label];
      if (canon && value) {
        if (canon === "price" || canon === "qty") {
          if (!cur) { cur = {}; items.push(cur); }
          cur[canon] = value;
        } else if (canon === "add") {
          cur = { name: value, add: true };
          items.push(cur);
        } else if (canon === "delete") deletes.push(value);
        else if (canon === "total") totalGiven = true; // computed automatically
        else fields.push([canon, value]);
        continue;
      }
      if (!value) continue; // header like "Yg diganti :"
    }
    cur = { name: line }; // bare line = item name
    items.push(cur);
  }

  const recognized =
    fields.length > 0 ||
    !!date ||
    deletes.length > 0 ||
    items.some((i) => i.price || i.qty || i.add);
  return { fields, items, deletes, date, totalGiven, recognized };
}

const tableOf = (doc: any) => doc.body.content.find((c: any) => c.table);

async function deleteRows(rowIdx: number[]) {
  const t = tableOf(await getDoc());
  const requests = [...rowIdx]
    .sort((a, b) => b - a) // bottom first so indexes stay valid
    .map((r) => ({
      deleteTableRow: {
        tableCellLocation: {
          tableStartLocation: { index: t.startIndex },
          rowIndex: r,
          columnIndex: 0,
        },
      },
    }));
  await docs.documents.batchUpdate({ documentId: DOC_ID, requestBody: { requests } });
}

async function addRows(adds: { name: string; price: string; qty?: string }[]) {
  // 1) insert empty rows right above the Total row (below the last item row)
  const t = tableOf(await getDoc());
  const last = t.table.tableRows.length - 2; // last item row index
  const requests = adds.map((_, i) => ({
    insertTableRow: {
      tableCellLocation: {
        tableStartLocation: { index: t.startIndex },
        rowIndex: last + i,
        columnIndex: 0,
      },
      insertBelow: true,
    },
  }));
  await docs.documents.batchUpdate({ documentId: DOC_ID, requestBody: { requests } });

  // 2) fill the new rows (fresh indexes); number + totals are filled by recalc()
  const rows = itemsTable(await getDoc());
  const edits: Edit[] = adds.flatMap((a, i) => {
    const cells = rows[last + 1 + i].tableCells;
    return [
      { ...cellRange(cells[T.name]), text: a.name },
      { ...cellRange(cells[T.qty]), text: a.qty ?? `1${UNIT_DEFAULT}` },
      { ...cellRange(cells[T.price]), text: idr(num(a.price)) },
    ];
  });
  await applyEdits(edits);
}

async function applyMessage(text: string): Promise<string> {
  const p = parse(text);
  const doc = await getDoc();
  const edits: Edit[] = [];
  const ok: string[] = [];
  const fail: string[] = [];
  let needRecalc = false;

  for (const [canon, value] of p.fields) {
    const e = fieldEdit(doc, canon, value);
    if (e) { edits.push(e); ok.push(`${LABELS[canon]} → ${value}`); }
    else fail.push(`Baris "${LABELS[canon]}" tidak ditemukan di dokumen`);
  }

  if (p.date) {
    const e = dateEdit(doc, p.date);
    if (e) { edits.push(e); ok.push(`Tanggal → ${p.date}`); }
    else fail.push("Baris tanggal tidak ditemukan di dokumen");
  }

  const rows = itemRows(doc);
  const adds: { name: string; price: string; qty?: string }[] = [];
  const delRows: number[] = [];
  const delNames: string[] = [];

  for (const name of p.deletes) {
    const m = rows.filter((r) => r.name.toLowerCase().includes(name.toLowerCase()));
    if (m.length === 1) { delRows.push(m[0].row); delNames.push(m[0].name); }
    else fail.push(m.length ? `Hapus "${name}": cocok dengan lebih dari satu item` : `Hapus "${name}": item tidak ditemukan`);
  }
  let doDelete = delRows.length > 0;
  if (doDelete && delRows.length >= rows.length && !p.items.some((i) => i.add)) {
    fail.push("Tidak bisa menghapus semua item sekaligus (minimal sisakan satu)");
    doDelete = false;
  }
  if (doDelete) delNames.forEach((n) => ok.push(`Hapus: ${n}`));

  for (const it of p.items) {
    if (it.add) {
      if (!it.price) fail.push(`Tambah "${it.name}": harga belum disebut`);
      else if (!validPrice(it.price)) fail.push(`Tambah "${it.name}": harga "${it.price}" tidak valid`);
      else if (it.qty && !/^\d/.test(it.qty.trim())) fail.push(`Tambah "${it.name}": qty "${it.qty}" tidak valid`);
      else {
        const q = it.qty ? normQty(it.qty) : undefined;
        adds.push({ name: it.name!, price: it.price, qty: q });
        ok.push(`Tambah: ${it.name} (${q ?? `1${UNIT_DEFAULT}`}, ${idr(num(it.price))})`);
      }
      continue;
    }
    if (!it.price && !it.qty) {
      if (it.name) fail.push(`"${it.name}": harga/qty baru belum disebut`);
      continue;
    }
    let target: { row: number; name: string } | undefined;
    if (it.name) {
      const m = rows.filter((r) => r.name.toLowerCase().includes(it.name!.toLowerCase()));
      if (m.length !== 1) {
        fail.push(m.length ? `"${it.name}" cocok dengan lebih dari satu item` : `Item "${it.name}" tidak ditemukan. Kalau item baru, tulis: Tambah : ${it.name}`);
        continue;
      }
      target = m[0];
    } else if (rows.length === 1) target = rows[0];
    else {
      fail.push("Harga/qty tanpa nama item. Tulis nama item di baris sebelum harga.");
      continue;
    }
    const cells = itemsTable(doc)[target.row].tableCells;
    if (it.price && !validPrice(it.price)) {
      fail.push(`${target.name}: harga "${it.price}" tidak valid`);
    } else if (it.price) {
      edits.push({ ...cellRange(cells[T.price]), text: idr(num(it.price)) });
      ok.push(`${target.name}: harga → ${idr(num(it.price))}`);
    }
    if (it.qty && !/^\d/.test(it.qty.trim())) {
      fail.push(`${target.name}: qty "${it.qty}" tidak valid`);
    } else if (it.qty) {
      const q = normQty(it.qty);
      edits.push({ ...cellRange(cells[T.qty]), text: q });
      ok.push(`${target.name}: qty → ${q}`);
    }
    needRecalc = true;
  }

  if (!p.date && AUTO_DATE && (edits.length || adds.length || doDelete)) {
    const line = todayLine();
    const e = dateEdit(doc, line);
    if (e) { edits.push(e); ok.push(`Tanggal otomatis → ${line}`); }
  }

  await applyEdits(edits); // fields, date, existing items (same snapshot)
  if (doDelete) await deleteRows(delRows);
  if (adds.length) await addRows(adds);
  if (needRecalc || adds.length || doDelete) await recalc(); // totals + renumber

  let reply = "";
  if (ok.length) reply += "✅ Sudah diubah:\n" + ok.map((s) => `• ${s}`).join("\n");
  if (needRecalc || p.totalGiven) reply += "\n(Total dihitung ulang otomatis)";
  if (fail.length) reply += `\n\n⚠️ Gagal:\n` + fail.map((s) => `• ${s}`).join("\n");
  if (ok.length) reply += "\n\nKetik /pdf untuk ambil PDF-nya.";
  return reply.trim();
}

// ---------- interactive flow ("edit") ----------
type State =
  | { step: "target" }
  | { step: "field_value"; canon: string }
  | { step: "item_column"; row: number; name: string }
  | { step: "item_value"; row: number; col: number; label: string };
const state = new Map<number, State>();

bot.use(async (ctx, next) => {
  if (!ALLOWED.includes(ctx.from?.id ?? 0)) return; // abaikan orang asing
  await next();
});

bot.command(["batal", "cancel"], (ctx) => {
  state.delete(ctx.chat.id);
  return ctx.reply("Dibatalkan.");
});

bot.command("pdf", async (ctx) => {
  const res = await drive.files.export(
    { fileId: DOC_ID, mimeType: "application/pdf" },
    { responseType: "arraybuffer" }
  );
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(res.data as ArrayBuffer), "penawaran.pdf")
  );
});

// Built from config.json, so it stays correct when labels/words are customised.
function helpText() {
  const fields = Object.entries<any>(cfg.fields)
    .map(([k, v]) => `• ${v.label} — ketik: ${[k, ...v.aliases].join(", ")}`)
    .join("\n");
  const first = (c: string) => cfg.commands[c].join(" / ");
  return (
    "Yang bisa diedit\n\n" +
    "Data dokumen (tulis \"kata : isi\", boleh beberapa baris atau dipisah koma):\n" + fields + "\n\n" +
    "Item:\n" +
    `• ${first("add")} : nama item — item baru (wajib ${first("price")}, ${first("qty")} opsional)\n` +
    `• ${first("delete")} : nama item — hapus item\n` +
    `• nama item, lalu ${first("price")} : ... dan/atau ${first("qty")} : ... — ubah item yang ada\n` +
    `• ${first("total")} dihitung otomatis\n\n` +
    `Satuan: angka saja jadi 2${UNIT_DEFAULT}; satuan lain (mis. 10pcs) ditulis apa adanya dan tetap dihitung.\n` +
    `Tanggal: tulis seperti "${todayLine()}"` + (AUTO_DATE ? " (kalau tidak ditulis, otomatis hari ini)" : "") + ".\n\n" +
    "Perintah: edit (mode tanya-jawab), /pdf, /batal, /start"
  );
}

bot.command("help", (ctx) => ctx.reply(helpText()));

bot.command("start", (ctx) =>
  ctx.reply(
    'Halo! Ketik "edit" untuk mulai, atau langsung tempel pesan perubahan, contoh:\n\n' +
    "To : Budi Santoso\nCompany : PT Maju Jaya\n\nPasir Galunggung 02\nPrice : 500.000\n\nJakarta, 10 April 2026\n\n" +
    "Item baru:\nTambah : Batu Kali\nQty : 2m³\nPrice : 300.000\n\nHapus item:\nHapus : Batu Splir\n\n" +
    "/pdf untuk ambil PDF, /batal untuk membatalkan, /help untuk daftar yang bisa diedit."
  )
);

bot.on("message:text", async (ctx) => {
  const id = ctx.chat.id;
  const text = ctx.message.text.trim();
  const s = state.get(id);
  const isMultiOrPaste = /\n|:/.test(text);

  if (/^\/?edit$/i.test(text)) {
    state.set(id, { step: "target" });
    return ctx.reply("Mau edit apa? (contoh: to, company, phone, atau nama item)");
  }

  // Pasted WhatsApp-style message: apply directly
  if (isMultiOrPaste && parse(text).recognized) {
    state.delete(id);
    return ctx.reply(await applyMessage(text));
  }

  if (!s) return ctx.reply('Ketik "edit" untuk mulai, atau tempel pesan perubahan. /pdf untuk ambil PDF.');

  if (s.step === "target") {
    const canon = ALIASES[text.toLowerCase()];
    if (canon && LABELS[canon]) {
      state.set(id, { step: "field_value", canon });
      return ctx.reply(`${LABELS[canon]} diganti jadi apa?`);
    }
    const matches = itemRows(await getDoc()).filter((r) =>
      r.name.toLowerCase().includes(text.toLowerCase())
    );
    if (matches.length === 0) return ctx.reply(`"${text}" tidak ditemukan. Coba lagi atau /batal.`);
    if (matches.length > 1)
      return ctx.reply("Ada beberapa yang cocok, tulis lebih spesifik:\n" + matches.map((m) => `• ${m.name}`).join("\n"));
    state.set(id, { step: "item_column", row: matches[0].row, name: matches[0].name });
    return ctx.reply(`Edit "${matches[0].name}". Bagian mana? nama / qty / harga`);
  }

  if (s.step === "item_column") {
    const col = COLUMNS[text.toLowerCase()];
    if (!col) return ctx.reply("Balas dengan: nama, qty, atau harga");
    state.set(id, { step: "item_value", row: s.row, col, label: text.toLowerCase() });
    const hint = col === T.qty ? ` (contoh: 2${UNIT_DEFAULT})` : col === T.price ? " (contoh: 500.000)" : "";
    return ctx.reply(`${text.toLowerCase()} barunya?${hint}`);
  }

  if (s.step === "field_value") {
    state.delete(id);
    return ctx.reply(await applyMessage(`${LABELS[s.canon]} : ${text}`));
  }

  if (s.step === "item_value") {
    if (s.col === T.price && !validPrice(text))
      return ctx.reply('Harga tidak valid, contoh: 500.000. Coba lagi atau /batal.');
    if (s.col === T.qty && !/^\d/.test(text))
      return ctx.reply(`Qty tidak valid, contoh: 2${UNIT_DEFAULT}. Coba lagi atau /batal.`);
    state.delete(id);
    const doc = await getDoc();
    const cell = itemsTable(doc)[s.row].tableCells[s.col];
    const value = s.col === T.price ? idr(num(text)) : s.col === T.qty ? normQty(text) : text;
    const edits: Edit[] = [{ ...cellRange(cell), text: value }];
    if (AUTO_DATE) {
      const d = dateEdit(doc, todayLine());
      if (d) edits.push(d);
    }
    await applyEdits(edits);
    if (s.col === T.qty || s.col === T.price) await recalc();
    return ctx.reply("✅ Selesai, total dihitung ulang. Ketik /pdf untuk ambil PDF-nya.");
  }
});

bot.on("message:photo", (ctx) =>
  ctx.reply("Gambar belum didukung. Ketik/tempel isi perubahannya sebagai teks dulu ya.")
);

// Only start polling when run directly (npx tsx bot.ts), not when imported by test.ts
if (/(^|[\\/])bot\.(ts|js)$/.test(process.argv[1] ?? "")) bot.start();

export { parse, normQty, qtyNum, helpText, validPrice, num, todayLine, applyMessage, getDoc, itemsTable, cellText, paraText, setDocId };