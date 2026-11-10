# auto-edit-doc

A Telegram bot that edits a Google Docs quotation (penawaran) from chat messages. Paste a WhatsApp-style change message or follow the guided `edit` flow, and the bot updates the doc, recalculates totals, and can send you the result as a PDF.

## Features

- Edit header fields: No, From, To, Company, Phone, Email, Your Reff, Payment/Delivery/Price terms
- Add, delete and edit line items (name, qty, price); totals are recalculated automatically
- Date line auto-updates to today (Asia/Jakarta); disable with `AUTO_DATE=off`
- `/pdf` exports the current doc as PDF
- Access limited to an allowlist of Telegram user IDs
- Bot messages and field aliases are in Indonesian and English (e.g. `kepada`, `hapus`, `tambah`)

## Requirements

- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A Google Cloud service account with the Docs and Drive APIs enabled
- A Google Doc quotation, shared with the service account's email as **Editor**

## Setup

```bash
git clone <your-repo-url> auto-edit-doc
cd auto-edit-doc
npm install
cp .env.example .env        # then fill in the values
```

Put your service account key at `./service-account.json`. Both `.env` and `service-account.json` are git-ignored; never commit them.

| Variable      | Description                                       |
| ------------- | ------------------------------------------------- |
| `BOT_TOKEN`   | Telegram bot token                                |
| `DOC_ID`      | Google Doc ID (from the doc URL)                  |
| `ALLOWED_IDS` | Comma-separated Telegram user IDs allowed to use it |
| `AUTO_DATE`   | Optional. `off` disables the auto date line       |

## Getting the credentials

**`BOT_TOKEN`**
1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and username. BotFather replies with the token.

**`ALLOWED_IDS`**
1. Message [@userinfobot](https://t.me/userinfobot) in Telegram. It replies with your numeric ID.
2. Put it in `.env`. For several people, separate IDs with commas: `ALLOWED_IDS=123456789,987654321`.

**`DOC_ID`**
1. Open your quotation in Google Docs. The URL looks like `https://docs.google.com/document/d/<DOC_ID>/edit`.
2. Copy the part between `/d/` and `/edit`.
3. The doc should have header lines like `To : ...`, `Company : ...`, a date line like `Jakarta, 22 Mei 2026`, and an items table with a header row, one row per item (No, Name, Qty, Price, Total) and a final total row.

**`service-account.json`**
1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create (or pick) a project.
2. Under **APIs & Services → Library**, enable the **Google Docs API** and the **Google Drive API**.
3. Under **IAM & Admin → Service Accounts**, create a service account (no roles needed).
4. Open it, go to **Keys → Add key → Create new key → JSON**, and save the downloaded file as `service-account.json` in the project root.
5. Open the JSON, copy the `client_email` value, and share your Google Doc with that address as **Editor**.

**`TEST_DOC_ID`** (optional, tests only)
1. In Google Docs, use **File → Make a copy** on the quotation.
2. Share the copy with the same `client_email` as Editor.
3. Take its ID from the URL and set it as `TEST_DOC_ID` in `.env`.

## Customising for your own doc

The labels and layout the bot looks for live in `config.json`, not in the code. Edit it to match your document:

| Key           | What it controls |
| ------------- | ---------------- |
| `fields`      | Header lines in the doc, e.g. `To : ...`. `label` is the text in your doc; `aliases` are extra words people can type. The key itself (e.g. `to`) always works too. Add, remove or rename entries freely. |
| `commands`    | Words for add / delete / price / qty / total (e.g. `tambah`, `hapus`). |
| `table`       | 0-based column positions in the items table: `no`, `name`, `qty`, `price`, `total`. |
| `columnWords` | Words that pick a column in the guided `edit` flow. |
| `date`        | City, timezone and month names for the auto date line (`Jakarta, 22 Mei 2026`). |
| `locale`      | Number format for prices (`id-ID` gives `480.000`). |

**Tip:** you can give `config.json` and the text of your doc to any AI assistant and ask it to adjust the config to match your doc's labels and table layout. Remove or replace private details (names, phone numbers, prices) before pasting.

Use `CONFIG_PATH=/path/to/file.json` to load a different file. The bot's reply text (Indonesian) is still in `bot.ts`.

## Run

```bash
npx tsx --env-file=.env bot.ts
```

## Usage

Send the bot a message such as:

```
To : Budi Santoso
Company : PT Maju Jaya

Pasir Galunggung 02
Price : 560.000

Tambah : Batu Kali
Qty : 2m³
Price : 400.000

Hapus : Batu Splir
```

Or send `edit` for a step-by-step flow. Commands: `/start`, `/pdf`, `/batal` (cancel).

## Tests

```bash
npx tsx --env-file=.env test.ts
```

Parser tests run offline. The online tests need `TEST_DOC_ID` set to a **copy** of the quotation doc shared with the service account. Never point it at a real doc.

## Deploy on a VPS

Run it under a process manager, for example systemd (`/etc/systemd/system/auto-edit-doc.service`):

```ini
[Unit]
Description=auto-edit-doc Telegram bot
After=network-online.target

[Service]
WorkingDirectory=/opt/auto-edit-doc
ExecStart=/usr/bin/npx tsx --env-file=.env bot.ts
Restart=always
User=bot

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now auto-edit-doc
journalctl -u auto-edit-doc -f
```

The bot uses long polling, so no open ports or domain are needed. Copy `.env` and `service-account.json` to the server with `scp`, and set `chmod 600` on both.

## Security notes

- Only user IDs in `ALLOWED_IDS` get a response; everyone else is ignored.
- If a token or key is ever exposed, revoke it (BotFather `/revoke`, delete the service account key in Google Cloud) and create a new one.

## License

MIT
