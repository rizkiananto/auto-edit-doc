// Run:  npx tsx --env-file=.env test.ts
//
// Part 1 (offline): parser tests. Always run, need no credentials.
// Part 2 (online):  runs messages against a Google Doc and checks the result.
//   Needs TEST_DOC_ID in .env = a COPY of the original quotation doc,
//   shared with the service account as Editor. NEVER use the real doc.
//   The script restores the doc to its starting state when it finishes.
import assert from "node:assert/strict";

type Snap = {
  rows: string[][];
  items: { no: string; name: string; qty: string; price: string; total: string }[];
  grand: string;
  paras: string[];
};

async function main() {
  process.env.BOT_TOKEN ??= "test-token"; // bot.ts needs a token to load; unused here
  const b = await import("./bot");

  let passed = 0;
  let failed = 0;
  const run = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (e: any) {
      failed++;
      console.log(`  ❌ ${name}\n     ${String(e.message).split("\n").join("\n     ")}`);
    }
  };

  // ------------------------------------------------------------------ offline
  console.log("\nParser tests (offline)");

  await run("one-line input with messy case/spacing splits into fields", () => {
    assert.deepEqual(b.parse("no: Q1, TO : Budi , Company : PT X").fields, [
      ["no", "Q1"], ["to", "Budi"], ["company", "PT X"],
    ]);
  });
  await run("comma inside a value is kept", () => {
    assert.deepEqual(b.parse("Price Terms : Nett, Franco site Bogor").fields, [
      ["price terms", "Nett, Franco site Bogor"],
    ]);
  });
  await run("date line is recognised", () => {
    assert.equal(b.parse("Jakarta, 10 April 2026").date, "Jakarta, 10 April 2026");
  });
  await run("bare item name + Price; Total is flagged but ignored", () => {
    const p = b.parse("Pasir Galunggung 02\nPrice : 560.000\nTotal : 560.000");
    assert.deepEqual(p.items, [{ name: "Pasir Galunggung 02", price: "560.000" }]);
    assert.equal(p.totalGiven, true);
  });
  await run("Tambah / Hapus", () => {
    const p = b.parse("Tambah : X\nPrice : 1\nHapus : Y");
    assert.deepEqual(p.items, [{ name: "X", add: true, price: "1" }]);
    assert.deepEqual(p.deletes, ["Y"]);
  });
  await run('header "Yg diganti :" is ignored', () => {
    const p = b.parse("Yg diganti :\n\nNo : Q0115");
    assert.deepEqual(p.fields, [["no", "Q0115"]]);
    assert.equal(p.items.length, 0);
  });
  await run("plain chat / unknown labels are not recognised", () => {
    assert.equal(b.parse("halo tolong ubah ya").recognized, false);
    assert.equal(b.parse("Alamat : Jl. Merdeka").recognized, false);
  });
  await run("qty normalisation", () => {
    for (const [i, o] of [["2m3", "2m³"], ["2M3", "2m³"], ["2 m3", "2m³"], ["2", "2m³"], ["1.5m3", "1.5m³"], ["1m³", "1m³"]])
      assert.equal(b.normQty(i), o, `normQty(${i})`);
  });
  await run("units and quantity parsing", () => {
    for (const [i, o] of [["10pcs", "10pcs"], ["10 pcs", "10 pcs"], ["2 m2", "2 m2"], ["1.000", "1.000m³"]])
      assert.equal(b.normQty(i), o, `normQty(${i})`);
    for (const [i, o] of [["2m³", 2], ["10 pcs", 10], ["1,5m³", 1.5], ["1.5", 1.5], ["0.500", 0.5], ["1.000 pcs", 1000], ["1.000,5", 1000.5], ["", 0]] as const)
      assert.equal(b.qtyNum(i), o, `qtyNum(${i})`);
  });

  await run("price validation", () => {
    for (const ok of ["480.000", "Rp 480.000", "Rp. 480.000,-"]) assert.equal(b.validPrice(ok), true, ok);
    for (const bad of ["480rb", "abc", "0", ""]) assert.equal(b.validPrice(bad), false, bad);
    assert.equal(b.num("Rp 480.000"), 480000);
  });

  // ------------------------------------------------------------------- online
  const testDoc = process.env.TEST_DOC_ID;
  if (!testDoc) {
    console.log("\nTEST_DOC_ID not set → skipping Google Docs tests.");
    return summary();
  }
  if (testDoc === process.env.DOC_ID) {
    console.log("\nTEST_DOC_ID equals DOC_ID. Refusing to run tests on the real doc.");
    process.exit(1);
  }
  b.setDocId(testDoc);

  const snapshot = async (): Promise<Snap> => {
    const doc = await b.getDoc();
    const rows = b.itemsTable(doc).map((r: any) => r.tableCells.map(b.cellText));
    const paras = (doc.body!.content as any[])
      .filter((c) => c.paragraph)
      .map((c) => b.paraText(c.paragraph).replace(/\n$/, "").trim())
      .filter(Boolean);
    return {
      rows,
      items: rows.slice(1, -1).map((r: string[]) => ({ no: r[0], name: r[1], qty: r[2], price: r[3], total: r[4] })),
      grand: rows[rows.length - 1][4],
      paras,
    };
  };
  const field = (s: Snap, label: string) =>
    s.paras.find((p) => new RegExp(`^${label}\\s*:`, "i").test(p))?.replace(/^[^:]*:\s*/, "");
  const dateLine = (s: Snap) =>
    s.paras.map((p) => p.match(/^[A-Za-zÀ-ÿ .]+,\s*\d{1,2}\s+[A-Za-z]+\s+\d{4}/)?.[0]).find(Boolean);

  const FIELD_LABELS = ["No", "From", "To", "Company", "Phone", "Email", "Your Reff", "Payment Terms", "Delivery Terms", "Price"];

  console.log("\nGoogle Docs tests (online)");
  const init = await snapshot();
  const startOk =
    init.items.length === 2 &&
    init.items[0].name === "Pasir Galunggung 02" && init.items[0].price === "570.000" &&
    init.items[1].name === "Batu Splir" && init.items[1].price === "450.000";
  if (!startOk) {
    console.log(
      "  Test doc is not in the expected starting state (Pasir Galunggung 02 @ 570.000, Batu Splir @ 450.000).\n" +
      "  Make a fresh copy of the original quotation and update TEST_DOC_ID."
    );
    process.exit(1);
  }

  type R = { reply: string; before: Snap; after: Snap };
  const change = (name: string, msg: string, check: (r: R) => void) =>
    run(name, async () => {
      const before = await snapshot();
      const reply = await b.applyMessage(msg);
      const after = await snapshot();
      check({ reply, before, after });
    });
  const rejected = (name: string, msg: string, mustContain: string) =>
    change(name, msg, (r) => {
      assert.ok(r.reply.includes(mustContain), `reply should contain "${mustContain}", got:\n${r.reply}`);
      assert.deepEqual(r.after, r.before, "doc should NOT have changed");
    });

  try {
    console.log(" Valid inputs (cumulative, in order)");

    await change("1. single field, lowercase label + auto date", "to: Budi Santoso", (r) => {
      assert.equal(field(r.after, "To"), "Budi Santoso");
      assert.equal(dateLine(r.after), b.todayLine());
    });

    await change("2. several fields on one line, messy case", "no: Q0231, TO : budi , Company : PT Maju Jaya, phone: 08123456789", (r) => {
      assert.equal(field(r.after, "No"), "Q0231");
      assert.equal(field(r.after, "To"), "budi");
      assert.equal(field(r.after, "Company"), "PT Maju Jaya");
      assert.equal(field(r.after, "Phone"), "08123456789");
    });

    await change("3. item price via partial name + 'Rp' prefix", "splir\nPrice : Rp 480.000", (r) => {
      assert.equal(r.after.items[1].price, "480.000");
      assert.equal(r.after.items[1].total, "480.000");
      assert.equal(r.after.grand, "1.050.000");
    });

    await change("4. qty (2m3 → 2m³) + price together", "Pasir Galunggung\nQty : 2m3\nPrice : 560.000", (r) => {
      assert.equal(r.after.items[0].qty, "2m³");
      assert.equal(r.after.items[0].price, "560.000");
      assert.equal(r.after.items[0].total, "1.120.000");
      assert.equal(r.after.grand, "1.600.000");
    });

    await change("5. add item (Tambah), qty 2M3", "Tambah : Batu Kali\nQty : 2M3\nPrice : 400.000", (r) => {
      assert.equal(r.after.items.length, 3);
      assert.deepEqual(r.after.items[2], { no: "3.", name: "Batu Kali", qty: "2m³", price: "400.000", total: "800.000" });
      assert.equal(r.after.rows.at(-1)![1], "Total", "new row must sit above the Total row");
      assert.equal(r.after.grand, "2.400.000");
    });

    await change("6. delete item (Hapus) + renumbering", "Hapus : Batu Splir", (r) => {
      assert.deepEqual(r.after.items.map((i) => [i.no, i.name]), [["1.", "Pasir Galunggung 02"], ["2.", "Batu Kali"]]);
      assert.equal(r.after.grand, "1.920.000");
    });

    await change("7. terms lines (comma inside value kept)", "Payment Terms : 14 days after sign, Delivery Terms : 3 hari setelah PO, Price Terms : Nett, Franco site Bogor", (r) => {
      assert.equal(field(r.after, "Payment Terms"), "14 days after sign");
      assert.equal(field(r.after, "Delivery Terms"), "3 hari setelah PO");
      assert.equal(field(r.after, "Price"), "Nett, Franco site Bogor");
    });

    await change(
      "8. WhatsApp-style combo with own date",
      "Yg diganti :\n\nTo : Budi Santoso\nCompany : PT Maju Jaya\nHapus : Batu Kali\nTambah : Pasir Super\nPrice : 620.000\n\nJakarta, 20 Desember 2026",
      (r) => {
        assert.equal(field(r.after, "To"), "Budi Santoso");
        assert.equal(field(r.after, "Company"), "PT Maju Jaya");
        assert.deepEqual(r.after.items.map((i) => [i.no, i.name, i.qty, i.price]), [
          ["1.", "Pasir Galunggung 02", "2m³", "560.000"],
          ["2.", "Pasir Super", "1m³", "620.000"],
        ]);
        assert.equal(r.after.grand, "1.740.000");
        assert.equal(dateLine(r.after), "Jakarta, 20 Desember 2026", "own date must win over auto date");
      }
    );

    console.log(" Wrong inputs (doc must stay unchanged)");

    await rejected("9. price without item name, 2 items", "Harga : 665.000", "tanpa nama item");
    await rejected("10. new item without Tambah", "Batu Kali\nPrice : 400.000", "Tambah : Batu Kali");
    await rejected("11. Tambah without price", "Tambah : Batu Kali", "harga belum disebut");
    await rejected("12. invalid price (480rb)", "Pasir Super\nPrice : 480rb", "tidak valid");
    await rejected("13. invalid qty (banyak)", "Pasir Super\nQty : banyak", "tidak valid");
    await rejected("14. delete non-existent item", "Hapus : Semen", "tidak ditemukan");
    await rejected("15. delete every item", "Hapus : Pasir Galunggung\nHapus : Pasir Super", "minimal sisakan satu");
    await rejected("16. ambiguous item name", "Pasir\nPrice : 500.000", "lebih dari satu");

    await change("17. good line + unknown line → partial success", "To : Budi Baru\nAlamat : Jl. Merdeka", (r) => {
      assert.equal(field(r.after, "To"), "Budi Baru");
      assert.ok(r.reply.includes("Gagal"), `reply should list a failure, got:\n${r.reply}`);
    });
  } finally {
    // put the test doc back to its starting state so the script can be re-run
    try {
      const cur = await snapshot();
      const baseNames = init.items.map((i) => i.name.toLowerCase());
      const lines: string[] = [];
      for (const it of cur.items) if (!baseNames.includes(it.name.toLowerCase())) lines.push(`Hapus : ${it.name}`);
      for (const base of init.items) {
        const present = cur.items.some((i) => i.name.toLowerCase() === base.name.toLowerCase());
        lines.push(present ? base.name : `Tambah : ${base.name}`, `Qty : ${base.qty}`, `Price : ${base.price}`);
      }
      for (const label of FIELD_LABELS) {
        const v = field(init, label);
        if (v !== undefined) lines.push(`${label === "Price" ? "Price Terms" : label} : ${v}`);
      }
      const d = dateLine(init);
      if (d) lines.push(d);
      await b.applyMessage(lines.join("\n"));
      console.log("\n  (test doc restored to its starting state)");
    } catch (e: any) {
      console.log(`\n  ⚠️ Could not restore the test doc (${e.message}). Make a fresh copy before the next run.`);
    }
  }

  summary();

  function summary() {
    console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});