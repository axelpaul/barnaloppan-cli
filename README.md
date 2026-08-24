# Barnaloppan CLI

Public Bun CLI for Barnaloppan booth inventory. The site has no public
API; this uses its ordinary login form and the authenticated browser flow.
Only the session cookie is stored, at
`~/.config/barnaloppan/session.json` with mode `0600`.

## Install

Put a launcher on your PATH that runs the working tree, so source edits take
effect with no rebuild:

```bash
cat > ~/.local/bin/barnaloppan <<EOF
#!/bin/sh
exec bun "$PWD/src/index.ts" "\$@"
EOF
chmod 755 ~/.local/bin/barnaloppan
```

Or build a standalone binary that does not depend on the repo staying put,
at the cost of rebuilding after every change:

```bash
bun run build && mv barnaloppan ~/.local/bin/
```

## Usage

```bash
barnaloppan auth login                     # env, else prompts
barnaloppan auth login --from-env           # require BARNALOPPAN_EMAIL/PASSWORD
barnaloppan auth login --from-1password
barnaloppan auth status --check             # is the stored session still live?
barnaloppan list --json
barnaloppan add clothes.csv        # dry run
barnaloppan add clothes.csv --yes  # uploads photos and creates listings
barnaloppan hide 12345678 --yes    # hide from search, keeps the listing
barnaloppan show 12345678 --yes    # put it back in search
barnaloppan delete 12345678        # dry run
barnaloppan delete 12345678 --yes  # permanently removes it
```

## Sales

```bash
barnaloppan sales
```

Reads the payout view and reports each sale with its timestamp, plus the
totals:

```json
{
  "count": 6,
  "sales": [
    { "name": "Ergopouch svefnpok 68-92", "soldAt": "24.8.2026, 13:18",
      "soldAtIso": "2026-08-24T13:18", "amount": 5000, "online": false }
  ],
  "soldTotal": 14000,
  "commission": 2800,
  "commissionRate": "20%",
  "paidOut": 0,
  "balance": 11200,
  "rowSum": 14000
}
```

`commission` is the amount deducted, given as a positive number; `balance` is
what the site shows as *Inneign*. `rowSum` adds up the individual rows, and a
`warning` field appears if it disagrees with the site's own total — the endpoint
returns an HTML table rather than JSON, so that mismatch is the tripwire for the
markup having changed. Amounts are parsed from Icelandic formatting, where
`5.000 kr.` is five thousand. `soldAtIso` is local booth time with no timezone
implied.

Sales rows carry no product ID, and names can repeat, so they cannot be mapped
to listings reliably. Use `list` for that instead: it reports `"sold": true` and
`"status": "completed"` on the listings that sold, with their IDs.

## Credentials

`auth login` resolves credentials in this order: `--from-1password`, then
`--password-stdin`, then the environment, then an interactive prompt. The
`credentialSource` field in the output says which one was used.

For the environment, set `BARNALOPPAN_EMAIL` and `BARNALOPPAN_PASSWORD`. Any
of these work:

- a real exported variable
- `./.env` — auto-loaded by Bun, but **only when you run the CLI from this
  directory**
- `~/.config/barnaloppan/.env` — works from anywhere, so prefer this one

Copy `.env.example` to get started, and keep the file to yourself:

```bash
cp .env.example ~/.config/barnaloppan/.env
chmod 600 ~/.config/barnaloppan/.env
```

Set per field, an exported variable beats the file. `.env` is gitignored; the
CLI warns if the file is readable by other users. Use `--from-env` in scripts
to fail loudly instead of blocking on a prompt when nothing is set.

With no credentials available anywhere, `auth login` prompts for them.
The password is never echoed and is not written to disk; only the resulting
session cookie is stored. Pass `--email you@example.com` to skip the first
prompt. For scripts, pipe the password in on stdin:

```bash
printf '%s' "$BARNALOPPAN_PASSWORD" |
  barnaloppan auth login --email you@example.com --password-stdin
```

`--password <value>` is rejected on purpose: the value would be saved in your
shell history and visible to every other process on the machine.

## Sessions

You log in once. `login` exchanges your credentials for a session cookie and
stores only that cookie; every later command reuses it and never re-sends your
password. Credentials are read just-in-time during `login` and are never
written to disk by the CLI.

Re-run `login` only when the site expires the cookie, which surfaces as
`Barnaloppan session expired`. To check first:

```bash
barnaloppan auth status          # what is stored, no network call
barnaloppan auth status --check  # ask the site if the cookie still works
```

`--check` reports `"live": true` or `false` and exits non-zero when the
session is dead, so a script can test it before a batch upload.

`auth login --from-1password` reads a local 1Password item just-in-time and
never stores the password. The default item is `Barnaloppan`; override it with
`BARNALOPPAN_1PASSWORD_ITEM` and optionally
`BARNALOPPAN_1PASSWORD_VAULT`. The CLI normally discovers the active booth;
pass `--booking-id` only if discovery fails.

CSV format (the optional `photo` is a local JPEG/PNG):

```csv
name,price,active,photo
Blue fleece,1200,true,/path/to/blue-fleece.jpg
Rain trousers,900,true,/path/to/rain-trousers.png
```

Column names accept aliases, so an export with `Title,Price,Image` works
as-is. Headers are matched case-insensitively:

| Meaning | Accepted headers |
| --- | --- |
| name | `name`, `title` |
| price | `price` |
| active | `active` |
| photo | `photo`, `image`, `filename`, `file` |

A photo may be given with or without its extension, and relative to either the
current directory or the CSV's own directory:

```csv
title,price,image
Blue fleece,1200,IMG_0729
```

`IMG_0729` is resolved against `.jpg`, `.jpeg`, and `.png` in the current
directory first, then beside the CSV. The current directory wins when both
match, and the error lists what was tried when nothing does.

Photos keep their EXIF orientation: the site applies the tag and re-encodes to
portrait 768x1024, so a phone photo stored landscape with `Orientation=6`
still comes out upright. A photo that is *genuinely* landscape gets rotated
sideways by the site, so crop those to portrait first.

Names are limited to 24 characters because the site enforces that limit.
When `photo` is present, `add --yes` uploads it first and then includes the
returned image path in the product-save call. Dry runs validate the file and
show the full proposed batch without uploading or creating anything.

## Changing a listing after it is live

Once the price tags are printed the site locks a listing: it renders name and
price as plain text instead of inputs, and shows a padlock. That lock is
enforced server-side, and it is enforced *silently* — a save carrying a new
name or price is answered `{"status":"success"}` and then discarded.

A photo is not on the printed tag, so it can be replaced at any time:

```bash
barnaloppan set-image updates.csv        # dry run
barnaloppan set-image updates.csv --yes  # replaces the photos
```

`updates.csv` is `id,photo`. Listings are addressed by ID rather than name
because names repeat. Each listing's current `active` and `webshop` state is
read and sent back unchanged, so replacing a photo cannot un-hide anything.

Name and price *are* on the tag, so they need the tag marked unprinted first:

```bash
barnaloppan unprint 12345678 --yes   # or by name / photo
barnaloppan edit updates.csv --yes   # id + name and/or price
```

`edit`'s CSV is `id` plus a `name` column, a `price` column, or both. Name and
price are always sent together, using the listing's current value for whichever
is not changing, so a partial edit cannot blank a field. `edit` refuses a
listing whose tag is still printed rather than reporting a change the site threw
away, and it reads the booth back afterwards to confirm what actually landed.

**`unprint` cannot be undone from this CLI.** Marking a tag printed again means
printing it from the site, which drives a physical label printer. The tag
carries the name and price, so a sticker already on a garment will be wrong
until it is reprinted.

## Hiding listings

`hide` and `show` toggle what the site calls *søgning*: a hidden listing stays
in the booth, keeps its ID and price tag, and is only removed from search. This
is the magnifying-glass column in the booth view, and it is fully reversible —
unlike `delete`.

`hide` and `show` accept a product ID, a product name, or a photo name:

```bash
barnaloppan hide 12345678 --yes             # by ID
barnaloppan hide "Ikea leikslá" --yes       # by exact name
barnaloppan hide svefnpoki --all --yes      # by partial name, every match
barnaloppan hide IMG_0407 --yes             # by photo name
barnaloppan hide IMG_0407 "Ikea leikslá" 12345678 --yes   # mixed
```

A name is matched case-insensitively: exact first, then as a substring. A
selector that matches more than one listing is **refused** unless you pass
`--all`, and the error lists every match, so a broad word can never quietly
hide more than you meant. Without `--yes` you get a dry run naming each
resolved listing and which selector found it.

### The photo index

The site renames every upload to `<product_id>.jpg` and keeps no record of the
original filename, so photo names resolve through a local index — `inventory.csv`
in the current directory by default, or `--index <file>`. Build it as you upload:

```bash
barnaloppan add products.csv --yes --index inventory.csv
```

That **merges** into any existing index rather than replacing it, skipping IDs
already listed, so later batches keep the earlier mappings. Columns are
`position,id,name,price,photo,active`; any CSV with `id` and `photo` columns
works. Without an index, IDs and names still work.

`list` reports `"active": true | false` and `"status"`, so hidden listings are
easy to find (`status` is `pending` while a tag is unprinted, `active` once it
has been printed):

```bash
barnaloppan list | jq '.[] | select(.active == false)'
```

The site refuses to hide a product that is in the webshop; remove it from the
webshop first.

`delete` is permanent and accepts only explicit product IDs. It always starts
as a dry run; use `--yes` only after checking the target IDs with `list`.
